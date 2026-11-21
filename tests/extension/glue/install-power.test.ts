// checkpoint-only: needs G-P
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __script } from '../fake-vscode';
import { createHarness } from './harness';
import { S } from '../../../kiro-extension/src/core/strings';
import { startStudio, type StudioHandle } from '../../../src/studio/server.js';
import { rawRequest } from '../../helpers/http.js';
import { removeDir } from '../../helpers/cleanup.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

describe('daemonize.installPower and daemonize.removePower against the real Studio routes', () => {
  let dir: string;
  let studio: StudioHandle;
  let settingsFile: string;
  const EARLIER = JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2);

  const call = (method: string, path: string, body?: unknown) =>
    rawRequest(studio, method, path, { host: `127.0.0.1:${studio.port}`, 'x-studio-token': studio.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body === undefined ? undefined : JSON.stringify(body));
  const answer = async (res: Promise<{ status: number; body: string }>) => {
    const r = await res;
    return { status: r.status, body: r.body === '' ? {} : JSON.parse(r.body) };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-install-power-'));
    await mkdir(join(dir, 'ui'), { recursive: true });
    await mkdir(join(dir, 'home', '.kiro', 'settings'), { recursive: true });
    settingsFile = join(dir, 'home', '.kiro', 'settings', 'mcp.json');
    await writeFile(settingsFile, EARLIER);
    studio = await startStudio({
      workflowFile: join(dir, 'w.json'), outDir: join(dir, 'out'), staticDir: join(dir, 'ui'),
      env: { DAEMONIZE_DATA_DIR: join(dir, 'appdata') }, home: join(dir, 'home'),
    });
  });
  afterAll(async () => {
    await studio.close();
    await removeDir(dir);
  });

  function arrange() {
    const h = createHarness({ powerInfo: async () => ({ ok: true, status: 200, data: { kiroHomeExists: true, installs: [], available: true } }) });
    const client = h.manager.session!.client as { get: unknown; post: unknown };
    client.get = (path: string) => answer(call('GET', path));
    client.post = (path: string, body: Record<string, unknown>) => answer(call('POST', path, body));
    return h;
  }
  beforeEach(() => { /* each test arranges its own harness */ });

  it('installs then removes, and the settings return to their earlier content', async () => {
    const h = arrange();
    __script({
      'window.showQuickPick': [{ label: S.scopeGlobal, scope: 'global' }, { label: S.scopeGlobal, scope: 'global' }],
      'window.showWarningMessage': [S.installPower, S.removePower],
      'window.showInformationMessage': [undefined],
    });
    await h.run('daemonize.installPower');
    expect(await readFile(settingsFile, 'utf-8')).toContain('daemonize-studio');
    await h.run('daemonize.removePower');
    expect(JSON.parse(await readFile(settingsFile, 'utf-8'))).toEqual(JSON.parse(EARLIER));
  });

  it('changes nothing when the user declines the plan', async () => {
    const h = arrange();
    __script({
      'window.showQuickPick': [{ label: S.scopeGlobal, scope: 'global' }],
      'window.showWarningMessage': [undefined],
    });
    await h.run('daemonize.installPower');
    expect(await readFile(settingsFile, 'utf-8')).toBe(EARLIER);
  });
});
