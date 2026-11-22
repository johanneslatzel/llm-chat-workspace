import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { symlinkSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { DirectoryConfiguration } from '../../src/lib/config.js';
import { Workspace } from '../../src/lib/workspace.js';
import { AccessType } from '../../src/lib/types.js';
import { withTempDir } from '../helper/temp-fs.js';

describe('Workspace.walk', () => {
    it('returns no entries for unreadable path', async () => {
        await withTempDir(async (dir) => {
            const ws = new Workspace(
                new DirectoryConfiguration([{ type: AccessType.Write, path: dir }])
            );
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

            const ws = new Workspace(
                new DirectoryConfiguration([{ type: AccessType.Read, path: allowed }])
            );
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

            const ws = new Workspace(
                new DirectoryConfiguration([{ type: AccessType.Read, path: allowed }])
            );
            const entries: Array<{ filePath: string; dirent: import('node:fs').Dirent }> = [];
            for await (const entry of ws.walk(allowed)) {
                entries.push(entry);
            }
            const filePaths = entries.map((e) => e.filePath);
            expect(filePaths).toContain(path.join(allowed, 'subdir'));
            expect(filePaths).toContain(path.join(allowed, 'subdir', 'nested.txt'));
        });
    });

    it('throws when the root path does not exist', async () => {
        await withTempDir(async (dir) => {
            const ws = new Workspace(
                new DirectoryConfiguration([{ type: AccessType.Write, path: dir }])
            );
            const missing = path.join(dir, 'missing');
            const entries: Array<{ filePath: string; dirent: import('node:fs').Dirent }> = [];
            const collect = async (): Promise<void> => {
                for await (const entry of ws.walk(missing)) {
                    entries.push(entry);
                }
            };
            await expect(collect).rejects.toThrow('Cannot walk');
            await expect(collect).rejects.toThrow('the path does not exist');
            expect(entries).toHaveLength(0);
        });
    });

    it('throws when the root path is a file', async () => {
        await withTempDir(async (dir) => {
            const ws = new Workspace(
                new DirectoryConfiguration([{ type: AccessType.Write, path: dir }])
            );
            const file = path.join(dir, 'file.txt');
            writeFileSync(file, 'data');
            const entries: Array<{ filePath: string; dirent: import('node:fs').Dirent }> = [];
            const collect = async (): Promise<void> => {
                for await (const entry of ws.walk(file)) {
                    entries.push(entry);
                }
            };
            await expect(collect).rejects.toThrow('it is a file, not a directory');
            await expect(collect).rejects.toThrow(file);
            expect(entries).toHaveLength(0);
        });
    });

    it('reports the underlying stat error when the root cannot be stat-ed', async () => {
        await withTempDir(async (dir) => {
            const ws = new Workspace(
                new DirectoryConfiguration([{ type: AccessType.Write, path: dir }])
            );
            const blocker = path.join(dir, 'blocker.txt');
            writeFileSync(blocker, 'data');
            const through = path.join(blocker, 'child');
            const entries: Array<{ filePath: string; dirent: import('node:fs').Dirent }> = [];
            const collect = async (): Promise<void> => {
                for await (const entry of ws.walk(through)) {
                    entries.push(entry);
                }
            };
            await expect(collect).rejects.toThrow('Cannot walk');
            await expect(collect).rejects.toThrow(/ENOTDIR|not a directory/i);
            expect(entries).toHaveLength(0);
        });
    });

    it('invokes onError when a nested directory cannot be read', async () => {
        await withTempDir(async (dir) => {
            const allowed = path.join(dir, 'allowed');
            const locked = path.join(allowed, 'locked');
            mkdirSync(path.join(allowed, 'ok'), { recursive: true });
            mkdirSync(locked, { recursive: true });
            writeFileSync(path.join(allowed, 'ok', 'fine.txt'), 'fine');
            chmodSync(locked, 0o000);
            try {
                const errors: Array<{ dirPath: string; error: Error }> = [];
                const ws = new Workspace(
                    new DirectoryConfiguration([{ type: AccessType.Write, path: dir }])
                );
                const entries: Array<{ filePath: string; dirent: import('node:fs').Dirent }> = [];
                for await (const entry of ws.walk(allowed, (dirPath, error) => {
                    errors.push({ dirPath, error });
                })) {
                    entries.push(entry);
                }
                expect(errors).toHaveLength(1);
                expect(errors[0]!.dirPath).toBe(locked);
                expect(errors[0]!.error).toBeInstanceOf(Error);
                const filePaths = entries.map((e) => e.filePath);
                expect(filePaths).toContain(path.join(allowed, 'ok'));
                expect(filePaths).toContain(path.join(allowed, 'ok', 'fine.txt'));
            } finally {
                chmodSync(locked, 0o755);
            }
        });
    });

    it('skips directories listed in skipDirs', async () => {
        await withTempDir(async (dir) => {
            const allowed = path.join(dir, 'allowed');
            mkdirSync(path.join(allowed, 'node_modules'), { recursive: true });
            writeFileSync(path.join(allowed, 'node_modules', 'dep.txt'), 'data');
            writeFileSync(path.join(allowed, 'keep.txt'), 'keep');

            const ws = new Workspace(
                new DirectoryConfiguration(
                    [{ type: AccessType.Read, path: allowed }],
                    ['node_modules']
                )
            );
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
