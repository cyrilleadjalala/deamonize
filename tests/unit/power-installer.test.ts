import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PowerError } from '../../src/studio/contracts.js';
import { sha256 } from '../../src/studio/power-config.js';
import { FAKE_SECRET_VALUE, SERVER, createHarness, fullInstall, snapshotTree, writeSettings, type Harness } from '../helpers/power-fixture.js';
import { removeDir } from '../helpers/cleanup.js';

describe('Power_Installer (fake home)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const rejects = async (p: Promise<unknown>, status: number): Promise<PowerError> => {
    const error = await p.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(PowerError);
    expect((error as PowerError).status).toBe(status);
    return error as PowerError;
  };
  const mcpOf = (kiro: string) => join(kiro, 'settings', 'mcp.json');
  const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf-8')) as { mcpServers: Record<string, any>;[k: string]: unknown };

  it('(a) creates mcp.json with mcpServers as the only key, and the skill, in the global scope', async () => {
    const { preview, result } = await fullInstall(h, 'global');
    expect(preview.kiroPath).toBe(h.kiroGlobal);
    expect(preview.backup).toBe(false);
    expect(result.written).toEqual([mcpOf(h.kiroGlobal), join(h.kiroGlobal, 'skills', SERVER, 'SKILL.md')]);
    const root = await readJson(mcpOf(h.kiroGlobal));
    expect(Object.keys(root)).toEqual(['mcpServers']);
    expect(Object.keys(root.mcpServers)).toEqual([SERVER]);
    expect(root.mcpServers[SERVER].env.DAEMONIZE_SECRET_PASSWORD).toBe('${DAEMONIZE_SECRET_PASSWORD}');
    expect(root.mcpServers[SERVER].env.DAEMONIZE_MODE).toBe('strict');
    expect(root.mcpServers[SERVER].env.DAEMONIZE_DATA_DIR).toBe(h.appDir);
    expect(await readFile(join(h.kiroGlobal, 'skills', SERVER, 'SKILL.md'), 'utf-8')).toContain('Use the tools.');
    expect((await readdir(join(h.kiroGlobal, 'settings'))).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(await h.records.list()).toHaveLength(1);
  });

  it('(b) merges next to at least two other servers and keeps every other key', async () => {
    await writeSettings(h.kiroGlobal, JSON.stringify({ keep: 1, mcpServers: { one: { command: 'a' }, two: { command: 'b' }, three: { command: 'c' } } }));
    const { preview } = await fullInstall(h, 'global');
    expect(preview.files[0]).toEqual({ path: 'settings/mcp.json', outcome: 'merge' });
    expect(preview.backup).toBe(true);
    const root = await readJson(mcpOf(h.kiroGlobal));
    expect(root.keep).toBe(1);
    expect(Object.keys(root.mcpServers)).toEqual(['one', 'two', 'three', SERVER]);
    expect(root.mcpServers.two).toEqual({ command: 'b' });
  });

  it('(c) replaces an entry with the same name and says so in the preview', async () => {
    await writeSettings(h.kiroProject, JSON.stringify({ mcpServers: { other: { command: 'x' }, [SERVER]: { command: 'old' } } }));
    const { preview } = await fullInstall(h, 'project');
    expect(preview.replacesEntry).toBe(true);
    const root = await readJson(mcpOf(h.kiroProject));
    expect(Object.keys(root.mcpServers)).toEqual(['other', SERVER]);
    expect(root.mcpServers[SERVER].command).toBe('node');
  });

  it('(d) answers 409 for invalid settings and leaves every byte unchanged', async () => {
    for (const content of ['{not json', '[]', JSON.stringify({ mcpServers: [] })]) {
      await writeSettings(h.kiroGlobal, content);
      const before = await snapshotTree(h.base);
      await rejects(h.installer.preview({ scope: 'global' }), 409);
      expect(await snapshotTree(h.base)).toEqual(before);
    }
  });

  it('(e) removal with a matching hash restores the backup bytes', async () => {
    const original = '{ "mcpServers": {"other":{"command":"x"}},   "k": 1 }';
    await writeSettings(h.kiroGlobal, original);
    await fullInstall(h, 'global');
    expect(await readFile(mcpOf(h.kiroGlobal) + '.bak', 'utf-8')).toBe(original);
    const out = await h.installer.remove({ scope: 'global' });
    expect(out.removed).toContain(mcpOf(h.kiroGlobal));
    expect(await readFile(mcpOf(h.kiroGlobal), 'utf-8')).toBe(original);
    await expect(readdir(join(h.kiroGlobal, 'skills', SERVER))).rejects.toBeDefined();
    expect(await h.records.list()).toEqual([]);
  });

  it('(f) removal after an outside change keeps the servers that were added later', async () => {
    await writeSettings(h.kiroGlobal, JSON.stringify({ mcpServers: { first: { command: 'a' } } }));
    await fullInstall(h, 'global');
    const root = await readJson(mcpOf(h.kiroGlobal));
    root.mcpServers.later = { command: 'z' };
    await writeFile(mcpOf(h.kiroGlobal), JSON.stringify(root, null, 2));
    await h.installer.remove({ scope: 'global' });
    const after = await readJson(mcpOf(h.kiroGlobal));
    expect(Object.keys(after.mcpServers)).toEqual(['first', 'later']);
    expect(await readdir(join(h.kiroGlobal, 'settings'))).toContain('mcp.json.bak');
  });

  it('(g) no written file holds a secret value', async () => {
    await writeSettings(h.kiroGlobal, JSON.stringify({ mcpServers: {} }));
    await fullInstall(h, 'global');
    await fullInstall(h, 'project');
    for (const dir of [h.kiroGlobal, h.kiroProject]) {
      for (const line of await snapshotTree(dir)) {
        if (!line.endsWith('/')) {
          const file = line.slice(0, line.lastIndexOf(':'));
          expect(await readFile(file, 'utf-8')).not.toContain(FAKE_SECRET_VALUE);
        }
      }
    }
  });

  it('writes nothing on preview and lists the plan', async () => {
    const before = await snapshotTree(h.base);
    const preview = await h.installer.preview({ scope: 'project', workspacePath: h.ws });
    expect(await snapshotTree(h.base)).toEqual(before);
    expect(preview.files).toEqual([
      { path: 'settings/mcp.json', outcome: 'create' },
      { path: `skills/${SERVER}/SKILL.md`, outcome: 'create' },
    ]);
    expect(preview.placeholders).toEqual(['DAEMONIZE_SECRET_PASSWORD', 'DAEMONIZE_SECRET_TOTP']);
    expect(preview.missingSecrets).toEqual(['PASSWORD', 'TOTP']);
    expect(preview.kiroPath.endsWith('.kiro')).toBe(true);
  });

  it('lists the sorted required names in the preview and the install answer, saved or not, and never a value', async () => {
    h.stored.add('PASSWORD');
    const { preview, result } = await fullInstall(h, 'global');
    expect(preview.requiredSecrets).toEqual(['PASSWORD', 'TOTP']);
    expect(result.requiredSecrets).toEqual(['PASSWORD', 'TOTP']);
    expect(preview.missingSecrets).toEqual(['TOTP']);
    for (const name of result.missingSecrets) expect(result.requiredSecrets).toContain(name);
    expect(JSON.stringify([preview, result])).not.toContain(FAKE_SECRET_VALUE);
  });

  it('reports a stored secret as configured and drops its placeholder', async () => {
    h.stored.add('PASSWORD');
    const { preview } = await fullInstall(h, 'global');
    expect(preview.missingSecrets).toEqual(['TOTP']);
    expect(preview.placeholders).toEqual(['DAEMONIZE_SECRET_TOTP']);
  });

  it('treats an unreadable vault as "no value yet" for every name', async () => {
    const broken = await createHarness({ brokenVault: true });
    try {
      const preview = await broken.installer.preview({ scope: 'global' });
      expect(preview.missingSecrets).toEqual(['PASSWORD', 'TOTP']);
    } finally {
      await broken.cleanup();
    }
  });

  it('refuses a bad scope with 400 and bad workspace paths with 400', async () => {
    await rejects(h.installer.preview({ scope: 'both' }), 400);
    await rejects(h.installer.preview({ scope: undefined }), 400);
    for (const bad of [undefined, 5, '', 'relative/path', `${h.ws}\0x`, 'x'.repeat(1100), join(h.base, 'missing')]) {
      await rejects(h.installer.preview({ scope: 'project', workspacePath: bad }), 400);
    }
    await writeFile(join(h.base, 'file.txt'), 'x');
    await rejects(h.installer.preview({ scope: 'project', workspacePath: join(h.base, 'file.txt') }), 400);
    await rejects(h.installer.preview({ scope: 'project', workspacePath: h.out }), 400);
    await mkdir(h.appDir, { recursive: true });
    await rejects(h.installer.preview({ scope: 'project', workspacePath: h.appDir }), 400);
    await mkdir(join(h.base, 'node_modules', 'pkg'), { recursive: true });
    await rejects(h.installer.preview({ scope: 'project', workspacePath: join(h.base, 'node_modules', 'pkg') }), 400);
  });

  it('answers 409 "build first" without a compiled output', async () => {
    await removeDir(h.out);
    await rejects(h.installer.preview({ scope: 'global' }), 409);
    await rejects(h.installer.snippet(), 409);
    expect((await h.installer.info()).available).toBe(false);
  });

  it('gives a snippet with placeholders and the data folder only, and info with the install list', async () => {
    const snippet = await h.installer.snippet();
    expect(snippet).not.toContain(FAKE_SECRET_VALUE);
    const entry = JSON.parse(snippet).mcpServers[SERVER];
    expect(entry.env.DAEMONIZE_MODE).toBe('strict');
    expect(entry.env.DAEMONIZE_DATA_DIR).toBe(h.appDir);
    const before = await h.installer.info();
    expect(before).toMatchObject({ available: true, outputPath: h.out, serverName: SERVER, defaultWorkspace: h.ws, kiroHome: h.kiroGlobal, kiroHomeExists: false, installs: [] });
    await fullInstall(h, 'global');
    const after = await h.installer.info();
    expect(after.kiroHomeExists).toBe(true);
    expect(after.installs).toEqual([{ scope: 'global', slug: SERVER, kiroPath: h.kiroGlobal }]);
  });

  it('mentions the other scope when it is already installed', async () => {
    await fullInstall(h, 'global');
    const preview = await h.installer.preview({ scope: 'project', workspacePath: h.ws });
    expect(preview.otherScopeInstalled).toBe('global');
  });

  it('removing without a record answers 409 and changes nothing', async () => {
    const before = await snapshotTree(h.base);
    await rejects(h.installer.remove({ scope: 'global' }), 409);
    expect(await snapshotTree(h.base)).toEqual(before);
  });

  it('removing when nothing was backed up deletes mcp.json that holds only our entry', async () => {
    await fullInstall(h, 'project');
    await h.installer.remove({ scope: 'project' });
    await expect(readFile(mcpOf(h.kiroProject))).rejects.toBeDefined();
  });

  it('records the hash of the written bytes', async () => {
    await fullInstall(h, 'global');
    const [record] = await h.records.list();
    expect(record?.configSha256).toBe(sha256(await readFile(mcpOf(h.kiroGlobal))));
  });
});
