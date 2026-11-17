import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PowerError, type InstallScope } from '../../src/studio/contracts.js';
import { defaultFsOps, type FsOps } from '../../src/studio/power-fs.js';
import { SERVER, createHarness, fullInstall, snapshotTree, writeSettings, type Harness } from '../helpers/power-fixture.js';

const SCOPES: InstallScope[] = ['global', 'project'];

/** Wraps the default file operations; the call numbered `failAt` (1-based) throws. `count` tells how many ran. */
function injecting(failAt: number | undefined): { ops: FsOps; calls: () => number } {
  let n = 0;
  const hit = (): void => {
    n += 1;
    if (n === failAt) throw new Error('injected failure');
  };
  const ops: FsOps = {
    readFile: async (p) => (hit(), defaultFsOps.readFile(p)),
    writeFile: async (p, d, o) => (hit(), defaultFsOps.writeFile(p, d, o)),
    rename: async (a, b) => (hit(), defaultFsOps.rename(a, b)),
    rm: async (p, o) => (hit(), defaultFsOps.rm(p, o)),
    mkdir: async (p) => (hit(), defaultFsOps.mkdir(p)),
    rmdir: async (p) => defaultFsOps.rmdir(p),
    readdir: async (p) => defaultFsOps.readdir(p),
  };
  return { ops, calls: () => n };
}

const rejects = async (p: Promise<unknown>, status: number): Promise<PowerError> => {
  const error = await p.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(PowerError);
  expect((error as PowerError).status).toBe(status);
  return error as PowerError;
};

const kiroOf = (h: Harness, scope: InstallScope): string => (scope === 'global' ? h.kiroGlobal : h.kiroProject);
const previewOf = (h: Harness, scope: InstallScope) => h.installer.preview({ scope, ...(scope === 'project' ? { workspacePath: h.ws } : {}) });

describe('Power_Installer guards, both scopes', () => {
  const harnesses: Harness[] = [];
  const make = async (options?: Parameters<typeof createHarness>[0]): Promise<Harness> => {
    const h = await createHarness(options);
    harnesses.push(h);
    return h;
  };
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.cleanup();
  });

  for (const scope of SCOPES) {
    describe(`scope ${scope}`, () => {
      it('refuses a .kiro link that leaves the allowed area, writing nothing outside', async () => {
        const h = await make();
        const elsewhere = join(h.base, 'elsewhere');
        await mkdir(elsewhere, { recursive: true });
        const root = scope === 'global' ? h.home : h.ws;
        try {
          await symlink(elsewhere, join(root, '.kiro'), 'junction');
        } catch {
          return; // links are not permitted here
        }
        await rejects(previewOf(h, scope), 409);
        expect(await readdir(elsewhere)).toEqual([]);
      });

      it('refuses a settings file that is a link, and leaves the linked file alone', async () => {
        const h = await make();
        await mkdir(join(kiroOf(h, scope), 'settings'), { recursive: true });
        await writeFile(join(h.base, 'real.json'), '{}');
        try {
          await symlink(join(h.base, 'real.json'), join(kiroOf(h, scope), 'settings', 'mcp.json'), 'file');
        } catch {
          return;
        }
        await rejects(previewOf(h, scope), 409);
        expect(await readFile(join(h.base, 'real.json'), 'utf-8')).toBe('{}');
      });

      it('refuses a skill folder that is a link', async () => {
        const h = await make();
        const elsewhere = join(h.base, 'elsewhere');
        await mkdir(elsewhere, { recursive: true });
        await mkdir(join(kiroOf(h, scope), 'skills'), { recursive: true });
        try {
          await symlink(elsewhere, join(kiroOf(h, scope), 'skills', SERVER), 'junction');
        } catch {
          return;
        }
        await rejects(previewOf(h, scope), 409);
        expect(await readdir(elsewhere)).toEqual([]);
      });

      it('refuses a settings file over 2 MiB with 409 and no write', async () => {
        const h = await make();
        await writeSettings(kiroOf(h, scope), JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 10) }));
        const before = await snapshotTree(h.base);
        await rejects(previewOf(h, scope), 409);
        expect(await snapshotTree(h.base)).toEqual(before);
      });

      it('a failure at any write step restores every file, leaves no temporary file and writes no record', async () => {
        const original = JSON.stringify({ mcpServers: { other: { command: 'x' } } });
        // A dry run counts the file operations of a complete install over an existing settings file
        const dry = injecting(undefined);
        const dryRun = await make({ fsOps: dry.ops });
        await writeSettings(kiroOf(dryRun, scope), original);
        await fullInstall(dryRun, scope);
        const total = dry.calls();
        expect(total).toBeGreaterThan(3);
        for (let failAt = 1; failAt <= total; failAt += 1) {
          const inj = injecting(failAt);
          const h = await make({ fsOps: inj.ops });
          await writeSettings(kiroOf(h, scope), original);
          const before = await snapshotTree(h.base);
          const error = await fullInstall(h, scope).then(() => undefined, (e: unknown) => e);
          expect(error, `failAt ${failAt}`).toBeInstanceOf(PowerError);
          expect((error as PowerError).status).toBe(500);
          expect(await snapshotTree(h.base), `failAt ${failAt}`).toEqual(before);
          expect(await h.records.list()).toEqual([]);
        }
      });

      it('a record that cannot be stored undoes the install with a 500', async () => {
        const h = await make({ appDataOk: false });
        const before = await snapshotTree(h.base);
        await rejects(fullInstall(h, scope), 500);
        expect(await snapshotTree(h.base)).toEqual(before);
      });

      it('a failed removal restores everything and keeps the record', async () => {
        const inj = injecting(undefined);
        let failing = false;
        const flaky: FsOps = { ...inj.ops, rm: async (p, o) => { if (failing) throw new Error('injected failure'); return defaultFsOps.rm(p, o); } };
        const h = await make({ fsOps: flaky });
        await writeSettings(kiroOf(h, scope), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
        await fullInstall(h, scope);
        const before = await snapshotTree(h.base);
        failing = true;
        await rejects(h.installer.remove({ scope }), 500);
        expect(await snapshotTree(h.base)).toEqual(before);
        expect(await h.records.list()).toHaveLength(1);
      });
    });
  }

  it('answers 409 when the confirmation does not belong to the requested scope', async () => {
    const h = await make();
    const preview = await previewOf(h, 'global');
    await rejects(h.installer.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope: 'project' }), 409);
    expect(await readdir(h.ws)).toEqual([]);
  });
});
