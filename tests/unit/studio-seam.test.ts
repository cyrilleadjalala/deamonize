import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import type { ActiveApplication, ApplicationLocator, AutoAddOutcome, CompileRunner, CompileStatus, PowerInstaller } from '../../src/studio/contracts.js';
import type { RouteFactory } from '../../src/studio/routes/types.js';
import { rawRequest } from '../helpers/http.js';

const fixture = resolve(import.meta.dirname, '../fixtures/env-mcp-server.mjs');

let root: string;
let emptyOut: string;
let readyOut: string;
const handles: StudioHandle[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'daemonize-seam-'));
  emptyOut = join(root, 'empty');
  readyOut = join(root, 'ready');
  await mkdir(emptyOut, { recursive: true });
  await mkdir(readyOut, { recursive: true });
  await writeFile(join(readyOut, 'mcp-server.js'), '// compiled');
  await writeFile(join(readyOut, 'mcp.json'), JSON.stringify({ mcpServers: { app: { command: 'node', args: [fixture] } } }));
});
afterAll(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await rm(root, { recursive: true, force: true });
});

function fakeLocator(initial: string): ApplicationLocator & { dir: string; calls: number } {
  const self = {
    dir: initial,
    calls: 0,
    async current(): Promise<ActiveApplication> {
      self.calls += 1;
      return { slug: 'app', outDir: self.dir, legacy: false };
    },
    async prepareCompile(): Promise<ActiveApplication> {
      return self.current();
    },
  };
  return self;
}

function fakePower(outcome: AutoAddOutcome): PowerInstaller & { runs: number } {
  const refuse = async (): Promise<never> => {
    throw new Error('not used');
  };
  const self = {
    runs: 0,
    info: refuse,
    preview: refuse,
    install: refuse,
    remove: refuse,
    snippet: refuse,
    getAutoAdd: refuse,
    disableAutoAdd: refuse,
    async runAutoAdd(): Promise<AutoAddOutcome> {
      self.runs += 1;
      return outcome;
    },
  };
  return self as unknown as PowerInstaller & { runs: number };
}

async function open(services: Parameters<typeof startStudio>[0] extends infer O ? (O extends { services?: infer S } ? S : never) : never, routes?: RouteFactory[]) {
  const handle = await startStudio({
    workflowFile: join(root, 'workflows.json'),
    outDir: emptyOut,
    token: 'tok',
    services,
    ...(routes === undefined ? {} : { routes }),
    env: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, DAEMONIZE_VAULT_KEY_PROVIDER: 'memory', DAEMONIZE_DATA_DIR: join(root, 'data') },
  });
  handles.push(handle);
  const api = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${handle.port}`, 'x-studio-token': handle.token };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await rawRequest(handle, method, path, headers, payload);
    let parsed: any;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  };
  return api;
}

describe('Studio seam: active output folder', () => {
  it('follows the locator after each load', async () => {
    const locator = fakeLocator(emptyOut);
    const api = await open({ locator });
    expect((await api('GET', '/api/overview')).body.outputCompiled).toBe(false);
    locator.dir = readyOut;
    expect((await api('GET', '/api/overview')).body.outputCompiled).toBe(true);
  });

  it('refreshes after a compile finishes, without any load', async () => {
    const locator = fakeLocator(emptyOut);
    let state: CompileStatus = { state: 'idle', phase: null };
    const compiler: CompileRunner = {
      status: () => state,
      tryStart: () => true,
      runExclusive: async () => ({ ok: true }),
      close: async () => undefined,
    };
    const probe: RouteFactory = (ctx) => [{ path: '/api/seamprobe', remote: 'blocked', handlers: { GET: async () => ({ status: 200, body: ctx.services.compiler.status() }) } }];
    const api = await open({ locator, compiler }, [probe]);
    await api('GET', '/api/seamprobe');
    const before = locator.calls;
    state = { state: 'running', phase: 'generating' };
    await api('GET', '/api/seamprobe');
    expect(locator.calls).toBe(before);
    state = { state: 'done', phase: null };
    await api('GET', '/api/seamprobe');
    await vi.waitFor(() => expect(locator.calls).toBeGreaterThan(before));
  });
});

describe('Studio seam: auto-add hook', () => {
  const call = (api: Awaited<ReturnType<typeof open>>, tool: string) => api('POST', '/api/playground/call', { tool, arguments: {}, confirm: true });

  it('runs once after a success and adds autoAdd when not disabled', async () => {
    const power = fakePower({ status: 'added' });
    const api = await open({ locator: fakeLocator(readyOut), power });
    const res = await call(api, 'whoami');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.autoAdd).toEqual({ status: 'added' });
    expect(power.runs).toBe(1);
  });

  it('leaves the body unchanged when the consent is disabled', async () => {
    const power = fakePower({ status: 'disabled' });
    const api = await open({ locator: fakeLocator(readyOut), power });
    const res = await call(api, 'whoami');
    expect(res.body.success).toBe(true);
    expect(res.body).not.toHaveProperty('autoAdd');
    expect(power.runs).toBe(1);
  });

  it('never runs after a failed call', async () => {
    const power = fakePower({ status: 'added' });
    const api = await open({ locator: fakeLocator(readyOut), power });
    const res = await call(api, 'no_such_tool');
    expect(res.body?.success === true && res.status === 200).toBe(false);
    expect(res.body).not.toHaveProperty('autoAdd');
    expect(power.runs).toBe(0);
  });
});
