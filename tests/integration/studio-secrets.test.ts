import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { rawRequest } from '../helpers/http.js';

const fixture = resolve(import.meta.dirname, '../fixtures/env-mcp-server.mjs');
const VALUE_1 = 'First-Planted-Value-3e91';
const VALUE_2 = 'Second-Planted-Value-8b02';
const hash = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12);

const set = {
  version: '1', targetType: 'web', targetName: 'App', startUrl: 'https://app.example',
  workflows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'Log in', variables: [], observedPayloads: [{}], steps: [{ actionType: 'type', selectors: [], secretRef: 'PW' }, { actionType: 'type', selectors: [], secretRef: 'OTP', totp: true }] }],
} as unknown as WorkflowSet;

let root: string;
const handles: StudioHandle[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'daemonize-ss-'));
  await mkdir(join(root, 'out'), { recursive: true });
  await writeFile(join(root, 'workflows.json'), serializeWorkflowSet(set));
  await writeFile(join(root, 'out', 'mcp.json'), JSON.stringify({ mcpServers: { app: { command: 'node', args: [fixture], env: { DAEMONIZE_SECRET_PW: '${DAEMONIZE_SECRET_PW}' } } } }));
});
afterAll(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await rm(root, { recursive: true, force: true });
});

async function open(provider: string, dataName: string): Promise<{ handle: StudioHandle; api: (m: string, p: string, body?: unknown, raw?: { text: string; type: string }) => Promise<{ status: number; body: any; text: string; headers: Record<string, unknown> }>; data: string }> {
  const data = join(root, dataName);
  const handle = await startStudio({
    workflowFile: join(root, 'workflows.json'),
    outDir: join(root, 'out'),
    token: 'tok',
    env: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, DAEMONIZE_VAULT_KEY_PROVIDER: provider, DAEMONIZE_DATA_DIR: data },
  });
  handles.push(handle);
  const api = async (method: string, path: string, body?: unknown, raw?: { text: string; type: string }) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${handle.port}`, 'x-studio-token': handle.token };
    let payload: string | undefined;
    if (raw !== undefined) {
      payload = raw.text;
      headers['content-type'] = raw.type;
    } else if (body !== undefined) {
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
    return { status: res.status, body: parsed, text: res.text, headers: res.headers };
  };
  return { handle, api, data };
}

describe('Studio secrets flow', () => {
  it('saves, lists, replaces and forgets a credential, and the server picks up each change', async () => {
    const { api, data } = await open('memory', 'data-flow');
    const responses: string[] = [];
    const track = async (...args: Parameters<typeof api>) => {
      const res = await api(...args);
      responses.push(res.text);
      return res;
    };

    const first = await track('GET', '/api/secrets');
    expect(first.status).toBe(200);
    expect(first.body.secrets).toEqual([{ name: 'OTP', kind: 'totp', configured: false }, { name: 'PW', kind: 'password', configured: false }]);
    expect((await track('POST', '/api/playground/call', { tool: 'whoami', arguments: {}, confirm: true })).body.text).toBe('none');

    const saved = await track('POST', '/api/secrets', { name: 'PW', value: VALUE_1 });
    expect(saved.body).toEqual({ name: 'PW', configured: true });
    expect((await track('GET', '/api/secrets')).body.secrets.find((s: any) => s.name === 'PW').configured).toBe(true);
    expect((await track('POST', '/api/playground/call', { tool: 'whoami', arguments: {}, confirm: true })).body.text).toBe(hash(VALUE_1));

    await track('POST', '/api/secrets', { name: 'PW', value: VALUE_2 });
    expect((await track('POST', '/api/playground/call', { tool: 'whoami', arguments: {}, confirm: true })).body.text).toBe(hash(VALUE_2));

    expect((await track('POST', '/api/secrets/forget', { name: 'PW' })).body).toEqual({ name: 'PW', configured: false });
    expect((await track('POST', '/api/playground/call', { tool: 'whoami', arguments: {}, confirm: true })).body.text).toBe('none');

    for (const text of responses) {
      expect(text).not.toContain(VALUE_1);
      expect(text).not.toContain(VALUE_2);
    }
    for (const name of await readdir(data)) expect(await readFile(join(data, name), 'utf-8')).not.toContain(VALUE_2);
  });

  it('leaves the vault unchanged when a guard refuses the request', async () => {
    const { api, data } = await open('memory', 'data-guards');
    await api('POST', '/api/secrets', { name: 'PW', value: VALUE_1 });
    const before = await readFile(join(data, 'secrets.vault.json'), 'utf-8');
    expect((await api('POST', '/api/secrets', undefined, { text: 'name=PW', type: 'text/plain' })).status).toBe(415);
    expect((await api('PUT', '/api/secrets', { name: 'PW', value: VALUE_2 })).status).toBe(405);
    expect((await api('POST', '/api/secrets', { name: '../PW', value: VALUE_2 })).status).toBe(400);
    expect((await api('POST', '/api/secrets', undefined, { text: '{"name":"PW","value":"' + 'x'.repeat(70000) + '"}', type: 'application/json' })).status).toBe(413);
    expect(await readFile(join(data, 'secrets.vault.json'), 'utf-8')).toBe(before);
  });

  it('answers 503 and writes nothing when the key store is unavailable', async () => {
    const { api, data } = await open('unavailable', 'data-503');
    const res = await api('POST', '/api/secrets', { name: 'PW', value: VALUE_1 });
    expect(res.status).toBe(503);
    expect(res.text).not.toContain(VALUE_1);
    await expect(readFile(join(data, 'secrets.vault.json'))).rejects.toThrow();
    expect((await api('GET', '/api/secrets')).status).toBe(200);
  });
});
