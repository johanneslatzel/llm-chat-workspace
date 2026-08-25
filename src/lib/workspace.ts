import { Mutex } from 'async-mutex';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DirectoryConfiguration } from './config.js';
import { AccessType } from './types.js';

function isWithin(resolved: string, dirs: string[]): boolean {
    const real = path.resolve(resolved);
    for (const dir of dirs) {
        const d = path.resolve(dir);
        const rel = path.relative(d, real);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
        if (rel === '') return true;
    }
    return false;
}

/**
 * Manages the current workspace path and enforces access control for all file operations.
 *
 * Tracks which directories are accessible (read and/or write) and provides methods
 * to check permissions, resolve paths, and switch the active workspace directory.
 * Uses a mutex to ensure thread-safe workspace switching.
 */
export class Workspace {
    /** The currently active workspace directory (absolute path). */
    currentPath: string;
    private cfg: DirectoryConfiguration;
    private mutex: Mutex;
    private readonly onSwitch?: ((newPath: string) => void | Promise<void>) | undefined;

    /**
     * @param config - Directory configuration defining accessible paths and their permission levels.
     * @param onSwitch - Optional hook invoked (and awaited) after a successful workspace switch.
     * @throws {Error} If the configuration contains no access entries.
     */
    constructor(
        config: DirectoryConfiguration,
        onSwitch?: (newPath: string) => void | Promise<void>
    ) {
        config.deduplicate();
        if (config.accesses.length === 0) {
            throw new Error('At least one access directory is required');
        }
        this.cfg = config;
        this.mutex = new Mutex();
        this.onSwitch = onSwitch;

        if (config.workspacePath) {
            this.currentPath = path.resolve(config.workspacePath);
        } else {
            const writeDir = config.accesses.find((a) => a.type === 'write');
            this.currentPath = writeDir
                ? path.resolve(writeDir.path)
                : path.resolve(config.accesses[0]!.path);
        }

        this.currentPath = this.resolvePath(this.currentPath);
    }

    /**
     * Changes the current workspace path to a new directory, thread-safe with a mutex.
     *
     * @param target - Path to the new workspace directory (may be relative or absolute).
     * @throws {Error} If the target is not within any configured accessible directory.
     */
    async switchWorkspace(target: string): Promise<void> {
        await this.mutex.runExclusive(async () => {
            let resolved = path.resolve(target);
            resolved = this.resolvePath(resolved);
            const allDirs = this.cfg.accesses.map((a) => path.resolve(a.path));
            if (!isWithin(resolved, allDirs)) {
                throw new Error(`Path is not within any configured directory: ${target}`);
            }
            this.currentPath = resolved;
        });
        await this.onSwitch?.(this.currentPath);
    }

    /**
     * Resolves a path against the current workspace. If the input is already absolute, `path.resolve` returns it as-is.
     *
     * @param input - Path to resolve (relative or absolute).
     * @returns The resolved absolute path.
     */
    normalize(input: string): string {
        return this.resolvePath(input);
    }

    /**
     * Checks whether the given absolute path is within any directory configured for read (or write) access.
     *
     * @param absPath - Absolute path to check.
     * @returns `true` if the path is readable.
     */
    canRead(absPath: string): boolean {
        const pathToCheck = this.resolvePath(absPath);
        const readDirs = this.cfg.accesses
            .filter((a) => a.type === 'read')
            .map((a) => path.resolve(a.path));
        const writeDirs = this.cfg.accesses
            .filter((a) => a.type === 'write')
            .map((a) => path.resolve(a.path));
        return isWithin(pathToCheck, [...readDirs, ...writeDirs]);
    }

    /**
     * Checks whether the given absolute path is within any directory configured for write access.
     *
     * @param absPath - Absolute path to check.
     * @returns `true` if the path is writable.
     */
    canWrite(absPath: string): boolean {
        const pathToCheck = this.resolvePath(absPath);
        const writeDirs = this.cfg.accesses
            .filter((a) => a.type === 'write')
            .map((a) => path.resolve(a.path));
        return isWithin(pathToCheck, writeDirs);
    }

    /**
     * Adds a directory access entry. For a path that already has an access, the
     * outcome follows the configured access precedence: write-wins keeps write
     * access, while last-added-wins lets the new access override the existing one.
     * Exact duplicates are always collapsed.
     *
     * @param type - Read or write access.
     * @param dir - Directory to grant access to (resolved to an absolute path).
     */
    addAccess(type: AccessType, dir: string): void {
        this.cfg.accesses.push({ type, path: path.resolve(dir) });
        this.rebuild();
    }

    /**
     * Removes all access entries for the given directory.
     *
     * @param dir - Directory to revoke access for (resolved to an absolute path).
     * @throws {Error} If removal would leave no accessible directories.
     */
    removeAccess(dir: string): void {
        const resolved = path.resolve(dir);
        const remaining = this.cfg.accesses.filter((a) => path.resolve(a.path) !== resolved);
        if (remaining.length === 0) {
            throw new Error('At least one access directory is required');
        }
        this.cfg.accesses = remaining;
        this.rebuild();
    }

    /**
     * Replaces the list of directory names to skip when walking (e.g. `node_modules`, `.git`).
     *
     * @param dirs - New skip list.
     */
    setSkipDirs(dirs: string[]): void {
        this.cfg.skipDirs = dirs;
    }

    /**
     * Enables or disables symlink resolution before access checks.
     *
     * @param value - `true` to resolve symlinks via `fs.realpathSync.native()`.
     */
    setResolveSymlinks(value: boolean): void {
        this.cfg.resolveSymlinks = value;
    }

    /**
     * Sets the default workspace path used when no access directory covers the current path.
     *
     * @param target - New workspace path (resolved to an absolute path), or `undefined` to clear it.
     */
    setWorkspacePath(target?: string): void {
        this.cfg.workspacePath = target ? path.resolve(target) : undefined;
    }

    /** The configured default workspace path, or `undefined` when unset. */
    get workspacePath(): string | undefined {
        return this.cfg.workspacePath;
    }

    /**
     * Returns a snapshot of the workspace configuration.
     *
     * @returns A new {@link DirectoryConfiguration} with the current accesses, skip dirs,
     *   symlink resolution flag, and workspace path.
     */
    getConfiguration(): DirectoryConfiguration {
        const accesses = this.getAccesses();
        const skipDirs = [...this.cfg.skipDirs];
        const resolveSymlinks = this.cfg.resolveSymlinks;
        const workspacePath = this.cfg.workspacePath;
        return workspacePath === undefined
            ? new DirectoryConfiguration(
                  accesses,
                  skipDirs,
                  resolveSymlinks,
                  undefined,
                  this.cfg.precedence
              )
            : new DirectoryConfiguration(
                  accesses,
                  skipDirs,
                  resolveSymlinks,
                  workspacePath,
                  this.cfg.precedence
              );
    }

    /**
     * Returns the list of configured directory accesses with their types.
     */
    getAccesses(): { type: AccessType; path: string }[] {
        return this.cfg.accesses.map((a) => ({ type: a.type, path: path.resolve(a.path) }));
    }
    /** The underlying directory configuration. Exposed so callers can mutate precedence or other settings directly. */
    get config(): DirectoryConfiguration {
        return this.cfg;
    }

    /**
     * Returns the list of directory names to skip when walking (e.g. `node_modules`, `.git`).
     */
    get skipDirs(): string[] {
        return this.cfg.skipDirs;
    }
    /**
     * Returns a diagnostic hint when a path fails access checks due to
     * possible confusion between workspace root and filesystem root.
     *
     * @param raw      - The raw user-supplied path string.
     * @param resolved - The resolved absolute path.
     * @returns A hint string (empty if no hint applies).
     */
    pathHint(raw: string, resolved: string): string {
        if (raw.startsWith('/') && !this.canRead(resolved)) {
            return ' (Tip: paths starting with "/" resolve to filesystem root; use "." or a relative path for workspace root)';
        }
        return '';
    }

    /** Whether symlink resolution is enabled for access checks. */
    get resolveSymlinks(): boolean {
        return this.cfg.resolveSymlinks;
    }

    private resolvePath(input: string): string {
        const abs = path.resolve(this.currentPath, input);
        if (!this.cfg.resolveSymlinks) return abs;
        try {
            return fs.realpathSync.native(abs);
        } catch {
            return abs;
        }
    }

    /**
     * Re-derives the internal configuration after a mutator changes the access list.
     *
     * Deduplicates accesses according to the configured access precedence, then
     * ensures `currentPath` still points inside an accessible directory. The
     * current path is kept when it is still within the accesses; otherwise
     * `workspacePath` is used when set and accessible; otherwise the first write
     * access is used (or the first access when no write access remains).
     */
    private rebuild(): void {
        this.cfg.deduplicate();
        const allDirs = this.cfg.accesses.map((a) => path.resolve(a.path));
        if (isWithin(this.currentPath, allDirs)) return;
        const workspace = this.cfg.workspacePath ? path.resolve(this.cfg.workspacePath) : undefined;
        if (workspace !== undefined && isWithin(workspace, allDirs)) {
            this.currentPath = workspace;
            return;
        }
        const writeDir = this.cfg.accesses.find((a) => a.type === AccessType.Write);
        this.currentPath = writeDir
            ? path.resolve(writeDir.path)
            : path.resolve(this.cfg.accesses[0]!.path);
        this.currentPath = this.resolvePath(this.currentPath);
    }

    /**
     * Recursively walks a directory, yielding entries for files and directories.
     * Skips directories whose names are listed in `cfg.skipDirs`.
     *
     * Only the initial root path is validated: a nonexistent or non-directory
     * root rejects with an Error before any entry is produced. Failures on
     * nested directories are reported through `onError` instead, so the walk
     * continues with the remaining subtrees.
     *
     * @param dir - Directory to walk.
     * @param onError - Optional callback invoked when a subdirectory cannot be read.
     *   Receives the directory path and the error. The walk continues with other subtrees.
     * @throws {Error} If the root path does not exist or is not a directory.
     * @yields {WalkEntry} Entries for each file and subdirectory found.
     */
    async *walk(
        dir: string,
        onError?: (dirPath: string, error: Error) => void
    ): AsyncGenerator<{ filePath: string; dirent: import('node:fs').Dirent }> {
        const resolved = this.resolvePath(dir);
        if (!this.canRead(resolved)) return;
        let st: fs.Stats;
        try {
            st = await fsp.stat(resolved);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error(`Cannot walk '${resolved}': the path does not exist`, { cause: e });
            }
            throw new Error(`Cannot walk '${resolved}': ${(e as Error).message}`, { cause: e });
        }
        if (!st.isDirectory()) {
            throw new Error(`Cannot walk '${resolved}': it is a file, not a directory`);
        }
        yield* this.walkDirectory(resolved, onError);
    }

    /**
     * Recursion core of {@link Workspace.walk}: lists `dir`, yields its entries,
     * and recurses into subdirectories. An unreadable directory is reported
     * through `onError` while the remaining subtrees are still walked.
     *
     * @param dir - Absolute directory to list.
     * @param onError - Optional callback invoked when this directory cannot be read.
     */
    private async *walkDirectory(
        dir: string,
        onError?: (dirPath: string, error: Error) => void
    ): AsyncGenerator<{ filePath: string; dirent: import('node:fs').Dirent }> {
        let entries: import('node:fs').Dirent[];
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (e) {
            onError?.(dir, e as Error);
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (this.cfg.skipDirs.includes(entry.name)) continue;
                yield { filePath: fullPath, dirent: entry };
                yield* this.walkDirectory(fullPath, onError);
            } else if (entry.isFile()) {
                yield { filePath: fullPath, dirent: entry };
            }
        }
    }
}
