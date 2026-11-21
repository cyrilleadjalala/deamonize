import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLoopbackOrigin, leasePath, parseLease, readLease, writeLease, type LeaseDeps, type StudioLease } from '../../src/studio/lease';
import { StudioConnection } from '../../src/studio/mcp/connection';
import { lease as leaseArb } from '../helpers/firewall-arbitraries';

let root: string;
let dataDir: string;
const WORKSPACE = 'workspace-under-test';
const RUNS = { numRuns: 100 };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dz-leaseprop-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const withWorkspace = (l: { workspace: string } & Omit<StudioLease, 'workspace'>): StudioLease => ({ ...l });
const alive: LeaseDeps = { isAlive: () => true, health: async () => true };

const completeLease = (value: StudioLease | undefined): boolean =>
  value === undefined ||
  (value.v === 1 &&
    isLoopbackOrigin(value.origin) &&
    typeof value.agentToken === 'string' &&
    value.agentToken.length >= 8 &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.workspace === 'string' &&
    typeof value.startedAt === 'string');

describe('Studio_Lease properties', () => {
  it('Property 1: Lease reader is total and round trips', async () => {
    // Feature: kiro-native-agent-and-firewall, Property 1: Lease reader is total and round trips
    // Validates: Requirements 1.2, 1.4, 1.10
    await fc.assert(
      fc.asyncProperty(leaseArb, async (generated) => {
        const lease = withWorkspace(generated);
        const written = await writeLease(dataDir, lease);
        try {
          expect(await readLease(dataDir, lease.workspace, alive)).toEqual(lease);
        } finally {
          await written.remove();
        }
      }),
      RUNS
    );
    // Whatever the file holds: a complete lease or nothing, and no exception
    await fc.assert(
      fc.asyncProperty(
        leaseArb,
        fc.oneof(
          fc.string({ maxLength: 400 }),
          fc.nat(400).map((cut) => ({ cut })),
          fc.tuple(fc.nat(400), fc.string({ minLength: 1, maxLength: 3 })).map(([at, ch]) => ({ at, ch }))
        ),
        async (generated, damage) => {
          const lease = withWorkspace({ ...generated, workspace: WORKSPACE });
          const good = JSON.stringify(lease);
          const text = typeof damage === 'string' ? damage : 'cut' in damage ? good.slice(0, damage.cut) : `${good.slice(0, damage.at)}${damage.ch}${good.slice(damage.at + 1)}`;
          const path = leasePath(dataDir, WORKSPACE);
          mkdirSync(join(dataDir, 'leases'), { recursive: true });
          writeFileSync(path, text);
          const parsed = parseLease(text);
          expect(completeLease(parsed)).toBe(true);
          const read = await readLease(dataDir, WORKSPACE, alive);
          expect(completeLease(read)).toBe(true);
          rmSync(path, { force: true });
        }
      ),
      RUNS
    );
  });

  it('Property 2: A stale lease is never used', async () => {
    // Feature: kiro-native-agent-and-firewall, Property 2: A stale lease is never used
    // Validates: Requirements 1.5, 1.9
    await fc.assert(
      fc.asyncProperty(leaseArb, fc.constantFrom('dead', 'unhealthy', 'health-throws'), async (generated, kind) => {
        const lease = withWorkspace(generated);
        const written = await writeLease(dataDir, lease);
        const deps: LeaseDeps =
          kind === 'dead'
            ? { isAlive: () => false, health: async () => true }
            : kind === 'unhealthy'
              ? { isAlive: () => true, health: async () => false }
              : { isAlive: () => true, health: async () => Promise.reject(new Error('down')) };
        expect(await readLease(dataDir, lease.workspace, deps)).toBeUndefined();
        // The stale file is gone, so the next start does not meet it again
        expect(existsSync(written.path)).toBe(false);
      }),
      RUNS
    );
  });

  it('Property 3: The token never leaves the loopback header', async () => {
    // Feature: kiro-native-agent-and-firewall, Property 3: The token never leaves the loopback header
    // Validates: Requirements 1.7, 1.8, 6.2
    const routes = ['/api/health', '/api/overview', '/api/workflows', '/api/secrets', '/api/activity?limit=5'] as const;
    await fc.assert(
      fc.asyncProperty(leaseArb, fc.constantFrom(...routes), async (generated, route) => {
        const lease = withWorkspace(generated);
        const written = await writeLease(dataDir, lease);
        const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
        const fetchImpl = (async (input: string, init: RequestInit) => {
          calls.push({ url: String(input), headers: init.headers as Record<string, string>, body: init.body });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as unknown as typeof fetch;
        const api = new StudioConnection({ workspace: lease.workspace, dataDir, fetchImpl, leaseDeps: alive });
        try {
          const outcome = await api.request('GET', route);
          expect(outcome).toMatchObject({ kind: 'response', status: 200 });
          expect(calls).toHaveLength(1);
          const call = calls[0]!;
          expect(call.url.startsWith(`${lease.origin}/api/`)).toBe(true);
          expect(isLoopbackOrigin(new URL(call.url).origin)).toBe(true);
          expect(call.headers['x-studio-token']).toBe(lease.agentToken);
          expect(call.url).not.toContain(lease.agentToken);
          expect(Object.entries(call.headers).filter(([, v]) => v.includes(lease.agentToken)).map(([k]) => k)).toEqual(['x-studio-token']);
          expect(String(call.body ?? '')).not.toContain(lease.agentToken);
          // Nothing the connection hands to a tool holds the token or the address
          expect(JSON.stringify(outcome)).not.toContain(lease.agentToken);
          expect(api.secretValues()).toEqual(expect.arrayContaining([lease.agentToken, lease.origin]));
        } finally {
          await api.close();
          await written.remove();
        }
      }),
      RUNS
    );
    // A lease for an address that is not loopback is never read, so no request leaves the machine
    await fc.assert(
      fc.asyncProperty(leaseArb, fc.constantFrom('http://192.168.1.20:4000', 'http://example.com:80', 'https://127.0.0.1:4000', 'http://0.0.0.0:4000', 'ftp://127.0.0.1:21'), async (generated, origin) => {
        const lease = withWorkspace({ ...generated, origin });
        mkdirSync(join(dataDir, 'leases'), { recursive: true });
        writeFileSync(leasePath(dataDir, lease.workspace), JSON.stringify(lease));
        let fetched = 0;
        const fetchImpl = (async () => {
          fetched += 1;
          return new Response('{}');
        }) as unknown as typeof fetch;
        const spawned: string[] = [];
        const api = new StudioConnection({
          workspace: lease.workspace,
          dataDir,
          fetchImpl,
          leaseDeps: alive,
          attachTimeoutMs: 50,
          spawn: ((command: string) => {
            spawned.push(command);
            throw new Error('no child in this test');
          }) as never,
        });
        expect(await api.request('GET', '/api/health')).toEqual({ kind: 'unavailable' });
        expect(fetched).toBe(0);
        expect(readFileSync(leasePath(dataDir, lease.workspace), 'utf-8')).toContain(lease.agentToken);
        await api.close();
        rmSync(leasePath(dataDir, lease.workspace), { force: true });
      }),
      RUNS
    );
  });
});
