import * as path from 'node:path';
import { AccessType } from './types.js';

/** Configuration that defines which directories are accessible and at what permission level. */
export class DirectoryConfiguration {
    /** List of access entries. Must contain at least one entry. */
    accesses: { type: AccessType; path: string }[];

    /** Directory names to skip when walking directory trees (e.g. `node_modules`, `.git`). */
    skipDirs: string[];

    /**
     * When `true`, resolves symlinks via `fs.realpathSync.native()` before access checks.
     * This prevents symlink-based path traversal outside configured directories.
     * Defaults to `false` (symlinks are followed as-is).
     */
    resolveSymlinks: boolean;

    /** The default workspace path. Used as the initial `currentPath` in the Workspace. */
    workspacePath?: string | undefined;

    /**
     * Constructs a directory configuration. When called with no arguments,
     * all values are read from environment variables. Pass specific arguments
     * to override individual values.
     *
     * @param accesses - Access entries. Omit or pass `undefined` to read from env vars.
     * @param skipDirs - Directory names to skip. Defaults to `[]` when accesses are explicitly provided.
     * @param resolveSymlinks - Resolve symlinks before access checks. Defaults to `false` when accesses are explicitly provided.
     * @param workspacePath - Default workspace path. Defaults to resolved `LLM_CHAT_WORKSPACE_PATH` or `cwd` when reading from env.
     */
    constructor(
        accesses?: { type: AccessType; path: string }[],
        skipDirs?: string[],
        resolveSymlinks?: boolean,
        workspacePath?: string
    ) {
        if (accesses) {
            this.accesses = accesses;
            this.skipDirs = skipDirs ?? [];
            this.resolveSymlinks = resolveSymlinks ?? false;
            this.workspacePath = workspacePath;
        } else {
            const readDirs = parseDirs(process.env.LLM_CHAT_WORKSPACE_READ_DIRS);
            const writeDirs = parseDirs(process.env.LLM_CHAT_WORKSPACE_WRITE_DIRS);
            this.accesses = [];
            for (const d of readDirs) {
                this.accesses.push({ type: AccessType.Read, path: path.resolve(d) });
            }
            for (const d of writeDirs) {
                this.accesses.push({ type: AccessType.Write, path: path.resolve(d) });
            }
            const wsPath = path.resolve(process.env.LLM_CHAT_WORKSPACE_PATH ?? process.cwd());
            const alreadyWrite = this.accesses.some(
                (a) => a.type === AccessType.Write && a.path === wsPath
            );
            if (!alreadyWrite) {
                this.accesses.push({ type: AccessType.Write, path: wsPath });
            }
            this.skipDirs = parseDirs(process.env.LLM_CHAT_WORKSPACE_SKIP_DIRS);
            this.resolveSymlinks = parseEnvBool('LLM_CHAT_WORKSPACE_RESOLVE_SYMLINKS', false);
            this.workspacePath = wsPath;
        }
    }

    /**
     * Deduplicates directory accesses: for any path that appears multiple times,
     * write access takes precedence over read access. Exact duplicates are removed.
     *
     * @returns A new directory configuration with deduplicated accesses.
     */
    deduplicate(): DirectoryConfiguration {
        const seen = new Map<string, AccessType>();
        for (const a of this.accesses) {
            const existing = seen.get(a.path);
            if (existing === AccessType.Write) continue;
            if (a.type === AccessType.Write || !existing) {
                seen.set(a.path, a.type);
            }
        }
        return new DirectoryConfiguration(
            Array.from(seen.entries()).map(([path, type]) => ({ type, path })),
            this.skipDirs,
            this.resolveSymlinks,
            this.workspacePath
        );
    }
}

function parseDirs(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseEnvBool(key: string, fallback: boolean): boolean {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    return raw === 'true';
}
