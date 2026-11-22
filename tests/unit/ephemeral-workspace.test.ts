import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EphemeralWorkspaceProvisioner } from '../../src/index.js';

const roots: string[] = [];

function makeBaseDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'llm-chat-ephemeral-test-'));
    roots.push(dir);
    return dir;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
});

describe('EphemeralWorkspaceProvisioner', () => {
    it('creates a private root and a workspace restricted to it', async () => {
        const baseDir = makeBaseDir();
        const provisioner = new EphemeralWorkspaceProvisioner({ baseDir });
        const first = await provisioner.create();
        const second = await provisioner.create();

        const realBase = realpathSync(baseDir);
        expect(first.workspace.currentPath.startsWith(realBase)).toBe(true);
        expect(second.workspace.currentPath).not.toBe(first.workspace.currentPath);
        expect(existsSync(first.workspace.currentPath)).toBe(true);
        expect(statSync(first.workspace.currentPath).mode & 0o777).toBe(0o700);
        expect(first.workspace.canWrite(join(first.workspace.currentPath, 'file.svg'))).toBe(true);
        expect(first.workspace.canWrite(join(tmpdir(), 'outside.svg'))).toBe(false);
        expect(first.workspace.skipDirs).toEqual([]);
        expect(first.workspace.resolveSymlinks).toBe(true);

        await first.dispose();
        await second.dispose();
        expect(existsSync(first.workspace.currentPath)).toBe(false);
        expect(existsSync(second.workspace.currentPath)).toBe(false);
    });

    it('honours a symlink resolution override', async () => {
        const baseDir = makeBaseDir();
        const provisioner = new EphemeralWorkspaceProvisioner({
            baseDir,
            resolveSymlinks: false
        });
        const workspace = await provisioner.create();
        expect(workspace.workspace.resolveSymlinks).toBe(false);
        await workspace.dispose();
    });

    it('uses the default temp base directory when none is supplied', async () => {
        const provisioner = new EphemeralWorkspaceProvisioner();
        expect(provisioner.directory).toContain('llm-chat-workspace');
        expect(provisioner.directory).toContain(`pid-${process.pid}`);
        const workspace = await provisioner.create();
        expect(existsSync(workspace.workspace.currentPath)).toBe(true);
        await workspace.dispose();
    });

    it('resolves the base directory and creates it on demand', async () => {
        const baseDir = join(makeBaseDir(), 'nested', 'base');
        const provisioner = new EphemeralWorkspaceProvisioner({ baseDir });
        expect(provisioner.directory).toBe(baseDir);
        const workspace = await provisioner.create();
        expect(existsSync(baseDir)).toBe(true);
        await workspace.dispose();
    });
});
