import { Mutex } from 'async-mutex';
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import type { Workspace } from './workspace.js';

/** Global limits for an ephemeral workspace store. */
export interface WorkspaceStoreConfiguration {
    /** Maximum bytes across every live workspace. */
    maxTotalBytes: number;
    /** Maximum bytes allowed in one workspace. */
    maxBytesPerWorkspace: number;
    /** Maximum number of live workspaces. */
    maxWorkspaces: number;
    /** Maximum files across every live workspace. Defaults to maxWorkspaces * maxFilesPerWorkspace. */
    maxFiles?: number;
    /** Maximum files allowed in one workspace. Defaults to 1024. */
    maxFilesPerWorkspace?: number;
}

type ResolvedStoreConfiguration = Required<WorkspaceStoreConfiguration>;

/** Byte and file counts for one workspace. */
export interface WorkspaceUsage {
    /** Total size of regular files in bytes. */
    bytes: number;
    /** Number of regular files. */
    files: number;
}

/**
 * One live workspace owned by a {@link WorkspaceStore}.
 *
 * The generic resource is opaque to the store. A caller uses it to keep its own
 * persistent state, such as a tool set, bound to the workspace.
 */
export interface WorkspaceSession<T = unknown> {
    /** Unique workspace id. */
    readonly id: string;
    /** Workspace used for path resolution and access checks. */
    readonly workspace: Workspace;
    /** Opaque caller-owned state. */
    readonly resource: T;
    /** Release the workspace and its backing storage. */
    dispose(): Promise<void>;
}

/** A pinned view of one workspace. Release it when the tool call finishes. */
export interface WorkspaceLease<T = unknown> {
    /** Unique workspace id. */
    readonly id: string;
    /** Workspace used for path resolution and access checks. */
    readonly workspace: Workspace;
    /** Opaque caller-owned state. */
    readonly resource: T;
    /** Release the pin. Idempotent. */
    release(): void;
}

/** Creates a workspace session for a generated id. */
export interface WorkspaceSessionFactory<T> {
    /**
     * @param id - Id the returned session must use.
     */
    create(id: string): Promise<WorkspaceSession<T>>;
}

/** Public metadata for one live workspace. */
export interface WorkspaceInfo extends WorkspaceUsage {
    /** Unique workspace id. */
    readonly id: string;
    /** Creation time in milliseconds since the Unix epoch. */
    readonly createdAt: number;
    /** Last access time in milliseconds since the Unix epoch. */
    readonly lastUsedAt: number;
}

/** Raised when a workspace id is unknown or has already been evicted. */
export class WorkspaceNotFoundError extends Error {
    constructor(id: string) {
        super(`Workspace not found or expired: ${id}`);
        this.name = 'WorkspaceNotFoundError';
    }
}

/** Raised when a capacity limit would be exceeded. */
export class WorkspaceCapacityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkspaceCapacityError';
    }
}

/** Raised when an operation would remove a workspace that is still in use. */
export class WorkspaceBusyError extends Error {
    constructor(id: string) {
        super(`Workspace is in use: ${id}`);
        this.name = 'WorkspaceBusyError';
    }
}

interface Entry<T> {
    session: WorkspaceSession<T>;
    bytes: number;
    files: number;
    createdAt: number;
    lastUsedAt: number;
    pins: number;
}

const DEFAULT_MAX_FILES_PER_WORKSPACE = 1024;

function assertPositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
}

/**
 * Owns ephemeral workspaces, their byte and file usage, and their global
 * lifetime.
 *
 * The store is session-agnostic: it knows only workspace ids, caps, and an
 * opaque resource. Recency is maintained by `Map` insertion order; pinned
 * workspaces are skipped during eviction. A caller must release its lease after
 * each tool call.
 */
export class WorkspaceStore<T = unknown> {
    private readonly config: ResolvedStoreConfiguration;
    private readonly factory: WorkspaceSessionFactory<T>;
    private readonly mutex = new Mutex();
    private readonly entries = new Map<string, Entry<T>>();

    /**
     * @param config - Global workspace, byte, and file limits.
     * @param factory - Creates the workspace and its caller-owned resource.
     */
    constructor(config: WorkspaceStoreConfiguration, factory: WorkspaceSessionFactory<T>) {
        assertPositiveInteger(config.maxTotalBytes, 'maxTotalBytes');
        assertPositiveInteger(config.maxBytesPerWorkspace, 'maxBytesPerWorkspace');
        assertPositiveInteger(config.maxWorkspaces, 'maxWorkspaces');
        const maxFilesPerWorkspace = config.maxFilesPerWorkspace ?? DEFAULT_MAX_FILES_PER_WORKSPACE;
        const maxFiles = config.maxFiles ?? config.maxWorkspaces * maxFilesPerWorkspace;
        assertPositiveInteger(maxFilesPerWorkspace, 'maxFilesPerWorkspace');
        assertPositiveInteger(maxFiles, 'maxFiles');
        if (config.maxBytesPerWorkspace > config.maxTotalBytes) {
            throw new Error('maxBytesPerWorkspace must not exceed maxTotalBytes');
        }
        if (maxFilesPerWorkspace > maxFiles) {
            throw new Error('maxFilesPerWorkspace must not exceed maxFiles');
        }
        this.config = {
            ...config,
            maxFiles,
            maxFilesPerWorkspace
        };
        this.factory = factory;
    }

    /**
     * Create a workspace and return its session. Evicts the least recently
     * used unpinned workspace when the workspace count cap is full.
     */
    async create(): Promise<WorkspaceSession<T>> {
        const evicted: WorkspaceSession<T>[] = [];
        try {
            return await this.mutex.runExclusive(async () => {
                while (this.entries.size + 1 > this.config.maxWorkspaces) {
                    const victim = this.leastRecentlyUsed();
                    if (victim === undefined) {
                        throw new WorkspaceCapacityError(
                            `Cannot create a workspace: all ${this.config.maxWorkspaces} workspaces are pinned`
                        );
                    }
                    this.entries.delete(victim.session.id);
                    evicted.push(victim.session);
                }

                const id = randomUUID();
                const session = await this.factory.create(id);
                if (session.id !== id) {
                    await this.safeDispose(session);
                    throw new Error(
                        `Workspace factory returned id '${session.id}', expected '${id}'`
                    );
                }
                const now = Date.now();
                this.entries.set(id, {
                    session,
                    bytes: 0,
                    files: 0,
                    createdAt: now,
                    lastUsedAt: now,
                    pins: 0
                });
                return session;
            });
        } finally {
            await this.disposeAll(evicted);
        }
    }

    /**
     * Pin a workspace and mark it recently used.
     *
     * @throws {WorkspaceNotFoundError} When the id is unknown.
     */
    async acquire(id: string): Promise<WorkspaceLease<T>> {
        return this.mutex.runExclusive(() => {
            const entry = this.entries.get(id);
            if (entry === undefined) {
                throw new WorkspaceNotFoundError(id);
            }
            this.touch(id, entry);
            entry.pins += 1;
            entry.lastUsedAt = Date.now();
            let released = false;
            return {
                id,
                workspace: entry.session.workspace,
                resource: entry.session.resource,
                release: () => {
                    if (released) return;
                    released = true;
                    void this.releasePin(id);
                }
            };
        });
    }

    /**
     * Delete a workspace and dispose its backing storage. Unknown ids are
     * ignored so callers can retry deletion safely.
     *
     * @throws {WorkspaceBusyError} When the workspace is pinned.
     */
    async delete(id: string): Promise<void> {
        const removed = await this.mutex.runExclusive(() => {
            const entry = this.entries.get(id);
            if (entry === undefined) return undefined;
            if (entry.pins > 0) throw new WorkspaceBusyError(id);
            this.entries.delete(id);
            return entry.session;
        });
        if (removed !== undefined) {
            await this.safeDispose(removed);
        }
    }

    /**
     * Return current usage metadata for a workspace.
     *
     * @throws {WorkspaceNotFoundError} When the id is unknown.
     */
    async info(id: string): Promise<WorkspaceInfo> {
        return this.mutex.runExclusive(async () => {
            const entry = this.entries.get(id);
            if (entry === undefined) {
                throw new WorkspaceNotFoundError(id);
            }
            this.touch(id, entry);
            entry.lastUsedAt = Date.now();
            const usage = await this.scanEntry(entry);
            return {
                id,
                bytes: usage.bytes,
                files: usage.files,
                createdAt: entry.createdAt,
                lastUsedAt: entry.lastUsedAt
            };
        });
    }

    /**
     * Reserve room for a positive byte or file delta before a mutating call.
     * Evicts other least recently used unpinned workspaces when a global cap
     * would otherwise be exceeded.
     *
     * @throws {WorkspaceNotFoundError} When the id is unknown.
     * @throws {WorkspaceCapacityError} When a cap cannot fit the delta.
     */
    async ensureCapacity(id: string, additionalBytes: number, additionalFiles = 0): Promise<void> {
        if (!Number.isFinite(additionalBytes) || additionalBytes < 0) {
            throw new Error('additionalBytes must be a non-negative finite number');
        }
        if (!Number.isInteger(additionalFiles) || additionalFiles < 0) {
            throw new Error('additionalFiles must be a non-negative integer');
        }
        if (additionalBytes === 0 && additionalFiles === 0) return;

        const evicted: WorkspaceSession<T>[] = [];
        try {
            await this.mutex.runExclusive(async () => {
                const entry = this.entries.get(id);
                if (entry === undefined) {
                    throw new WorkspaceNotFoundError(id);
                }
                for (const other of this.entries.values()) {
                    if (other.session.id !== id) {
                        await this.scanEntry(other);
                    }
                }
                const usage = await this.scanEntry(entry);
                if (usage.bytes + additionalBytes > this.config.maxBytesPerWorkspace) {
                    throw new WorkspaceCapacityError(
                        `Workspace ${id} would exceed its ${this.config.maxBytesPerWorkspace} byte limit`
                    );
                }
                if (usage.files + additionalFiles > this.config.maxFilesPerWorkspace) {
                    throw new WorkspaceCapacityError(
                        `Workspace ${id} would exceed its ${this.config.maxFilesPerWorkspace} file limit`
                    );
                }
                while (
                    this.totalBytes() + additionalBytes > this.config.maxTotalBytes ||
                    this.totalFiles() + additionalFiles > this.config.maxFiles
                ) {
                    const victim = this.leastRecentlyUsed(id);
                    if (victim === undefined) {
                        throw new WorkspaceCapacityError(
                            'Cannot free enough workspace space: all candidate workspaces are pinned'
                        );
                    }
                    this.entries.delete(victim.session.id);
                    evicted.push(victim.session);
                }
            });
        } finally {
            await this.disposeAll(evicted);
        }
    }

    /**
     * Rescan a workspace and cache its byte and file counts.
     *
     * @throws {WorkspaceNotFoundError} When the id is unknown.
     */
    async refreshUsage(id: string): Promise<WorkspaceUsage> {
        return this.mutex.runExclusive(async () => {
            const entry = this.entries.get(id);
            if (entry === undefined) {
                throw new WorkspaceNotFoundError(id);
            }
            return this.scanEntry(entry);
        });
    }

    /** Dispose every workspace and clear the store. */
    async dispose(): Promise<void> {
        const sessions = await this.mutex.runExclusive(() => {
            const all = Array.from(this.entries.values()).map((entry) => entry.session);
            this.entries.clear();
            return all;
        });
        await this.disposeAll(sessions);
    }

    private async scanEntry(entry: Entry<T>): Promise<WorkspaceUsage> {
        const usage = await scanWorkspace(entry.session);
        entry.bytes = usage.bytes;
        entry.files = usage.files;
        return usage;
    }

    private totalBytes(): number {
        let total = 0;
        for (const entry of this.entries.values()) {
            total += entry.bytes;
        }
        return total;
    }

    private totalFiles(): number {
        let total = 0;
        for (const entry of this.entries.values()) {
            total += entry.files;
        }
        return total;
    }

    private touch(id: string, entry: Entry<T>): void {
        this.entries.delete(id);
        this.entries.set(id, entry);
    }

    private leastRecentlyUsed(excludeId?: string): Entry<T> | undefined {
        for (const entry of this.entries.values()) {
            if (entry.pins > 0) continue;
            if (entry.session.id === excludeId) continue;
            return entry;
        }
        return undefined;
    }

    private async releasePin(id: string): Promise<void> {
        await this.mutex.runExclusive(() => {
            const entry = this.entries.get(id);
            if (entry !== undefined && entry.pins > 0) {
                entry.pins -= 1;
            }
        });
    }

    private async disposeAll(sessions: WorkspaceSession<T>[]): Promise<void> {
        await Promise.allSettled(sessions.map((session) => this.safeDispose(session)));
    }

    private async safeDispose(session: WorkspaceSession<T>): Promise<void> {
        try {
            await session.dispose();
        } catch {
            return;
        }
    }
}

function isEnoent(error: unknown): boolean {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    const cause = (error as { cause?: unknown }).cause;
    return (
        typeof cause === 'object' &&
        cause !== null &&
        (cause as NodeJS.ErrnoException).code === 'ENOENT'
    );
}

async function scanWorkspace(session: WorkspaceSession<unknown>): Promise<WorkspaceUsage> {
    let bytes = 0;
    let files = 0;
    try {
        const root = session.workspace.workspacePath ?? session.workspace.currentPath;
        for await (const item of session.workspace.walk(root)) {
            if (!item.dirent.isFile()) continue;
            try {
                const stat = await fsp.stat(item.filePath);
                bytes += stat.size;
                files += 1;
            } catch {
                continue;
            }
        }
    } catch (error) {
        if (isEnoent(error)) {
            return { bytes: 0, files: 0 };
        }
        throw error;
    }
    return { bytes, files };
}
