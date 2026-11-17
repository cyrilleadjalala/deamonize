import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { rawRequest } from '../helpers/http.js';
import { removeDir } from '../helpers/cleanup.js';

const FIVE = ['/api/overview', '/api/workflows', '/api/graph', '/api/schemas', '/api/pbt'];

const set: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: 'Demo',
  startUrl: 'http://localhost:8080/',
  workflows: [{ id: '34343434-3434-4434-8434-343434343434', label: 'Do it', steps: [{ actionType: 'click', selectors: ['#go'], label: 'Go', anchor: { role: 'button', name: 'Go', frame: [] } }], variables: [], observedPayloads: [{}] }],
};

describe('Studio empty start', () => {
  let dir: string;
  let handle: StudioHandle;
  let logged: string[];
  let restore: Array<() => void> = [];

  const get = (path: string) => rawRequest(handle, 'GET', path, { host: `127.0.0.1:${handle.port}`, 'x-studio-token': handle.token });
  const json = async (path: string) => JSON.parse((await get(path)).text);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'empty-start-'));
    logged = [];
    for (const name of ['log', 'warn', 'error'] as const) {
      const original = console[name];
      console[name] = (...args: unknown[]) => void logged.push(args.join(' '));
      restore.push(() => {
        console[name] = original;
      });
    }
    handle = await startStudio({ workflowFile: join(dir, 'daemonize.workflows.json'), outDir: join(dir, 'daemonize-out'), env: {} });
  });
  afterAll(async () => {
    restore.forEach((r) => r());
    await handle.close();
    await removeDir(dir);
  });

  it('writes nothing to the console and creates no Output_Dir when it starts', () => {
    expect(logged).toEqual([]);
    expect(existsSync(join(dir, 'daemonize-out'))).toBe(false);
    expect(existsSync(join(dir, 'daemonize.workflows.json'))).toBe(false);
  });

  it('answers the five data routes with 200 and zero actions, for GET and HEAD', async () => {
    for (const path of FIVE) {
      expect((await get(path)).status, path).toBe(200);
      expect((await rawRequest(handle, 'HEAD', path, { host: `127.0.0.1:${handle.port}`, 'x-studio-token': handle.token })).status, path).toBe(200);
    }
    expect(await json('/api/overview')).toMatchObject({ targets: [], workflowFileExists: false, outputCompiled: false, recordingActive: false });
    expect((await json('/api/workflows')).workflows).toEqual([]);
    expect(await json('/api/graph')).toMatchObject({ nodes: [], edges: [] });
    expect(await json('/api/pbt')).toMatchObject({ available: false, running: false });
    expect(existsSync(join(dir, 'daemonize-out'))).toBe(false);
  });

  it('keeps the old 404 for unknown api paths', async () => {
    expect((await get('/api/nothing-here')).status).toBe(404);
  });

  it('reflects a new file, a compiled output and a bad file without a restart, and recovers', async () => {
    const file = join(dir, 'daemonize.workflows.json');
    await writeFile(file, serializeWorkflowSet(set));
    expect((await json('/api/workflows')).workflows).toHaveLength(1);
    expect(await json('/api/overview')).toMatchObject({ workflowFileExists: true, outputCompiled: false });

    await mkdir(join(dir, 'daemonize-out'), { recursive: true });
    await writeFile(join(dir, 'daemonize-out', 'mcp-server.js'), '// compiled');
    expect(await json('/api/overview')).toMatchObject({ outputCompiled: true });

    await writeFile(file, '{ not json');
    for (const path of FIVE) {
      const r = await get(path);
      expect(r.status, path).toBe(500);
      expect(JSON.parse(r.text)).toEqual({ error: 'workflow file is not a valid workflow set' });
      expect(r.text).not.toContain(dir);
    }
    await writeFile(file, serializeWorkflowSet(set));
    expect((await get('/api/workflows')).status).toBe(200);
  });

  it('refuses an oversized workflow file with the fixed message', async () => {
    await writeFile(join(dir, 'daemonize.workflows.json'), Buffer.alloc(20 * 1024 * 1024 + 1, 0x20));
    const r = await get('/api/overview');
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text)).toEqual({ error: 'workflow file is too large' });
  });
});
