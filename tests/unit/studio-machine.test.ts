import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leasePath, parseLease } from '../../src/studio/lease';

const TOKEN = 'synthetic-token-AAAAAAAAAAAAAAAAAAAAAAAA';
const startStudio = vi.hoisted(() => vi.fn());

vi.mock('../../src/studio/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/studio/server.js')>();
  return { ...actual, startStudio };
});
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { studio, formatHandshakeLine } from '../../src/cli/commands/studio';

function fakeHandle() {
  return { origin: 'http://127.0.0.1:5555', token: TOKEN, url: `http://127.0.0.1:5555/?token=${TOKEN}`, close: async () => undefined, port: 5555 };
}

describe('daemonize studio --machine', () => {
  beforeEach(() => {
    startStudio.mockReset();
    spawnMock.mockReset();
    startStudio.mockResolvedValue(fakeHandle());
  });

  it('writes exactly one JSON line with origin, token and pid, and nothing else', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const logged: string[] = [];
    await studio('out', { workflows: 'w.json', machine: true, stdout: (t) => out.push(t), stderr: (l) => err.push(l), log: (l) => logged.push(l) });
    expect(out).toHaveLength(1);
    expect(out[0]!.endsWith('\n')).toBe(true);
    expect(out[0]!.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(out[0]!)).toEqual({ origin: 'http://127.0.0.1:5555', token: TOKEN, pid: process.pid });
    expect(logged).toEqual([]);
    expect(err).toEqual([]);
  });

  it('never opens a browser, even with --open', async () => {
    await studio('out', { workflows: 'w.json', machine: true, open: true, stdout: () => undefined, stderr: () => undefined });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('sends the non-loopback warning to stderr without the token', async () => {
    const out: string[] = [];
    const err: string[] = [];
    await studio('out', { workflows: 'w.json', machine: true, host: '0.0.0.0', allowRemote: true, stdout: (t) => out.push(t), stderr: (l) => err.push(l) });
    expect(err.length).toBeGreaterThan(0);
    expect(err.join('\n')).toMatch(/Warning/);
    expect(err.join('\n')).not.toContain(TOKEN);
    expect(out).toHaveLength(1);
  });

  it('writes nothing to stdout when the Studio fails to start', async () => {
    startStudio.mockRejectedValue(new Error('port in use'));
    const out: string[] = [];
    await expect(studio('out', { workflows: 'w.json', machine: true, stdout: (t) => out.push(t), stderr: () => undefined })).rejects.toThrow('port in use');
    expect(out).toEqual([]);
  });

  it('refuses a remote host without --allow-remote and writes nothing to stdout', async () => {
    const out: string[] = [];
    await expect(studio('out', { workflows: 'w.json', machine: true, host: '0.0.0.0', stdout: (t) => out.push(t) })).rejects.toThrow(/allow-remote/);
    expect(out).toEqual([]);
  });

  it('keeps the old output without --machine', async () => {
    const logged: string[] = [];
    const out: string[] = [];
    await studio('out', { workflows: 'w.json', log: (l) => logged.push(l), stdout: (t) => out.push(t) });
    expect(logged[0]).toContain(`?token=${TOKEN}`);
    expect(logged.some((l) => l.includes('Ctrl+C'))).toBe(true);
    expect(out).toEqual([]);
  });

  describe('Studio_Lease', () => {
    const AGENT = 'synthetic-agent-token-BBBBBBBBBBBB';
    let dataDir: string;
    let before: string | undefined;
    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'dz-machine-'));
      before = process.env.DAEMONIZE_DATA_DIR;
      process.env.DAEMONIZE_DATA_DIR = dataDir;
      startStudio.mockResolvedValue({ ...fakeHandle(), agentToken: AGENT });
    });
    afterEach(() => {
      if (before === undefined) delete process.env.DAEMONIZE_DATA_DIR;
      else process.env.DAEMONIZE_DATA_DIR = before;
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('writes the lease before the handshake line, keeps the line unchanged, and removes the lease on close', async () => {
      const out: string[] = [];
      let leaseSeenAtHandshake = false;
      const handle = await studio('out', {
        workflows: 'w.json',
        machine: true,
        stdout: (t) => {
          leaseSeenAtHandshake = existsSync(leasePath(dataDir, process.cwd()));
          out.push(t);
        },
        stderr: () => undefined,
      });
      expect(leaseSeenAtHandshake).toBe(true);
      expect(JSON.parse(out[0]!)).toEqual({ origin: 'http://127.0.0.1:5555', token: TOKEN, pid: process.pid });
      expect(out[0]).not.toContain(AGENT);
      const lease = parseLease(readFileSync(leasePath(dataDir, process.cwd()), 'utf-8'));
      expect(lease).toMatchObject({ origin: 'http://127.0.0.1:5555', agentToken: AGENT, pid: process.pid });
      expect(readFileSync(leasePath(dataDir, process.cwd()), 'utf-8')).not.toContain(TOKEN);
      await handle.close();
      expect(existsSync(leasePath(dataDir, process.cwd()))).toBe(false);
    });

    it('writes no lease for a sample Studio or a listener that is not loopback', async () => {
      await studio('out', { workflows: 'w.json', machine: true, sample: true, stdout: () => undefined, stderr: () => undefined });
      await studio('out', { workflows: 'w.json', machine: true, host: '0.0.0.0', allowRemote: true, stdout: () => undefined, stderr: () => undefined });
      expect(existsSync(leasePath(dataDir, process.cwd()))).toBe(false);
    });

    it('stays silent when the lease cannot be written', async () => {
      process.env.DAEMONIZE_DATA_DIR = 'relative/not/absolute';
      const err: string[] = [];
      const out: string[] = [];
      await studio('out', { workflows: 'w.json', machine: true, stdout: (t) => out.push(t), stderr: (l) => err.push(l) });
      expect(out).toHaveLength(1);
      expect(err).toEqual([]);
    });
  });

  it('formatHandshakeLine keeps only the three fields', () => {
    const line = formatHandshakeLine({ origin: 'http://127.0.0.1:1', token: 't', pid: 3, extra: 1 } as never);
    expect(line).toBe('{"origin":"http://127.0.0.1:1","token":"t","pid":3}\n');
  });
});
