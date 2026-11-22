import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DirectoryConfiguration } from './config.js';
import { AccessType } from './types.js';
import { Workspace } from './workspace.js';

const PRIVATE_DIRECTORY_MODE = 0o700;

/** Configuration for ephemeral temp-directory workspaces. */
export interface EphemeralWorkspaceConfiguration {
    /** Base directory for workspace roots. Defaults to a process-specific directory under the OS temp dir. */
    baseDir?: string;
    /** Resolve symlinks before access checks. Defaults to true. */
    resolveSymlinks?: boolean;
}

/** One provisioned ephemeral workspace. */
export interface EphemeralWorkspace {
    /** Workspace restricted to a private temp root. */
    readonly workspace: Workspace;
    /** Remove the backing temp directory. */
    dispose(): Promise<void>;
}

/**
 * Provisions private temp-directory workspaces.
 *
 * Each workspace gets one writable root and no other access. The process-wide
 * store owns the workspace lifetime; this provisioner only creates and removes
 * the backing directory.
 */
export class EphemeralWorkspaceProvisioner {
    private readonly baseDir: string;
    private readonly resolveSymlinks: boolean;
    private baseDirReady: Promise<void> | undefined;

    /**
     * @param config - Base directory and symlink policy.
     */
    constructor(config: EphemeralWorkspaceConfiguration = {}) {
        this.baseDir = path.resolve(
            config.baseDir ?? path.join(tmpdir(), 'llm-chat-workspace', `pid-${process.pid}`)
        );
        this.resolveSymlinks = config.resolveSymlinks ?? true;
    }

    /** Resolved base directory used for new workspace roots. */
    get directory(): string {
        return this.baseDir;
    }

    /**
     * Create a new private workspace root and a Workspace restricted to it.
     */
    async create(): Promise<EphemeralWorkspace> {
        await this.ensureBaseDir();
        const root = await mkdtemp(path.join(this.baseDir, 'ws-'));
        await chmod(root, PRIVATE_DIRECTORY_MODE);
        const configuration = new DirectoryConfiguration(
            [{ type: AccessType.Write, path: root }],
            [],
            this.resolveSymlinks,
            root
        );
        const workspace = new Workspace(configuration);
        return {
            workspace,
            dispose: async () => {
                await rm(root, { recursive: true, force: true });
            }
        };
    }

    private async ensureBaseDir(): Promise<void> {
        this.baseDirReady ??= mkdir(this.baseDir, {
            recursive: true,
            mode: PRIVATE_DIRECTORY_MODE
        }).then(() => undefined);
        await this.baseDirReady;
    }
}
