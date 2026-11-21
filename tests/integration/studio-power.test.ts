import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompileRunner } from '../../src/studio/compile-runner.js';
import { createInstallRecords } from '../../src/studio/install-records.js';
import { createAutoAddStore } from '../../src/studio/auto-add-store.js';
import { createPowerInstaller } from '../../src/studio/power-installer.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { FAKE_SECRET_VALUE, SERVER, writeCompiledOutput } from '../helpers/power-fixture.js';
import { rawRequest } from '../helpers/http.js';
import { removeDir } from '../helpers/cleanup.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

describe('Studio power flow', () => {
  let base: string;
  let handle: StudioHandle | undefined;
  let release: (() => void) | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'studio-power-'));
  });
  afterEach(async () => {
    release?.();
    await handle?.close();
    handle = undefined;
    await removeDir(base);
  });

  const start = async () => {
    const out = join(base, 'out');
    const ws = join(base, 'ws');
    await mkdir(ws, { recursive: true });
    await mkdir(join(base, 'ui'), { recursive: true });
    await writeCompiledOutput(out);
    const gate = new Promise<void>((r) => (release = r));
    const workflowFile = join(base, 'daemonize.workflows.json');
    const compiler = createCompileRunner({
      workflowFile,
      target: async () => ({ outDir: out, slug: 'app' }),
      playground: () => undefined,
      scrub: (t) => t,
      paths: [base],
      compile: (async (_f: string, _o: string, options: { onPhase?: (p: 'installing') => void }) => {
        options.onPhase?.('installing');
        await gate;
        return undefined;
      }) as never,
    } as never);
    handle = await startStudio({
      workflowFile,
      outDir: out,
      staticDir: join(base, 'ui'),
      env: { DAEMONIZE_DATA_DIR: join(base, 'appdata') },
      home: join(base, 'home'),
      services: { compiler },
    });
    const h = handle;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await rawRequest(
        h,
        method,
        path,
        { host: `127.0.0.1:${h.port}`, 'x-studio-token': h.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body === undefined ? undefined : JSON.stringify(body)
      );
      return { status: res.status, json: res.text === '' ? undefined : (JSON.parse(res.text) as Record<string, any>), text: res.text };
    };
    return { call, ws, out };
  };

  it('previews, installs, merges into an existing mcp.json and shows the snippet', async () => {
    const { call, ws, out } = await start();
    const info = await call('GET', '/api/power/info');
    expect(info.json).toMatchObject({ available: true, outputPath: out, serverName: SERVER });

    await mkdir(join(ws, '.kiro', 'settings'), { recursive: true });
    await writeFile(join(ws, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));

    const preview = await call('POST', '/api/power/preview', { scope: 'project', workspacePath: ws });
    expect(preview.status).toBe(200);
    expect(preview.json?.files).toEqual([
      { path: 'settings/mcp.json', outcome: 'merge' },
      { path: `skills/${SERVER}/SKILL.md`, outcome: 'create' },
    ]);
    expect(preview.json?.placeholders).toEqual(['DAEMONIZE_SECRET_PASSWORD', 'DAEMONIZE_SECRET_TOTP']);

    const wrong = await call('POST', '/api/power/install', { confirmationId: preview.json?.confirmationId, kiroPath: 'elsewhere', scope: 'project' });
    expect(wrong.status).toBe(409);

    const done = await call('POST', '/api/power/install', { confirmationId: preview.json?.confirmationId, kiroPath: preview.json?.kiroPath, scope: 'project' });
    expect(done.status).toBe(200);
    expect(done.json?.written).toEqual([join(ws, '.kiro', 'settings', 'mcp.json'), join(ws, '.kiro', 'skills', SERVER, 'SKILL.md')]);
    const merged = JSON.parse(await readFile(join(ws, '.kiro', 'settings', 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(merged.mcpServers)).toEqual(['other', SERVER]);
    expect(JSON.stringify(merged)).not.toContain(FAKE_SECRET_VALUE);
    expect(await readFile(join(ws, '.kiro', 'skills', SERVER, 'SKILL.md'), 'utf-8')).toContain(`name: ${SERVER}`);

    const snippet = await call('GET', '/api/power/snippet');
    expect(snippet.status).toBe(200);
    expect(snippet.text).not.toContain(FAKE_SECRET_VALUE);
    expect(JSON.parse(snippet.json?.snippet as string).mcpServers[SERVER].env.DAEMONIZE_SECRET_PASSWORD).toBe('${DAEMONIZE_SECRET_PASSWORD}');
  });

  it('reports the compile status while a long compile runs and refuses a second start', async () => {
    const { call } = await start();
    expect((await call('GET', '/api/compile/status')).json).toEqual({ state: 'idle', phase: null });
    expect((await call('POST', '/api/compile')).status).toBe(202);
    expect((await call('POST', '/api/compile')).status).toBe(409);
    let status = await call('GET', '/api/compile/status');
    for (let i = 0; i < 50 && status.json?.phase !== 'installing'; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      status = await call('GET', '/api/compile/status');
    }
    expect(status.json).toEqual({ state: 'running', phase: 'installing' });
    release?.();
    for (let i = 0; i < 50 && status.json?.state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      status = await call('GET', '/api/compile/status');
    }
    expect(status.json).toEqual({ state: 'done', phase: null });
  });

  /** G-S: the install route with a power installer that knows the tool risks (the sample set has none). */
  it('installs with Ask before changes on and off, toggles it, refuses a bad value and keeps the bytes on failure', async () => {
    const out = join(base, 'out');
    const ws = join(base, 'ws');
    const home = join(base, 'home');
    const appDir = join(base, 'appdata');
    await mkdir(ws, { recursive: true });
    await mkdir(join(base, 'ui'), { recursive: true });
    await writeCompiledOutput(out);
    const appData = { dir: appDir, ensure: async () => { await mkdir(appDir, { recursive: true }); return { ok: true as const, dir: appDir }; }, check: async () => ({ ok: true as const, dir: appDir }) };
    const power = createPowerInstaller({
      locate: async () => ({ slug: SERVER, outDir: out, legacy: false }),
      cwd: ws, home, appData,
      vault: { names: async () => new Set<string>(), namesFor: async () => new Set<string>() },
      records: createInstallRecords({ appData }), autoAdd: createAutoAddStore({ appData }),
      toolRisks: async () => [{ toolName: 'save', risk: 'write' }, { toolName: 'look', risk: 'read' }],
    });
    handle = await startStudio({ workflowFile: join(base, 'w.json'), outDir: out, staticDir: join(base, 'ui'), env: { DAEMONIZE_DATA_DIR: appDir }, home, services: { power } });
    const h = handle;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await rawRequest(h, method, path, { host: `127.0.0.1:${h.port}`, 'x-studio-token': h.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body === undefined ? undefined : JSON.stringify(body));
      return { status: res.status, json: res.text === '' ? undefined : (JSON.parse(res.text) as Record<string, any>), text: res.text };
    };
    const mcp = join(home, '.kiro', 'settings', 'mcp.json');
    const envOf = async () => (JSON.parse(await readFile(mcp, 'utf-8')) as any).mcpServers[SERVER].env as Record<string, string>;

    const preview = await call('POST', '/api/power/preview', { scope: 'global' });
    expect(preview.json).toMatchObject({ askBeforeChanges: true, askBeforeChangesTools: ['save'] });
    const bad = await call('POST', '/api/power/install', { confirmationId: preview.json?.confirmationId, kiroPath: preview.json?.kiroPath, scope: 'global', askBeforeChanges: 'yes' });
    expect(bad.status).toBe(400);
    await expect(readFile(mcp)).rejects.toThrow();
    const done = await call('POST', '/api/power/install', { confirmationId: preview.json?.confirmationId, kiroPath: preview.json?.kiroPath, scope: 'global' });
    expect(done.json).toMatchObject({ askBeforeChanges: true, askBeforeChangesTools: ['save'] });
    expect(await envOf()).toMatchObject({ DAEMONIZE_ASK_BEFORE_CHANGES: 'true', DAEMONIZE_APPROVAL_TIMEOUT_MS: '90000' });
    expect((await call('GET', '/api/power/info')).json?.installs[0]).toMatchObject({ askBeforeChanges: true });

    const off = await call('POST', '/api/power/approval', { scope: 'global', askBeforeChanges: false });
    expect(off).toMatchObject({ status: 200, json: { scope: 'global', askBeforeChanges: false } });
    expect((await envOf()).DAEMONIZE_ASK_BEFORE_CHANGES).toBe('false');
    expect((await call('GET', '/api/power/info')).json?.installs[0]).toMatchObject({ askBeforeChanges: false });
    const on = await call('POST', '/api/power/approval', { scope: 'global', askBeforeChanges: true });
    expect(on.status).toBe(200);
    expect((await envOf()).DAEMONIZE_APPROVAL_TIMEOUT_MS).toBe('90000');

    const bytes = await readFile(mcp);
    for (const body of [{ scope: 'global', askBeforeChanges: 'true' }, { scope: 'global' }, { scope: 'global', askBeforeChanges: true, extra: 1 }, { scope: 'nowhere', askBeforeChanges: true }]) {
      expect((await call('POST', '/api/power/approval', body)).status).toBe(400);
    }
    expect((await call('GET', '/api/power/approval')).status).toBe(405);
    expect((await call('POST', '/api/power/approval', { scope: 'project', askBeforeChanges: true })).status).toBe(409);
    expect((await readFile(mcp)).equals(bytes)).toBe(true);
  });
});
