import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });
import { spawn, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { removeDir } from '../helpers/cleanup.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the built CLI in `cwd`. The PATH holds only the folder of node, so the Studio cannot open a real browser. */
function run(args: string[], cwd: string, onOutput?: (stdout: string, child: ReturnType<typeof spawn>) => void): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, PATH: dirname(process.execPath) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); onOutput?.(stdout, child); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('bare daemonize as a child process', () => {
  let dir: string;
  const busy: { server?: Server } = {};

  beforeAll(async () => {
    // Build when the output is missing or older than the CLI sources
    const stale =
      !existsSync(CLI) ||
      !readFileSync(CLI, 'utf-8').includes('Unknown argument') ||
      !readFileSync(join(ROOT, 'dist', 'cli', 'commands', 'studio.js'), 'utf-8').includes('untilInterrupted');
    if (stale) execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: ROOT, stdio: 'ignore' });
    dir = await mkdtemp(join(tmpdir(), 'daemonize-bare-'));
  });
  afterAll(async () => {
    await new Promise<void>((done) => (busy.server ? busy.server.close(() => done()) : done()));
    await removeDir(dir);
  });

  it('prints the list of subcommands for --help and exits 0 without starting the Studio', async () => {
    const result = await run(['--help'], dir);
    expect(result.code).toBe(0);
    for (const name of ['record', 'compile', 'merge', 'serve', 'studio', 'sandbox']) expect(result.stdout).toContain(name);
    expect(result.stdout).not.toMatch(/^Studio: http/m);
  });

  it('fails with a non-zero code and names an unknown argument', async () => {
    const result = await run(['foo'], dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Error: Unknown argument "foo"/);
    expect(result.stdout).not.toMatch(/^Studio: http/m);
  });

  it('prints Error: on standard error and exits 1 when the Studio cannot bind its port', async () => {
    busy.server = createServer();
    await new Promise<void>((done) => busy.server!.listen(0, '127.0.0.1', done));
    const port = (busy.server.address() as AddressInfo).port;
    const result = await run(['studio', '--port', String(port)], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^Error: /m);
  });

  // POSIX signals reach the handlers only off Windows; there SIGINT ends the process without running them
  it.skipIf(process.platform === 'win32')('prints the address and the Ctrl+C line, and exits 0 within 5 seconds of SIGINT', async () => {
    let stopped: number | undefined;
    const result = await run([], dir, (stdout, child) => {
      if (stopped === undefined && stdout.includes('Press Ctrl+C')) {
        stopped = Date.now();
        child.kill('SIGINT');
      }
    });
    const took = Date.now() - (stopped ?? 0);
    expect(result.stdout).toMatch(/^Studio: http:\/\/127\.0\.0\.1:\d+\/\?token=/m);
    expect(result.stdout).toContain('Ctrl+C');
    expect(result.code).toBe(0);
    expect(took).toBeLessThan(5000);
    expect(result.stderr).toBe('');
  });
});
