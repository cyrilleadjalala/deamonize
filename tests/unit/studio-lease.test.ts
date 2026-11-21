import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { isLoopbackOrigin, leasePath, parseLease, readLease, workspaceKey, writeLease, type StudioLease } from '../../src/studio/lease';
import { StudioConnection } from '../../src/studio/mcp/connection';
import { startFakeStudio, type FakeStudio } from '../helpers/fake-studio';

let root: string;
let dataDir: string;
let workspace: string;
const alive = { isAlive: () => true, health: async () => true };

const sample = (patch: Partial<StudioLease> = {}): StudioLease => ({
  v: 1,
  origin: 'http://127.0.0.1:4555',
  agentToken: 'agent-token-0123456789',
  pid: process.pid,
  workspace: workspaceKey(workspace),
  startedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dz-lease-'));
  dataDir = join(root, 'data');
  workspace = join(root, 'project');
  mkdirSync(dataDir);
  mkdirSync(workspace);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Studio_Lease file', () => {
  it('round trips, and the file holds the agent token only', async () => {
    const lease = sample();
    const written = await writeLease(dataDir, lease);
    expect(written.path).toBe(leasePath(dataDir, workspace));
    expect(written.path).toMatch(/leases[\\/]lease-[0-9a-f]{16}\.json$/);
    expect(await readLease(dataDir, workspace, alive)).toEqual(lease);
    expect(Object.keys(JSON.parse(readFileSync(written.path, 'utf-8'))).sort()).toEqual(['agentToken', 'origin', 'pid', 'startedAt', 'v', 'workspace']);
  });

  it.skipIf(process.platform === 'win32')('is private: folder 0700, file 0600, no temp file left', async () => {
    const written = await writeLease(dataDir, sample());
    expect(statSync(join(dataDir, 'leases')).mode & 0o777).toBe(0o700);
    expect(statSync(written.path).mode & 0o777).toBe(0o600);
  });

  it('refuses to write a lease for an address that is not loopback', async () => {
    await expect(writeLease(dataDir, sample({ origin: 'http://192.168.1.5:4555' }))).rejects.toThrow(/loopback/);
    expect(existsSync(join(dataDir, 'leases'))).toBe(false);
  });

  it('accepts only the three loopback forms', () => {
    for (const ok of ['http://127.0.0.1:1', 'http://localhost:65535', 'http://[::1]:8080']) expect(isLoopbackOrigin(ok)).toBe(true);
    for (const bad of ['http://0.0.0.0:80', 'https://127.0.0.1:80', 'http://example.com:80', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'http://127.0.0.1:80/x', 'http://127.0.0.999:80']) {
      expect(isLoopbackOrigin(bad)).toBe(false);
    }
  });

  it('returns nothing for a corrupt, truncated, empty or incomplete file, and never throws', async () => {
    const path = leasePath(dataDir, workspace);
    mkdirSync(join(dataDir, 'leases'), { recursive: true });
    const good = JSON.stringify(sample());
    const bad: string[] = [
      '',
      '{',
      good.slice(0, good.length - 10),
      'null',
      '[]',
      JSON.stringify({ ...sample(), v: 2 }),
      JSON.stringify({ ...sample(), origin: 'http://10.0.0.1:80' }),
      JSON.stringify({ ...sample(), agentToken: '' }),
      JSON.stringify({ ...sample(), pid: 0 }),
      JSON.stringify({ ...sample(), pid: '12' }),
      JSON.stringify({ ...sample(), workspace: undefined }),
      'x'.repeat(20_000),
    ];
    for (const text of bad) {
      writeFileSync(path, text);
      expect(parseLease(text)).toBeUndefined();
      await expect(readLease(dataDir, workspace, alive)).resolves.toBeUndefined();
    }
    await expect(readLease(join(root, 'missing'), workspace, alive)).resolves.toBeUndefined();
  });

  it('removes a lease whose process is gone, and a fresh Studio can take its place', async () => {
    const written = await writeLease(dataDir, sample({ pid: 999_999 }));
    expect(await readLease(dataDir, workspace, { isAlive: () => false, health: async () => true })).toBeUndefined();
    expect(existsSync(written.path)).toBe(false);
    const fresh = sample({ agentToken: 'another-token-9876543210' });
    await writeLease(dataDir, fresh);
    expect(await readLease(dataDir, workspace, alive)).toEqual(fresh);
  });

  it('ignores a lease whose Studio does not answer health', async () => {
    const written = await writeLease(dataDir, sample());
    expect(await readLease(dataDir, workspace, { isAlive: () => true, health: async () => false })).toBeUndefined();
    expect(existsSync(written.path)).toBe(false);
    await expect(readLease(dataDir, workspace, { isAlive: () => true, health: async () => Promise.reject(new Error('down')) })).resolves.toBeUndefined();
  });

  it('removes a stale file only when its content did not change meanwhile', async () => {
    const written = await writeLease(dataDir, sample());
    const newer = JSON.stringify(sample({ agentToken: 'newer-token-0123456789' }));
    const result = await readLease(dataDir, workspace, {
      isAlive: () => true,
      health: async () => {
        writeFileSync(written.path, newer);
        return false;
      },
    });
    expect(result).toBeUndefined();
    expect(readFileSync(written.path, 'utf-8')).toBe(newer);
  });

  it('remove() deletes only the lease that this call wrote', async () => {
    const first = await writeLease(dataDir, sample());
    const second = await writeLease(dataDir, sample({ agentToken: 'second-token-0123456789' }));
    await first.remove();
    expect(existsSync(second.path)).toBe(true);
    await second.remove();
    expect(existsSync(second.path)).toBe(false);
    const third = await writeLease(dataDir, sample());
    third.removeSync();
    expect(existsSync(third.path)).toBe(false);
  });

  it('keys one lease per workspace folder', () => {
    expect(leasePath(dataDir, workspace)).toBe(leasePath(dataDir, workspace));
    expect(leasePath(dataDir, workspace)).not.toBe(leasePath(dataDir, join(root, 'other')));
  });
});

// ---- the connection --------------------------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: string | null;
  killed: string[];
  kill(signal?: string): boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killed.push(signal);
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, null));
    return true;
  };
  return child;
}

describe('StudioConnection attach', () => {
  let studio: FakeStudio;
  beforeEach(async () => (studio = await startFakeStudio()));
  afterEach(async () => studio.close());

  const spawnOf = (child: FakeChild, seen: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []) => (command: string, args: readonly string[], options: SpawnOptions) => {
    seen.push({ command, args, options });
    return child as unknown as ChildProcess;
  };

  it('uses a live lease and starts no second Studio', async () => {
    await writeLease(dataDir, sample({ origin: studio.origin, agentToken: studio.agentToken }));
    const seen: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const api = new StudioConnection({ workspace, dataDir, spawn: spawnOf(fakeChild(), seen) });
    const outcome = await api.request('GET', '/api/health');
    expect(outcome).toMatchObject({ kind: 'response', status: 200 });
    expect(seen).toEqual([]);
    expect(studio.requests[0]?.header).toBe(studio.agentToken);
    await api.close();
    // A Studio it only attached to is left running
    expect((await fetch(`${studio.origin}/api/health`, { headers: { 'x-studio-token': studio.agentToken } })).status).toBe(200);
  });

  it('starts `studio --machine` in the workspace when there is no lease, and stops it on close', async () => {
    const child = fakeChild();
    const seen: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const api = new StudioConnection({ workspace, dataDir, spawn: spawnOf(child, seen) });
    const pending = api.request('GET', '/api/health');
    child.stdout.write('some log line\n');
    child.stdout.write(`${JSON.stringify({ origin: studio.origin, token: studio.agentToken, pid: 4242 })}\n`);
    expect(await pending).toMatchObject({ kind: 'response', status: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args.slice(-2)).toEqual(['studio', '--machine']);
    expect(seen[0]?.options.cwd).toBe(workspace);
    const started = Date.now();
    await api.close();
    expect(child.killed).toEqual(['SIGTERM']);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('takes the agent token from the lease that the child wrote, not the owner token', async () => {
    const child = fakeChild();
    const seen: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const api = new StudioConnection({ workspace, dataDir, spawn: spawnOf(child, seen) });
    // The fake Studio accepts only the agent token; the handshake line carries a different (owner) token
    const pending = api.request('GET', '/api/health');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await writeLease(dataDir, sample({ origin: studio.origin, agentToken: studio.agentToken, pid: process.pid }));
    child.stdout.write(`${JSON.stringify({ origin: studio.origin, token: 'owner-token-not-known-here', pid: process.pid })}\n`);
    expect(await pending).toMatchObject({ kind: 'response', status: 200 });
    expect(studio.requests[0]?.header).toBe(studio.agentToken);
    await api.close();
  });

  it('keeps the owner token in memory when the Studio wrote no lease (an older Studio)', async () => {
    const child = fakeChild();
    const api = new StudioConnection({ workspace, dataDir, spawn: spawnOf(child) });
    const pending = api.request('GET', '/api/health');
    child.stdout.write(`${JSON.stringify({ origin: studio.origin, token: 'owner-token-in-memory', pid: 4242 })}\n`);
    await pending;
    expect(studio.requests[0]?.header).toBe('owner-token-in-memory');
    expect(existsSync(join(dataDir, 'leases'))).toBe(false);
    await api.close();
  });

  it('answers unavailable within the attach limit and stops the child it started', async () => {
    const child = fakeChild();
    const api = new StudioConnection({ workspace, dataDir, spawn: spawnOf(child), attachTimeoutMs: 100 });
    expect(await api.request('GET', '/api/health')).toEqual({ kind: 'unavailable' });
    expect(child.killed).toEqual(['SIGTERM']);
    await api.close();
  });

  it('answers unavailable when the child exits before the handshake', async () => {
    const child = fakeChild();
    const seen: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const api = new StudioConnection({ workspace, dataDir, spawn: spawnOf(child, seen) });
    const pending = api.request('GET', '/api/health');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    child.emit('exit', 1, null);
    expect(await pending).toEqual({ kind: 'unavailable' });
    await api.close();
  });

  it('never uses an address that is not loopback', async () => {
    const child = fakeChild();
    const api = new StudioConnection({ workspace, dataDir, spawn: spawnOf(child) });
    const pending = api.request('GET', '/api/health');
    child.stdout.write(`${JSON.stringify({ origin: 'http://192.168.0.9:4000', token: 'owner-token-xx', pid: 1 })}\n`);
    expect(await pending).toEqual({ kind: 'unavailable' });
    await api.close();
  });

  it('never requests a route outside the agent list', async () => {
    const api = new StudioConnection({ workspace, dataDir, spawn: spawnOf(fakeChild()) });
    await expect(api.request('POST', '/api/approvals/decide', { id: 'x' })).rejects.toThrow();
    await expect(api.request('POST', '/api/secrets', { name: 'a', value: 'b' })).rejects.toThrow();
    await expect(api.request('GET', 'http://evil.example/api/health')).rejects.toThrow();
    expect(studio.requests).toEqual([]);
    await api.close();
  });

  it('retries a GET once after a network error, and re-attaches', async () => {
    await writeLease(dataDir, sample({ origin: studio.origin, agentToken: studio.agentToken }));
    let calls = 0;
    const flaky = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return fetch(...args);
    }) as typeof fetch;
    const api = new StudioConnection({ workspace, dataDir, fetchImpl: flaky });
    expect(await api.request('GET', '/api/health')).toMatchObject({ kind: 'response', status: 200 });
    expect(calls).toBe(2);
    await api.close();
  });
});
