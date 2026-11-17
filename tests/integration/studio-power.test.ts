import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompileRunner } from '../../src/studio/compile-runner.js';
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
      outDir: out,
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

    const preview = await call('POST', '/api/power/preview', { workspacePath: ws });
    expect(preview.status).toBe(200);
    expect(preview.json?.files).toEqual([
      { path: 'settings/mcp.json', outcome: 'merge' },
      { path: `skills/${SERVER}/SKILL.md`, outcome: 'create' },
    ]);
    expect(preview.json?.placeholders).toEqual(['DAEMONIZE_SECRET_PASSWORD', 'DAEMONIZE_SECRET_TOTP']);

    const wrong = await call('POST', '/api/power/install', { confirmationId: preview.json?.confirmationId, kiroPath: 'elsewhere' });
    expect(wrong.status).toBe(400);

    const done = await call('POST', '/api/power/install', { confirmationId: preview.json?.confirmationId, kiroPath: preview.json?.kiroPath });
    expect(done.status).toBe(200);
    expect(done.json?.written).toEqual(['settings/mcp.json', `skills/${SERVER}/SKILL.md`]);
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
});
