import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { DirectoryConfiguration } from '../../src/lib/config.js';
import { Workspace } from '../../src/lib/workspace.js';
import { AccessPrecedence, AccessType } from '../../src/lib/types.js';
import { withTempDir } from '../helper/temp-fs.js';

describe('DirectoryConfiguration.deduplicate', () => {
    it('removes read access when write access exists for the same path', () => {
        const result = new DirectoryConfiguration(
            [
                { type: AccessType.Read, path: '/tmp' },
                { type: AccessType.Write, path: '/tmp' },
            ],
        ).deduplicate();
        expect(result.accesses).toHaveLength(1);
        expect(result.accesses[0]!.type).toBe(AccessType.Write);
        expect(result.accesses[0]!.path).toBe(path.resolve('/tmp'));
    });

    it('removes duplicate read entries', () => {
        const result = new DirectoryConfiguration(
            [
                { type: AccessType.Read, path: '/tmp' },
                { type: AccessType.Read, path: '/tmp' },
            ],
        ).deduplicate();
        expect(result.accesses).toHaveLength(1);
        expect(result.accesses[0]!.type).toBe(AccessType.Read);
        expect(result.accesses[0]!.path).toBe(path.resolve('/tmp'));
    });

    it('removes duplicate write entries', () => {
        const result = new DirectoryConfiguration(
            [
                { type: AccessType.Write, path: '/tmp' },
                { type: AccessType.Write, path: '/tmp' },
            ],
        ).deduplicate();
        expect(result.accesses).toHaveLength(1);
        expect(result.accesses[0]!.type).toBe(AccessType.Write);
        expect(result.accesses[0]!.path).toBe(path.resolve('/tmp'));
    });

    it('keeps distinct paths separate', () => {
        const result = new DirectoryConfiguration(
            [
                { type: AccessType.Read, path: '/var/log' },
                { type: AccessType.Write, path: '/tmp' },
            ],
        ).deduplicate();
        expect(result.accesses).toHaveLength(2);
    });

    it('returns empty for empty input', () => {
        const result = new DirectoryConfiguration([]).deduplicate();
        expect(result.accesses).toHaveLength(0);
    });

    it('write overrides read for same path regardless of order', () => {
        const result = new DirectoryConfiguration(
            [
                { type: AccessType.Write, path: '/tmp' },
                { type: AccessType.Read, path: '/tmp' },
            ],
        ).deduplicate();
        expect(result.accesses).toHaveLength(1);
        expect(result.accesses[0]!.type).toBe(AccessType.Write);
    });

    describe('with AccessPrecedence.LastAddedWins', () => {
        function last(accesses: { type: AccessType; path: string }[]): DirectoryConfiguration {
            return new DirectoryConfiguration(
                accesses,
                undefined,
                undefined,
                undefined,
                AccessPrecedence.LastAddedWins
            );
        }

        it('keeps the last-supplied access when a read follows a write', () => {
            const result = last([
                { type: AccessType.Write, path: '/tmp' },
                { type: AccessType.Read, path: '/tmp' },
            ]).deduplicate();
            expect(result.accesses).toHaveLength(1);
            expect(result.accesses[0]!.type).toBe(AccessType.Read);
            expect(result.accesses[0]!.path).toBe(path.resolve('/tmp'));
        });

        it('keeps the last-supplied access when a write follows a read', () => {
            const result = last([
                { type: AccessType.Read, path: '/tmp' },
                { type: AccessType.Write, path: '/tmp' },
            ]).deduplicate();
            expect(result.accesses).toHaveLength(1);
            expect(result.accesses[0]!.type).toBe(AccessType.Write);
        });

        it('collapses exact duplicates', () => {
            const result = last([
                { type: AccessType.Read, path: '/tmp' },
                { type: AccessType.Read, path: '/tmp' },
            ]).deduplicate();
            expect(result.accesses).toHaveLength(1);
            expect(result.accesses[0]!.type).toBe(AccessType.Read);
        });

        it('keeps distinct paths separate', () => {
            const result = last([
                { type: AccessType.Read, path: '/var/log' },
                { type: AccessType.Write, path: '/tmp' },
            ]).deduplicate();
            expect(result.accesses).toHaveLength(2);
        });

        it('preserves the precedence mode through deduplicate', () => {
            const result = last([
                { type: AccessType.Write, path: '/tmp' },
                { type: AccessType.Read, path: '/tmp' },
            ]).deduplicate();
            expect(result.precedence).toBe(AccessPrecedence.LastAddedWins);
        });
    });
});

describe('Workspace', () => {
    it('throws when accesses is empty', () => {
        expect(() => new Workspace(new DirectoryConfiguration([]))).toThrow('At least one access directory');
    });

    it('sets currentPath to write directory', () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Read, path: '/var/log' },
                { type: AccessType.Write, path: '/home/project' },
            ],
        ));
        expect(ws.currentPath).toBe('/home/project');
    });

    it('uses workspacePath when set, even if other write dirs exist', () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Write, path: '/some/output' },
                { type: AccessType.Read, path: '/var/log' },
            ],
            undefined,
            undefined,
            '/workspace',
        ));
        expect(ws.currentPath).toBe('/workspace');
    });

    it('falls back to first write dir when no workspacePath', () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Write, path: '/home/project' },
                { type: AccessType.Write, path: '/home/other' },
            ],
        ));
        expect(ws.currentPath).toBe('/home/project');
    });

    it('falls back to read directory when no write access', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Read, path: '/var/log' }])
        );
        expect(ws.currentPath).toBe('/var/log');
    });

    it('canRead returns true for write directory', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }])
        );
        expect(ws.canRead('/tmp')).toBe(true);
        expect(ws.canRead('/tmp/subdir')).toBe(true);
    });

    it('canRead returns false for path outside accesses', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }])
        );
        expect(ws.canRead('/etc')).toBe(false);
    });

    it('canWrite returns true for write directory', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }])
        );
        expect(ws.canWrite('/tmp')).toBe(true);
    });

    it('canWrite returns false for read-only directory', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Read, path: '/tmp' }])
        );
        expect(ws.canWrite('/tmp')).toBe(false);
    });

    it('normalize resolves relative path to currentPath', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/home/project' }])
        );
        expect(ws.normalize('src/file.ts')).toBe('/home/project/src/file.ts');
    });

    it('normalize resolves absolute path as-is', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/home/project' }])
        );
        expect(ws.normalize('/etc/passwd')).toBe('/etc/passwd');
    });

    it('switchWorkspace to valid subdirectory', async () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }])
        );
        await ws.switchWorkspace('/tmp/subdir');
        expect(ws.currentPath).toBe('/tmp/subdir');
    });

    it('switchWorkspace rejects path outside accesses', async () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }])
        );
        await expect(ws.switchWorkspace('/etc')).rejects.toThrow('not within any configured directory');
    });

    it('deduplicates overlapping read+write accesses from constructor', () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Read, path: '/tmp' },
                { type: AccessType.Write, path: '/tmp' },
            ],
        ));
        expect(ws.canRead('/tmp')).toBe(true);
        expect(ws.canWrite('/tmp')).toBe(true);
    });

    it('canRead returns true for both read and write directories', () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Read, path: '/var/log' },
                { type: AccessType.Write, path: '/tmp' },
            ],
        ));
        expect(ws.canRead('/var/log')).toBe(true);
        expect(ws.canRead('/var/log/syslog')).toBe(true);
        expect(ws.canRead('/tmp')).toBe(true);
        expect(ws.canRead('/etc')).toBe(false);
    });

    it('getAccesses returns configured accesses with resolved paths', () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Read, path: '/var/log' },
                { type: AccessType.Write, path: '/home/project' },
            ],
            ['node_modules', '.git'],
        ));
        expect(ws.getAccesses()).toEqual([
            { type: AccessType.Read, path: path.resolve('/var/log') },
            { type: AccessType.Write, path: path.resolve('/home/project') },
        ]);
        expect(ws.skipDirs).toEqual(['node_modules', '.git']);
    });

    it('pathHint returns a hint for an unreadable root-style path', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }]));
        expect(ws.pathHint('/etc', '/etc')).toContain('Tip:');
    });

    it('pathHint returns empty for a readable path', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }]));
        expect(ws.pathHint('/tmp', '/tmp')).toBe('');
    });

    it('pathHint returns empty when the raw path does not start with a slash', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }]));
        expect(ws.pathHint('src', '/tmp/src')).toBe('');
    });
});

describe('Workspace.walk', () => {
    it('returns no entries for unreadable path', async () => {
        await withTempDir(async (dir) => {
            const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: dir }]));
            const outside = path.resolve(dir, '..', 'outside');
            const entries: Array<{ filePath: string; dirent: import('node:fs').Dirent }> = [];
            for await (const entry of ws.walk(outside)) {
                entries.push(entry);
            }
            expect(entries).toHaveLength(0);
        });
    });

    it('yields file entries and skips symlinks', async () => {
        await withTempDir(async (dir) => {
            const allowed = path.join(dir, 'allowed');
            mkdirSync(allowed, { recursive: true });
            writeFileSync(path.join(allowed, 'file.txt'), 'hello');
            symlinkSync('/nonexistent', path.join(allowed, 'broken-link'));

            const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Read, path: allowed }]));
            const entries: Array<{ filePath: string; dirent: import('node:fs').Dirent }> = [];
            for await (const entry of ws.walk(allowed)) {
                entries.push(entry);
            }
            expect(entries).toHaveLength(1);
            expect(entries[0]!.dirent.isFile()).toBe(true);
            expect(entries[0]!.filePath).toContain('file.txt');
        });
    });

    it('yields directory entries and recurses', async () => {
        await withTempDir(async (dir) => {
            const allowed = path.join(dir, 'allowed');
            mkdirSync(allowed, { recursive: true });
            mkdirSync(path.join(allowed, 'subdir'), { recursive: true });
            writeFileSync(path.join(allowed, 'subdir', 'nested.txt'), 'data');

            const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Read, path: allowed }]));
            const entries: Array<{ filePath: string; dirent: import('node:fs').Dirent }> = [];
            for await (const entry of ws.walk(allowed)) {
                entries.push(entry);
            }
            const filePaths = entries.map((e) => e.filePath);
            expect(filePaths).toContain(path.join(allowed, 'subdir'));
            expect(filePaths).toContain(path.join(allowed, 'subdir', 'nested.txt'));
        });
    });

    it('invokes onError when a directory cannot be read', async () => {
        await withTempDir(async (dir) => {
            const errors: Array<{ dirPath: string; error: Error }> = [];
            const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: dir }]));
            const missing = path.join(dir, 'missing');
            const entries: Array<{ filePath: string; dirent: import('node:fs').Dirent }> = [];
            for await (const entry of ws.walk(missing, (dirPath, error) => {
                errors.push({ dirPath, error });
            })) {
                entries.push(entry);
            }
            expect(errors).toHaveLength(1);
            expect(errors[0]!.dirPath).toBe(missing);
            expect(entries).toHaveLength(0);
        });
    });

    it('skips directories listed in skipDirs', async () => {
        await withTempDir(async (dir) => {
            const allowed = path.join(dir, 'allowed');
            mkdirSync(path.join(allowed, 'node_modules'), { recursive: true });
            writeFileSync(path.join(allowed, 'node_modules', 'dep.txt'), 'data');
            writeFileSync(path.join(allowed, 'keep.txt'), 'keep');

            const ws = new Workspace(new DirectoryConfiguration(
                [{ type: AccessType.Read, path: allowed }],
                ['node_modules'],
            ));
            const entries: Array<{ filePath: string; dirent: import('node:fs').Dirent }> = [];
            for await (const entry of ws.walk(allowed)) {
                entries.push(entry);
            }
            const filePaths = entries.map((e) => e.filePath);
            expect(filePaths).toContain(path.join(allowed, 'keep.txt'));
            expect(filePaths).not.toContain(path.join(allowed, 'node_modules'));
            expect(filePaths).not.toContain(path.join(allowed, 'node_modules', 'dep.txt'));
        });
    });
});

describe('Workspace — resolveSymlinks', () => {
    it('when false, follows symlinks to outside paths (default behavior)', async () => {
        await withTempDir(async (dir) => {
            const allowedDir = path.join(dir, 'allowed');
            const secretDir = path.join(dir, 'secret');
            const linkPath = path.join(allowedDir, 'to-secret');

            mkdirSync(allowedDir, { recursive: true });
            mkdirSync(secretDir, { recursive: true });
            writeFileSync(path.join(secretDir, 'file.txt'), 'secret');
            symlinkSync(secretDir, linkPath);

            const ws = new Workspace(
                new DirectoryConfiguration([{ type: AccessType.Read, path: allowedDir }])
            );
            expect(ws.resolveSymlinks).toBe(false);
            expect(ws.canRead(linkPath)).toBe(true);
        });
    });

    it('when true, blocks symlinks to outside paths', async () => {
        await withTempDir(async (dir) => {
            const allowedDir = path.join(dir, 'allowed');
            const secretDir = path.join(dir, 'secret');
            const linkPath = path.join(allowedDir, 'to-secret');

            mkdirSync(allowedDir, { recursive: true });
            mkdirSync(secretDir, { recursive: true });
            writeFileSync(path.join(secretDir, 'file.txt'), 'secret');
            symlinkSync(secretDir, linkPath);

            const ws = new Workspace(
                new DirectoryConfiguration(
                    [{ type: AccessType.Read, path: allowedDir }],
                    undefined,
                    true,
                )
            );
            expect(ws.resolveSymlinks).toBe(true);
            expect(ws.canRead(linkPath)).toBe(false);
        });
    });

    it('when true, allows symlinks to paths within allowed dirs', async () => {
        await withTempDir(async (dir) => {
            const allowedDir = path.join(dir, 'allowed');
            const subDir = path.join(allowedDir, 'sub');
            const linkPath = path.join(allowedDir, 'link-to-sub');

            mkdirSync(allowedDir, { recursive: true });
            mkdirSync(subDir, { recursive: true });
            writeFileSync(path.join(subDir, 'file.txt'), 'hello');
            symlinkSync(subDir, linkPath);

            const ws = new Workspace(
                new DirectoryConfiguration(
                    [{ type: AccessType.Read, path: allowedDir }],
                    undefined,
                    true,
                )
            );
            expect(ws.canRead(linkPath)).toBe(true);
        });
    });

    it('when true, allows read of files inside allowed dirs', async () => {
        await withTempDir(async (dir) => {
            const allowedDir = path.join(dir, 'allowed');
            mkdirSync(allowedDir, { recursive: true });
            writeFileSync(path.join(allowedDir, 'file.txt'), 'hello');

            const ws = new Workspace(
                new DirectoryConfiguration(
                    [{ type: AccessType.Read, path: allowedDir }],
                    undefined,
                    true,
                )
            );
            expect(ws.canRead(path.join(allowedDir, 'file.txt'))).toBe(true);
        });
    });

    it('falls back to abs path when realpathSync.native fails', async () => {
        await withTempDir(async (dir) => {
            const ws = new Workspace(
                new DirectoryConfiguration(
                    [{ type: AccessType.Write, path: dir }],
                    undefined,
                    true,
                )
            );
            const result = ws.normalize('nonexistent');
            expect(result).toBe(path.join(dir, 'nonexistent'));
        });
    });
});

describe('Workspace.onSwitch', () => {
    it('invokes the hook after a successful switch with the new path', async () => {
        const hooks: string[] = [];
        const ws = new Workspace(
            new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }]),
            (newPath) => {
                hooks.push(newPath);
            }
        );
        await ws.switchWorkspace('/tmp/subdir');
        expect(ws.currentPath).toBe('/tmp/subdir');
        expect(hooks).toEqual(['/tmp/subdir']);
    });

    it('does not fire the hook on construction', () => {
        const hooks: string[] = [];
        const ws = new Workspace(
            new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }]),
            (newPath) => {
                hooks.push(newPath);
            }
        );
        expect(ws.currentPath).toBe('/tmp');
        expect(hooks).toEqual([]);
    });

    it('awaits an async hook before switchWorkspace resolves', async () => {
        const order: string[] = [];
        const ws = new Workspace(
            new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }]),
            async () => {
                await Promise.resolve();
                order.push('hook');
            }
        );
        await ws.switchWorkspace('/tmp/subdir');
        order.push('after');
        expect(order).toEqual(['hook', 'after']);
    });

    it('does not invoke the hook when the switch is rejected', async () => {
        const hooks: string[] = [];
        const ws = new Workspace(
            new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }]),
            (newPath) => {
                hooks.push(newPath);
            }
        );
        await expect(ws.switchWorkspace('/etc')).rejects.toThrow(
            'not within any configured directory'
        );
        expect(hooks).toEqual([]);
    });
});

describe('DirectoryConfiguration.resolveSymlinks', () => {
    it('defaults to false', () => {
        const dc = new DirectoryConfiguration([{ type: AccessType.Write, path: '/tmp' }]);
        expect(dc.resolveSymlinks).toBe(false);
    });

    it('can be set to true', () => {
        const dc = new DirectoryConfiguration(
            [{ type: AccessType.Write, path: '/tmp' }],
            undefined,
            true,
        );
        expect(dc.resolveSymlinks).toBe(true);
    });

    it('can be set to false explicitly', () => {
        const dc = new DirectoryConfiguration(
            [{ type: AccessType.Write, path: '/tmp' }],
            undefined,
            false,
        );
        expect(dc.resolveSymlinks).toBe(false);
    });

    it('preserves workspacePath through deduplicate', () => {
        const dc = new DirectoryConfiguration(
            [
                { type: AccessType.Read, path: '/tmp' },
                { type: AccessType.Write, path: '/tmp' },
            ],
            undefined,
            true,
            '/workspace',
        );
        const deduped = dc.deduplicate();
        expect(deduped.workspacePath).toBe('/workspace');
    });

    it('is preserved through deduplicate', () => {
        const dc = new DirectoryConfiguration(
            [
                { type: AccessType.Read, path: '/tmp' },
                { type: AccessType.Write, path: '/tmp' },
            ],
            undefined,
            true,
        );
        const deduped = dc.deduplicate();
        expect(deduped.resolveSymlinks).toBe(true);
    });
});

describe('DirectoryConfiguration — default constructor (from env)', () => {
    afterEach(() => {
        delete process.env.LLM_CHAT_WORKSPACE_READ_DIRS;
        delete process.env.LLM_CHAT_WORKSPACE_WRITE_DIRS;
        delete process.env.LLM_CHAT_WORKSPACE_PATH;
        delete process.env.LLM_CHAT_WORKSPACE_SKIP_DIRS;
        delete process.env.LLM_CHAT_WORKSPACE_RESOLVE_SYMLINKS;
        delete process.env.LLM_CHAT_WORKSPACE_PRECEDENCE;
    });

    it('defaults workspace to cwd when no env vars set', () => {
        const result = new DirectoryConfiguration();
        expect(result.accesses).toHaveLength(1);
        expect(result.accesses[0]!.type).toBe('write');
        expect(result.accesses[0]!.path).toBe(process.cwd());
        expect(result.workspacePath).toBe(process.cwd());
    });

    it('reads workspace from env', () => {
        process.env.LLM_CHAT_WORKSPACE_PATH = '/custom/ws';
        const result = new DirectoryConfiguration();
        expect(result.accesses).toHaveLength(1);
        expect(result.accesses[0]!.type).toBe('write');
        expect(result.accesses[0]!.path).toBe('/custom/ws');
        expect(result.workspacePath).toBe('/custom/ws');
    });

    it('parses read dirs from env', () => {
        process.env.LLM_CHAT_WORKSPACE_READ_DIRS = '/var/log,/tmp';
        const result = new DirectoryConfiguration();
        expect(result.accesses).toHaveLength(3);
        expect(result.accesses[0]!.type).toBe('read');
        expect(result.accesses[0]!.path).toBe(path.resolve('/var/log'));
        expect(result.accesses[1]!.type).toBe('read');
        expect(result.accesses[1]!.path).toBe(path.resolve('/tmp'));
        expect(result.accesses[2]!.type).toBe('write');
        expect(result.accesses[2]!.path).toBe(process.cwd());
    });

    it('parses write dirs from env', () => {
        process.env.LLM_CHAT_WORKSPACE_WRITE_DIRS = '/home/project,/home/other';
        const result = new DirectoryConfiguration();
        expect(result.accesses).toHaveLength(3);
        expect(result.accesses[0]!.type).toBe('write');
        expect(result.accesses[0]!.path).toBe(path.resolve('/home/project'));
        expect(result.accesses[1]!.type).toBe('write');
        expect(result.accesses[1]!.path).toBe(path.resolve('/home/other'));
        expect(result.accesses[2]!.type).toBe('write');
        expect(result.accesses[2]!.path).toBe(process.cwd());
    });

    it('deduplicates workspace when it matches a write dir', () => {
        process.env.LLM_CHAT_WORKSPACE_WRITE_DIRS = '/home/project';
        process.env.LLM_CHAT_WORKSPACE_PATH = '/home/project';
        const result = new DirectoryConfiguration();
        expect(result.accesses).toHaveLength(1);
        expect(result.accesses[0]!.type).toBe('write');
        expect(result.accesses[0]!.path).toBe(path.resolve('/home/project'));
    });

    it('workspace from env takes precedence as currentPath over write dirs', () => {
        process.env.LLM_CHAT_WORKSPACE_PATH = '/workspace';
        process.env.LLM_CHAT_WORKSPACE_WRITE_DIRS = '/some/output';
        const config = new DirectoryConfiguration();
        const ws = new Workspace(config);
        expect(ws.currentPath).toBe('/workspace');
    });

    it('combines read, write, and workspace dirs', () => {
        process.env.LLM_CHAT_WORKSPACE_READ_DIRS = '/var/log';
        process.env.LLM_CHAT_WORKSPACE_WRITE_DIRS = '/home/project';
        process.env.LLM_CHAT_WORKSPACE_PATH = '/workspace';
        const result = new DirectoryConfiguration();
        expect(result.accesses).toHaveLength(3);
        expect(result.accesses[0]!.type).toBe('read');
        expect(result.accesses[0]!.path).toBe(path.resolve('/var/log'));
        expect(result.accesses[1]!.type).toBe('write');
        expect(result.accesses[1]!.path).toBe(path.resolve('/home/project'));
        expect(result.accesses[2]!.type).toBe('write');
        expect(result.accesses[2]!.path).toBe(path.resolve('/workspace'));
    });

    it('filters empty entries from read dirs', () => {
        process.env.LLM_CHAT_WORKSPACE_READ_DIRS = '/var/log,, /tmp ,';
        const result = new DirectoryConfiguration();
        expect(result.accesses).toHaveLength(3);
        const readPaths = result.accesses.filter((a) => a.type === 'read').map((a) => a.path);
        expect(readPaths).toEqual([path.resolve('/var/log'), path.resolve('/tmp')]);
    });

    it('filters empty entries from write dirs', () => {
        process.env.LLM_CHAT_WORKSPACE_WRITE_DIRS = '/home/a,, /home/b ,';
        const result = new DirectoryConfiguration();
        expect(result.accesses).toHaveLength(3);
        const writePaths = result.accesses.filter((a) => a.type === 'write').map((a) => a.path);
        expect(writePaths).toEqual([path.resolve('/home/a'), path.resolve('/home/b'), process.cwd()]);
    });

    it('resolveSymlinks defaults to false when env not set', () => {
        const result = new DirectoryConfiguration();
        expect(result.resolveSymlinks).toBe(false);
    });

    it('resolveSymlinks is true when env is "true"', () => {
        process.env.LLM_CHAT_WORKSPACE_RESOLVE_SYMLINKS = 'true';
        const result = new DirectoryConfiguration();
        expect(result.resolveSymlinks).toBe(true);
    });

    it('resolveSymlinks is false when env is "false"', () => {
        process.env.LLM_CHAT_WORKSPACE_RESOLVE_SYMLINKS = 'false';
        const result = new DirectoryConfiguration();
        expect(result.resolveSymlinks).toBe(false);
    });

    it('resolveSymlinks is false when env is any non-"true" value', () => {
        process.env.LLM_CHAT_WORKSPACE_RESOLVE_SYMLINKS = '1';
        const result = new DirectoryConfiguration();
        expect(result.resolveSymlinks).toBe(false);
    });

    it('parses precedence from env when set to last-added-wins', () => {
        process.env.LLM_CHAT_WORKSPACE_PRECEDENCE = 'last-added-wins';
        const result = new DirectoryConfiguration();
        expect(result.precedence).toBe(AccessPrecedence.LastAddedWins);
    });

    it('defaults precedence to write-wins when env is not set', () => {
        const result = new DirectoryConfiguration();
        expect(result.precedence).toBe(AccessPrecedence.WriteWins);
    });

    it('defaults precedence to write-wins for invalid env values', () => {
        process.env.LLM_CHAT_WORKSPACE_PRECEDENCE = 'bogus';
        const result = new DirectoryConfiguration();
        expect(result.precedence).toBe(AccessPrecedence.WriteWins);
    });
});

describe('Workspace.addAccess', () => {
    it('adds a new read access and exposes it via getAccesses', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/w' }]));
        ws.addAccess(AccessType.Read, '/r');
        expect(ws.getAccesses()).toEqual([
            { type: AccessType.Write, path: path.resolve('/w') },
            { type: AccessType.Read, path: path.resolve('/r') },
        ]);
    });

    it('adds a new write access', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Read, path: '/r' }]));
        ws.addAccess(AccessType.Write, '/w');
        expect(ws.getAccesses()).toEqual([
            { type: AccessType.Read, path: path.resolve('/r') },
            { type: AccessType.Write, path: path.resolve('/w') },
        ]);
    });

    it('resolves loose paths before storing', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/w' }]));
        ws.addAccess(AccessType.Read, '/r');
        expect(ws.getAccesses()[1]!.path).toBe(path.resolve('/r'));
    });

    it('does not throw when resolving — regression for the param-shadowing bug', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/w' }]));
        expect(() => ws.addAccess(AccessType.Write, '/tmp')).not.toThrow();
    });

    it('keeps currentPath when it remains inside the accesses', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/a' }]));
        const before = ws.currentPath;
        ws.addAccess(AccessType.Read, '/r');
        expect(ws.currentPath).toBe(before);
    });

    it('no-ops when a write access already exists for the path', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/a' }]));
        ws.addAccess(AccessType.Write, '/a');
        expect(ws.getAccesses()).toEqual([{ type: AccessType.Write, path: path.resolve('/a') }]);
    });

    it('upgrades a read access to write', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Read, path: '/a' }]));
        ws.addAccess(AccessType.Write, '/a');
        expect(ws.getAccesses()).toEqual([{ type: AccessType.Write, path: path.resolve('/a') }]);
    });

    describe('with AccessPrecedence.LastAddedWins', () => {
        function last(accesses: { type: AccessType; path: string }[]): DirectoryConfiguration {
            return new DirectoryConfiguration(
                accesses,
                undefined,
                undefined,
                undefined,
                AccessPrecedence.LastAddedWins
            );
        }

        it('downgrades a write access to read when a read is added', () => {
            const ws = new Workspace(last([{ type: AccessType.Write, path: '/a' }]));
            ws.addAccess(AccessType.Read, '/a');
            expect(ws.getAccesses()).toEqual([{ type: AccessType.Read, path: path.resolve('/a') }]);
        });

        it('upgrades a read access to write when a write is added', () => {
            const ws = new Workspace(last([{ type: AccessType.Read, path: '/a' }]));
            ws.addAccess(AccessType.Write, '/a');
            expect(ws.getAccesses()).toEqual([{ type: AccessType.Write, path: path.resolve('/a') }]);
        });

        it('collapses an exact duplicate add', () => {
            const ws = new Workspace(last([{ type: AccessType.Write, path: '/a' }]));
            ws.addAccess(AccessType.Write, '/a');
            expect(ws.getAccesses()).toEqual([{ type: AccessType.Write, path: path.resolve('/a') }]);
        });

        it('keeps other accesses when overriding one path', () => {
            const ws = new Workspace(
                last([
                    { type: AccessType.Write, path: '/a' },
                    { type: AccessType.Write, path: '/b' },
                ])
            );
            ws.addAccess(AccessType.Read, '/a');
            expect(ws.getAccesses()).toEqual(
                expect.arrayContaining([
                    { type: AccessType.Write, path: path.resolve('/b') },
                    { type: AccessType.Read, path: path.resolve('/a') },
                ])
            );
        });

        it('keeps currentPath when it stays inside the accesses after a downgrade', () => {
            const ws = new Workspace(last([{ type: AccessType.Write, path: '/a' }]));
            ws.addAccess(AccessType.Read, '/a');
            expect(ws.currentPath).toBe(path.resolve('/a'));
        });
    });
});

describe('Workspace.removeAccess', () => {
    it('removes the entry', () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Write, path: '/a' },
                { type: AccessType.Write, path: '/b' },
            ],
        ));
        ws.removeAccess('/a');
        expect(ws.getAccesses()).toEqual([{ type: AccessType.Write, path: path.resolve('/b') }]);
    });

    it('throws when it would leave zero accesses', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/a' }]));
        expect(() => ws.removeAccess('/a')).toThrow('At least one access');
    });

    it('tolerates un-resolved paths', () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Write, path: '/a/' },
                { type: AccessType.Write, path: '/b' },
            ],
        ));
        expect(ws.getAccesses()[0]!.path).toBe(path.resolve('/a'));
        ws.removeAccess('/a');
        expect(ws.getAccesses()).toEqual([{ type: AccessType.Write, path: path.resolve('/b') }]);
    });

    it('falls back to workspacePath when currentPath was inside the removed dir', async () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Write, path: '/a' },
                { type: AccessType.Write, path: '/b' },
            ],
            undefined,
            undefined,
            '/a',
        ));
        await ws.switchWorkspace('/b');
        expect(ws.currentPath).toBe('/b');
        ws.removeAccess('/b');
        expect(ws.currentPath).toBe(path.resolve('/a'));
    });

    it('falls back to the first write access when workspacePath is gone', async () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Write, path: '/a' },
                { type: AccessType.Write, path: '/b' },
                { type: AccessType.Write, path: '/c' },
            ],
            undefined,
            undefined,
            '/a',
        ));
        await ws.switchWorkspace('/b/sub');
        ws.removeAccess('/b');
        ws.removeAccess('/a');
        expect(ws.currentPath).toBe(path.resolve('/c'));
    });

    it('falls back to the first remaining access when only read accesses remain', async () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [
                { type: AccessType.Read, path: '/r' },
                { type: AccessType.Write, path: '/a' },
                { type: AccessType.Write, path: '/b' },
            ],
            undefined,
            undefined,
            '/a',
        ));
        await ws.switchWorkspace('/b/sub');
        ws.removeAccess('/b');
        ws.removeAccess('/a');
        expect(ws.currentPath).toBe(path.resolve('/r'));
    });
});

describe('Workspace.setSkipDirs', () => {
    it('sets skip dirs', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/a' }]));
        ws.setSkipDirs(['a', 'b']);
        expect(ws.skipDirs).toEqual(['a', 'b']);
    });
});

describe('Workspace.setResolveSymlinks', () => {
    it('sets resolve symlinks', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/a' }]));
        ws.setResolveSymlinks(true);
        expect(ws.resolveSymlinks).toBe(true);
    });
});

describe('Workspace.setWorkspacePath / workspacePath getter', () => {
    it('returns undefined when never set', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/a' }]));
        expect(ws.workspacePath).toBeUndefined();
    });

    it('sets and resolves the path', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/a' }]));
        ws.setWorkspacePath('/tmp');
        expect(ws.workspacePath).toBe(path.resolve('/tmp'));
    });

    it('clears with undefined', () => {
        const ws = new Workspace(new DirectoryConfiguration([{ type: AccessType.Write, path: '/a' }]));
        ws.setWorkspacePath('/tmp');
        ws.setWorkspacePath(undefined);
        expect(ws.workspacePath).toBeUndefined();
    });
});

describe('Workspace.getConfiguration', () => {
    it('snapshot matches the workspace', () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [{ type: AccessType.Write, path: '/a' }],
            ['node_modules'],
        ));
        ws.setWorkspacePath('/ws');
        const cfg = ws.getConfiguration();
        expect(cfg.accesses).toEqual([{ type: AccessType.Write, path: path.resolve('/a') }]);
        expect(cfg.skipDirs).toEqual(['node_modules']);
        expect(cfg.resolveSymlinks).toBe(false);
        expect(cfg.workspacePath).toBe(path.resolve('/ws'));
        expect(cfg.precedence).toBe(AccessPrecedence.WriteWins);
    });

    it('preserves the precedence mode', () => {
        const ws = new Workspace(
            new DirectoryConfiguration(
                [{ type: AccessType.Write, path: '/a' }],
                undefined,
                undefined,
                undefined,
                AccessPrecedence.LastAddedWins
            )
        );
        expect(ws.getConfiguration().precedence).toBe(AccessPrecedence.LastAddedWins);
    });

    it('returns a defensive copy', () => {
        const ws = new Workspace(new DirectoryConfiguration(
            [{ type: AccessType.Write, path: '/a' }],
            ['node_modules'],
        ));
        const cfg = ws.getConfiguration();
        cfg.accesses.push({ type: AccessType.Read, path: '/x' });
        cfg.skipDirs.push('z');
        expect(ws.getAccesses()).toHaveLength(1);
        expect(ws.skipDirs).toEqual(['node_modules']);
    });
});
