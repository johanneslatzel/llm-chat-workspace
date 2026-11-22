import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessType, DirectoryConfiguration, Workspace } from '../../src/index.js';
import {
    WorkspaceBusyError,
    WorkspaceCapacityError,
    WorkspaceNotFoundError,
    WorkspaceStore,
    type WorkspaceSession,
    type WorkspaceSessionFactory
} from '../../src/index.js';

const roots: string[] = [];

function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'llm-chat-store-test-'));
    roots.push(root);
    return root;
}

function makeWorkspace(root: string): Workspace {
    return new Workspace(
        new DirectoryConfiguration([{ type: AccessType.Write, path: root }], [], false, root)
    );
}

function makeSession(id: string, root: string, onDispose?: () => void): WorkspaceSession<string> {
    return {
        id,
        workspace: makeWorkspace(root),
        resource: id,
        dispose: async () => {
            onDispose?.();
            rmSync(root, { recursive: true, force: true });
        }
    };
}

function makeFactory(disposed: string[] = []): WorkspaceSessionFactory<string> {
    return {
        async create(id) {
            const root = makeRoot();
            return makeSession(id, root, () => disposed.push(id));
        }
    };
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
});

describe('WorkspaceStore configuration', () => {
    it('rejects non-positive limits', () => {
        expect(
            () =>
                new WorkspaceStore(
                    { maxTotalBytes: 0, maxBytesPerWorkspace: 1, maxWorkspaces: 1 },
                    makeFactory()
                )
        ).toThrow('maxTotalBytes');
        expect(
            () =>
                new WorkspaceStore(
                    { maxTotalBytes: 10, maxBytesPerWorkspace: 0, maxWorkspaces: 1 },
                    makeFactory()
                )
        ).toThrow('maxBytesPerWorkspace');
        expect(
            () =>
                new WorkspaceStore(
                    { maxTotalBytes: 10, maxBytesPerWorkspace: 1, maxWorkspaces: 0 },
                    makeFactory()
                )
        ).toThrow('maxWorkspaces');
    });

    it('rejects invalid file limits', () => {
        expect(
            () =>
                new WorkspaceStore(
                    {
                        maxTotalBytes: 10,
                        maxBytesPerWorkspace: 1,
                        maxWorkspaces: 1,
                        maxFiles: 0
                    },
                    makeFactory()
                )
        ).toThrow('maxFiles');
        expect(
            () =>
                new WorkspaceStore(
                    {
                        maxTotalBytes: 10,
                        maxBytesPerWorkspace: 1,
                        maxWorkspaces: 1,
                        maxFilesPerWorkspace: 0
                    },
                    makeFactory()
                )
        ).toThrow('maxFilesPerWorkspace');
        expect(
            () =>
                new WorkspaceStore(
                    {
                        maxTotalBytes: 10,
                        maxBytesPerWorkspace: 1,
                        maxWorkspaces: 1,
                        maxFiles: 1,
                        maxFilesPerWorkspace: 2
                    },
                    makeFactory()
                )
        ).toThrow('maxFilesPerWorkspace must not exceed maxFiles');
    });

    it('rejects a per-workspace cap above the total cap', () => {
        expect(
            () =>
                new WorkspaceStore(
                    { maxTotalBytes: 10, maxBytesPerWorkspace: 11, maxWorkspaces: 1 },
                    makeFactory()
                )
        ).toThrow('maxBytesPerWorkspace must not exceed maxTotalBytes');
    });
});

describe('WorkspaceStore lifecycle', () => {
    it('creates a workspace and reports empty usage', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            makeFactory()
        );
        const session = await store.create();
        expect(session.id).toMatch(/[0-9a-f-]{36}/);
        expect(session.resource).toBe(session.id);
        const info = await store.info(session.id);
        expect(info.bytes).toBe(0);
        expect(info.files).toBe(0);
        expect(info.createdAt).toBeGreaterThan(0);
        expect(info.lastUsedAt).toBeGreaterThan(0);
        await store.dispose();
    });

    it('evicts the least recently used workspace on create', async () => {
        const disposed: string[] = [];
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            makeFactory(disposed)
        );
        const first = await store.create();
        const second = await store.create();
        const lease = await store.acquire(first.id);
        lease.release();
        const third = await store.create();

        await expect(store.acquire(second.id)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
        expect(disposed).toContain(second.id);
        const firstLease = await store.acquire(first.id);
        expect(firstLease.id).toBe(first.id);
        firstLease.release();
        const thirdLease = await store.acquire(third.id);
        thirdLease.release();
        await store.dispose();
    });

    it('scans past more recently used entries when choosing an LRU victim', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 3 },
            makeFactory()
        );
        const first = await store.create();
        const second = await store.create();
        const third = await store.create();
        const secondLease = await store.acquire(second.id);
        secondLease.release();
        const thirdLease = await store.acquire(third.id);
        thirdLease.release();

        const fourth = await store.create();
        await expect(store.acquire(first.id)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
        const secondLeaseAgain = await store.acquire(second.id);
        secondLeaseAgain.release();
        const thirdLeaseAgain = await store.acquire(third.id);
        thirdLeaseAgain.release();
        const fourthLease = await store.acquire(fourth.id);
        fourthLease.release();
        await store.dispose();
    });

    it('refuses to create when every workspace is pinned', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 1 },
            makeFactory()
        );
        const session = await store.create();
        const lease = await store.acquire(session.id);
        await expect(store.create()).rejects.toBeInstanceOf(WorkspaceCapacityError);
        lease.release();
        await store.dispose();
    });

    it('deletes an unpinned workspace and ignores unknown ids', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            makeFactory()
        );
        const session = await store.create();
        await expect(store.delete('unknown')).resolves.toBeUndefined();
        await expect(store.delete(session.id)).resolves.toBeUndefined();
        await expect(store.acquire(session.id)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
        await store.dispose();
    });

    it('refuses to delete a pinned workspace', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            makeFactory()
        );
        const session = await store.create();
        const lease = await store.acquire(session.id);
        await expect(store.delete(session.id)).rejects.toBeInstanceOf(WorkspaceBusyError);
        lease.release();
        await store.delete(session.id);
        await store.dispose();
    });

    it('releases a lease idempotently and after disposal', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            makeFactory()
        );
        const session = await store.create();
        const lease = await store.acquire(session.id);
        lease.release();
        lease.release();
        const disposedLease = await store.acquire(session.id);
        await store.dispose();
        disposedLease.release();
        lease.release();
    });

    it('disposes every workspace and swallows cleanup failures', async () => {
        const disposed: string[] = [];
        const cleanStore = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            makeFactory(disposed)
        );
        const first = await cleanStore.create();
        const second = await cleanStore.create();
        await cleanStore.dispose();
        expect(disposed).toEqual(expect.arrayContaining([first.id, second.id]));
        await expect(cleanStore.acquire(first.id)).rejects.toBeInstanceOf(WorkspaceNotFoundError);

        const throwingStore = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            {
                async create(id) {
                    const root = makeRoot();
                    return {
                        id,
                        root,
                        workspace: makeWorkspace(root),
                        resource: id,
                        dispose: async () => {
                            throw new Error('cleanup failed');
                        }
                    };
                }
            }
        );
        const throwingSession = await throwingStore.create();
        await expect(throwingStore.delete(throwingSession.id)).resolves.toBeUndefined();

        const secondThrowingStore = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            {
                async create(id) {
                    const root = makeRoot();
                    return {
                        id,
                        root,
                        workspace: makeWorkspace(root),
                        resource: id,
                        dispose: async () => {
                            throw new Error('cleanup failed');
                        }
                    };
                }
            }
        );
        await secondThrowingStore.create();
        await expect(secondThrowingStore.dispose()).resolves.toBeUndefined();
    });

    it('disposes an evicted workspace when the factory fails', async () => {
        const disposed: string[] = [];
        let calls = 0;
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 1 },
            {
                async create(id) {
                    calls += 1;
                    if (calls === 2) throw new Error('factory failed');
                    const root = makeRoot();
                    return makeSession(id, root, () => disposed.push(id));
                }
            }
        );
        const first = await store.create();
        await expect(store.create()).rejects.toThrow('factory failed');
        expect(disposed).toContain(first.id);
        await store.dispose();
    });
});

describe('WorkspaceStore usage and capacity', () => {
    it('refreshes byte and file usage from the workspace root', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            makeFactory()
        );
        const session = await store.create();
        mkdirSync(join(session.workspace.currentPath, 'nested'));
        writeFileSync(join(session.workspace.currentPath, 'a.txt'), 'hello');
        writeFileSync(join(session.workspace.currentPath, 'nested', 'b.txt'), 'world!');

        const info = await store.info(session.id);
        expect(info.bytes).toBe(11);
        expect(info.files).toBe(2);
        await store.dispose();
    });

    it('returns zero usage when the root disappeared', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            makeFactory()
        );
        const session = await store.create();
        rmSync(session.workspace.currentPath, { recursive: true, force: true });
        await expect(store.refreshUsage(session.id)).resolves.toEqual({ bytes: 0, files: 0 });
        await store.dispose();
    });

    it('rejects usage lookups for unknown ids', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            makeFactory()
        );
        await expect(store.info('unknown')).rejects.toBeInstanceOf(WorkspaceNotFoundError);
        await expect(store.refreshUsage('unknown')).rejects.toBeInstanceOf(WorkspaceNotFoundError);
        await expect(store.ensureCapacity('unknown', 1)).rejects.toBeInstanceOf(
            WorkspaceNotFoundError
        );
        await store.dispose();
    });

    it('returns zero usage when walk throws a direct ENOENT error', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            {
                async create(id) {
                    return {
                        id,
                        workspace: {
                            async *walk() {
                                const shouldThrow = true;
                                if (shouldThrow) {
                                    const error = new Error('missing');
                                    Object.assign(error, { code: 'ENOENT' });
                                    throw error;
                                }
                                yield {
                                    filePath: '/tmp/unreachable',
                                    dirent: { isFile: () => false }
                                };
                            }
                        } as unknown as Workspace,
                        resource: id,
                        dispose: async () => undefined
                    };
                }
            }
        );
        const session = await store.create();
        await expect(store.refreshUsage(session.id)).resolves.toEqual({
            bytes: 0,
            files: 0
        });
        await store.dispose();
    });

    it('rethrows a non-ENOENT scan failure', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            {
                async create(id) {
                    const root = makeRoot();
                    return {
                        id,
                        root,
                        workspace: {
                            async *walk() {
                                const shouldThrow = true;
                                if (shouldThrow) throw new Error('walk failed');
                                yield {
                                    filePath: '/tmp/unreachable',
                                    dirent: { isFile: () => false }
                                };
                            }
                        } as unknown as Workspace,
                        resource: id,
                        dispose: async () => undefined
                    };
                }
            }
        );
        const session = await store.create();
        await expect(store.refreshUsage(session.id)).rejects.toThrow('walk failed');
        await store.dispose();
    });

    it('skips a file that disappears before stat', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            {
                async create(id) {
                    return {
                        id,
                        workspace: {
                            async *walk() {
                                yield {
                                    filePath: '/tmp/does-not-exist-for-stat/file',
                                    dirent: { isFile: () => true }
                                };
                            }
                        } as unknown as Workspace,
                        resource: id,
                        dispose: async () => undefined
                    };
                }
            }
        );
        const session = await store.create();
        await expect(store.refreshUsage(session.id)).resolves.toEqual({ bytes: 0, files: 0 });
        await store.dispose();
    });

    it('accepts a zero delta and rejects invalid deltas', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            makeFactory()
        );
        const session = await store.create();
        await expect(store.ensureCapacity(session.id, 0)).resolves.toBeUndefined();
        await expect(store.ensureCapacity(session.id, -1)).rejects.toThrow(
            'additionalBytes must be a non-negative finite number'
        );
        await expect(store.ensureCapacity(session.id, Number.NaN)).rejects.toThrow(
            'additionalBytes must be a non-negative finite number'
        );
        await expect(store.ensureCapacity(session.id, 0, -1)).rejects.toThrow(
            'additionalFiles must be a non-negative integer'
        );
        await expect(store.ensureCapacity(session.id, 0, 1.5)).rejects.toThrow(
            'additionalFiles must be a non-negative integer'
        );
        await store.dispose();
    });

    it('rejects a write that exceeds the per-workspace cap', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 10, maxWorkspaces: 2 },
            makeFactory()
        );
        const session = await store.create();
        writeFileSync(join(session.workspace.currentPath, 'a.txt'), '12345678');
        await expect(store.ensureCapacity(session.id, 3)).rejects.toBeInstanceOf(
            WorkspaceCapacityError
        );
        await store.dispose();
    });

    it('rejects a write that exceeds the per-workspace file cap', async () => {
        const store = new WorkspaceStore(
            {
                maxTotalBytes: 100,
                maxBytesPerWorkspace: 50,
                maxWorkspaces: 2,
                maxFiles: 10,
                maxFilesPerWorkspace: 2
            },
            makeFactory()
        );
        const session = await store.create();
        writeFileSync(join(session.workspace.currentPath, 'a.txt'), 'a');
        writeFileSync(join(session.workspace.currentPath, 'b.txt'), 'b');
        await expect(store.ensureCapacity(session.id, 0, 1)).rejects.toBeInstanceOf(
            WorkspaceCapacityError
        );
        await store.dispose();
    });

    it('evicts for the global file cap', async () => {
        const store = new WorkspaceStore(
            {
                maxTotalBytes: 100,
                maxBytesPerWorkspace: 50,
                maxWorkspaces: 2,
                maxFiles: 2,
                maxFilesPerWorkspace: 2
            },
            makeFactory()
        );
        const first = await store.create();
        const second = await store.create();
        writeFileSync(join(first.workspace.currentPath, 'a.txt'), 'a');
        writeFileSync(join(second.workspace.currentPath, 'b.txt'), 'b');
        await expect(store.ensureCapacity(second.id, 0, 1)).resolves.toBeUndefined();
        await expect(store.acquire(first.id)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
        await store.dispose();
    });

    it('evicts the least recently used other workspace for a global byte delta', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 20, maxBytesPerWorkspace: 20, maxWorkspaces: 2 },
            makeFactory()
        );
        const first = await store.create();
        const second = await store.create();
        writeFileSync(join(first.workspace.currentPath, 'a.txt'), '0123456789');
        writeFileSync(join(second.workspace.currentPath, 'b.txt'), '0123456789');
        await store.refreshUsage(first.id);
        await store.refreshUsage(second.id);
        const lease = await store.acquire(first.id);
        lease.release();

        await expect(store.ensureCapacity(second.id, 5)).resolves.toBeUndefined();
        await expect(store.acquire(first.id)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
        const secondLease = await store.acquire(second.id);
        secondLease.release();
        await store.dispose();
    });

    it('reports capacity exhaustion when every other candidate is pinned', async () => {
        const store = new WorkspaceStore(
            { maxTotalBytes: 20, maxBytesPerWorkspace: 20, maxWorkspaces: 2 },
            makeFactory()
        );
        const first = await store.create();
        const second = await store.create();
        writeFileSync(join(first.workspace.currentPath, 'a.txt'), '0123456789');
        writeFileSync(join(second.workspace.currentPath, 'b.txt'), '0123456789');
        await store.refreshUsage(first.id);
        await store.refreshUsage(second.id);
        const firstLease = await store.acquire(first.id);
        const secondLease = await store.acquire(second.id);
        await expect(store.ensureCapacity(first.id, 5)).rejects.toBeInstanceOf(
            WorkspaceCapacityError
        );
        firstLease.release();
        secondLease.release();
        await store.dispose();
    });
});

describe('WorkspaceStore factory id', () => {
    it('rejects a factory that returns a different id and disposes it', async () => {
        const dispose = vi.fn(async () => undefined);
        const store = new WorkspaceStore(
            { maxTotalBytes: 100, maxBytesPerWorkspace: 50, maxWorkspaces: 2 },
            {
                async create() {
                    return {
                        id: 'other',
                        workspace: {} as unknown as Workspace,
                        resource: 'x',
                        dispose
                    };
                }
            }
        );
        await expect(store.create()).rejects.toThrow('expected');
        expect(dispose).toHaveBeenCalledTimes(1);
        await store.dispose();
    });
});
