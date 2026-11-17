import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PowerError } from '../../src/studio/contracts.js';
import { createPowerInstaller } from '../../src/studio/power-installer.js';
import { FAKE_SECRET_VALUE, SERVER, writeCompiledOutput } from '../helpers/power-fixture.js';
import { removeDir } from '../helpers/cleanup.js';

describe('Power_Installer', () => {
  let base: string;
  let out: string;
  let ws: string;
  let appDir: string;
  let now = 1_000_000;
  const installer = () =>
    createPowerInstaller({ outDir: out, cwd: ws, appData: { dir: appDir, ensure: async () => ({ ok: false, problem: 'unresolved' }), check: async () => ({ ok: false, problem: 'unresolved' }) }, now: () => now } as never);

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'power-'));
    out = join(base, 'out');
    ws = join(base, 'ws');
    appDir = join(base, 'appdata');
    await mkdir(ws, { recursive: true });
    await writeCompiledOutput(out);
    now = 1_000_000;
  });
  afterEach(async () => {
    await removeDir(base);
  });

  const snapshot = async (dir: string): Promise<string[]> => {
    const names: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else names.push(`${p}:${(await readFile(p)).toString('hex')}`);
      }
    };
    await walk(dir);
    return names.sort();
  };
  const rejects = async (p: Promise<unknown>, status: number): Promise<PowerError> => {
    const error = await p.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(PowerError);
    expect((error as PowerError).status).toBe(status);
    return error as PowerError;
  };

  it('writes nothing on preview and lists the plan', async () => {
    const before = await snapshot(base);
    const preview = await installer().preview(ws);
    expect(await snapshot(base)).toEqual(before);
    expect(preview.files).toEqual([
      { path: 'settings/mcp.json', outcome: 'create' },
      { path: `skills/${SERVER}/SKILL.md`, outcome: 'create' },
    ]);
    expect(preview.placeholders).toEqual(['DAEMONIZE_SECRET_PASSWORD', 'DAEMONIZE_SECRET_TOTP']);
    expect(preview.replacesEntry).toBe(false);
    expect(preview.kiroPath.endsWith('.kiro')).toBe(true);
  });

  it('refuses an install without a matching id and path, and each id works once', async () => {
    const power = installer();
    const preview = await power.preview(ws);
    await rejects(power.install({ confirmationId: 'nope', kiroPath: preview.kiroPath }), 400);
    await rejects(power.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath + 'x' }), 400);
    await rejects(power.install({ confirmationId: 5, kiroPath: preview.kiroPath }), 400);
    expect(await readdir(ws)).toEqual([]);
    const fresh = await power.preview(ws);
    await power.install({ confirmationId: fresh.confirmationId, kiroPath: fresh.kiroPath });
    await rejects(power.install({ confirmationId: fresh.confirmationId, kiroPath: fresh.kiroPath }), 400);
  });

  it('refuses an expired confirmation', async () => {
    const power = installer();
    const preview = await power.preview(ws);
    now += 11 * 60 * 1000;
    await rejects(power.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath }), 400);
  });

  it('installs placeholders only, merges other entries and reports a replacement', async () => {
    const settings = join(ws, '.kiro', 'settings', 'mcp.json');
    await mkdir(join(ws, '.kiro', 'settings'), { recursive: true });
    await writeFile(
      settings,
      JSON.stringify({ keep: 1, mcpServers: { other: { command: 'x' }, [SERVER]: { command: 'old' }, last: { command: 'z' } } })
    );
    const power = installer();
    const preview = await power.preview(ws);
    expect(preview.replacesEntry).toBe(true);
    expect(preview.files[0]?.outcome).toBe('merge');
    const result = await power.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath });
    expect(result.written).toEqual(['settings/mcp.json', `skills/${SERVER}/SKILL.md`]);
    const text = await readFile(settings, 'utf-8');
    expect(text).not.toContain(FAKE_SECRET_VALUE);
    const merged = JSON.parse(text) as { keep: number; mcpServers: Record<string, { command: string; env?: Record<string, string> }> };
    expect(merged.keep).toBe(1);
    expect(Object.keys(merged.mcpServers)).toEqual(['other', SERVER, 'last']);
    expect(merged.mcpServers.other).toEqual({ command: 'x' });
    expect(merged.mcpServers[SERVER]?.command).toBe('node');
    expect(merged.mcpServers[SERVER]?.env?.DAEMONIZE_SECRET_PASSWORD).toBe('${DAEMONIZE_SECRET_PASSWORD}');
    expect(await readFile(join(ws, '.kiro', 'skills', SERVER, 'SKILL.md'), 'utf-8')).toContain('Use the tools.');
    expect((await readdir(join(ws, '.kiro', 'settings'))).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('answers 409 and leaves an unreadable mcp.json byte-identical', async () => {
    await mkdir(join(ws, '.kiro', 'settings'), { recursive: true });
    for (const content of ['{not json', '[]', JSON.stringify({ mcpServers: [] })]) {
      await writeFile(join(ws, '.kiro', 'settings', 'mcp.json'), content);
      const before = await snapshot(base);
      await rejects(installer().preview(ws), 409);
      expect(await snapshot(base)).toEqual(before);
    }
  });

  it('refuses bad workspace paths with 400', async () => {
    const power = installer();
    for (const bad of [undefined, 5, '', 'relative/path', `${ws}\0x`, 'x'.repeat(1100), join(base, 'missing')]) await rejects(power.preview(bad), 400);
    await writeFile(join(base, 'file.txt'), 'x');
    await rejects(power.preview(join(base, 'file.txt')), 400);
    await rejects(power.preview(out), 400);
    await rejects(power.preview(join(out, 'skills')), 400);
    await mkdir(appDir, { recursive: true });
    await rejects(power.preview(appDir), 400);
    await mkdir(join(base, 'node_modules', 'pkg'), { recursive: true });
    await rejects(power.preview(join(base, 'node_modules', 'pkg')), 400);
  });

  it('refuses a .kiro that points outside, and a target that is a link', async () => {
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    try {
      await symlink(elsewhere, join(ws, '.kiro'), 'junction');
    } catch {
      return; // links are not permitted here
    }
    await rejects(installer().preview(ws), 400);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('refuses a settings file that is a link', async () => {
    await mkdir(join(ws, '.kiro', 'settings'), { recursive: true });
    await writeFile(join(base, 'real.json'), '{}');
    try {
      await symlink(join(base, 'real.json'), join(ws, '.kiro', 'settings', 'mcp.json'), 'file');
    } catch {
      return;
    }
    await rejects(installer().preview(ws), 400);
    expect(await readFile(join(base, 'real.json'), 'utf-8')).toBe('{}');
  });

  it('answers 409 "compile first" without a compiled output', async () => {
    await removeDir(out);
    const power = installer();
    await rejects(power.preview(ws), 409);
    await rejects(power.snippet(), 409);
    expect((await power.info()).available).toBe(false);
  });

  it('gives a snippet with placeholders only, and info with the output path', async () => {
    const power = installer();
    const snippet = await power.snippet();
    expect(snippet).not.toContain(FAKE_SECRET_VALUE);
    expect(JSON.parse(snippet).mcpServers[SERVER].env.DAEMONIZE_MODE).toBe('strict');
    expect(await power.info()).toMatchObject({ available: true, outputPath: out, serverName: SERVER, defaultWorkspace: ws });
  });
});
