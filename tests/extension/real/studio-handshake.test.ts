// Real-process tests: spawn the built CLI (`dist/cli/index.js studio --machine`) and talk to it over loopback HTTP.
// They use node:http and node:child_process directly. Home is a temporary folder, never the real ~/.kiro.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = resolve(process.cwd(), 'dist', 'cli', 'index.js');
const HAS_CLI = existsSync(CLI);
if (!HAS_CLI) console.warn(`SKIPPED real-process tests: ${CLI} is missing, run npm run build first.`);

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string }

function http(origin: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const url = new URL(path, origin);
  return new Promise((ok, fail) => {
    const req = request({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: 'GET', headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', fail);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

interface Running { child: ChildProcess; stdout: string; stderr: string; exit: Promise<number | null> }

function start(args: string[], cwd: string, home: string): Running {
  const child = spawn(process.execPath, [CLI, 'studio', ...args, '--machine'], {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const run: Running = { child, stdout: '', stderr: '', exit: new Promise((r) => child.on('exit', (code) => r(code))) };
  child.stdout?.on('data', (b: Buffer) => (run.stdout += b.toString('utf8')));
  child.stderr?.on('data', (b: Buffer) => (run.stderr += b.toString('utf8')));
  return run;
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return test();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid: number): Promise<void> {
  return new Promise((done) => {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => done());
    else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch { /* already gone */ }
      done();
    }
  });
}

describe.skipIf(!HAS_CLI)('real Studio process with --machine', () => {
  let dir = '';
  let home = '';
  let workflows = '';
  const running: Running[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemonize-real-'));
    home = mkdtempSync(join(tmpdir(), 'daemonize-home-'));
    workflows = join(dir, 'daemonize.workflows.json');
    // No workflow file on purpose: a missing file is the empty start of a fresh folder.
  });

  afterAll(async () => {
    for (const r of running) if (r.child.pid !== undefined && alive(r.child.pid)) await killTree(r.child.pid);
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('prints one handshake line, serves token-guarded routes, keeps the token off stderr and stops cleanly', async () => {
    const run = start([dir, '--workflows', workflows], dir, home);
    running.push(run);
    const pid = run.child.pid as number;
    expect(await until(() => run.stdout.includes('\n'), 30000), `no handshake. stderr: ${run.stderr}`).toBe(true);

    const lines = run.stdout.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    const hs = JSON.parse(lines[0] as string) as { origin: string; token: string; pid: number };
    expect(Object.keys(hs).sort()).toEqual(['origin', 'pid', 'token']);
    expect(hs.origin).toMatch(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/);
    expect(hs.token).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(hs.pid).toBe(pid);

    const auth = { 'x-studio-token': hs.token };
    const health = await http(hs.origin, '/api/health', auth);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ ok: true });
    expect((await http(hs.origin, '/api/workflows', auth)).status).toBe(200);
    expect(JSON.parse((await http(hs.origin, '/api/workflows', auth)).text)).toHaveProperty('workflows');
    const secrets = await http(hs.origin, '/api/secrets', auth);
    expect(secrets.status).toBe(200);
    expect(JSON.parse(secrets.text)).toHaveProperty('secrets');

    for (const path of ['/api/health', '/api/workflows', '/api/secrets']) {
      expect((await http(hs.origin, path)).status, path).toBe(401);
      expect((await http(hs.origin, path, { 'x-studio-token': 'x'.repeat(hs.token.length) })).status, path).toBe(401);
    }

    // First visit with ?token= answers 302 to the same path without the token and sets the cookie.
    const visit = await http(hs.origin, `/?token=${hs.token}`);
    expect(visit.status).toBe(302);
    expect(String(visit.headers.location)).not.toContain(hs.token);
    expect(String(visit.headers['set-cookie'])).toMatch(/HttpOnly/i);

    expect(run.stdout.split('\n').filter((l) => l !== '')).toHaveLength(1);
    expect(run.stderr).not.toContain(hs.token);

    await killTree(pid);
    expect(await until(() => !alive(pid), 10000)).toBe(true);
    await run.exit;
    expect(run.stderr).not.toContain(hs.token);
  }, 90000);

  it('fails with a non-zero exit and nothing on stdout when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const run = start([dir, '--workflows', workflows, '--port', String(port)], dir, home);
      running.push(run);
      const code = await Promise.race([run.exit, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 30000))]);
      expect(code).not.toBe('hung');
      expect(code).not.toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr.length).toBeGreaterThan(0);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  }, 60000);

  it('exits non-zero with empty stdout for an invalid option value', async () => {
    const run = start([dir, '--workflows', workflows, '--port', 'abc'], dir, home);
    running.push(run);
    const code = await run.exit;
    expect(code).not.toBe(0);
    expect(run.stdout).toBe('');
  }, 60000);

  it('stops studio --machine automatically when its parent process exits abruptly without deactivate', async () => {
    // Spawn a separate parent node process that launches `studio --machine` detached, prints its handshake, and exits abruptly.
    const launcherScript = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [${JSON.stringify(CLI)}, 'studio', ${JSON.stringify(dir)}, '--workflows', ${JSON.stringify(workflows)}, '--machine'], {
        cwd: ${JSON.stringify(dir)},
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, HOME: ${JSON.stringify(home)}, USERPROFILE: ${JSON.stringify(home)} },
      });
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\\n');
        if (nl >= 0) {
          process.stdout.write(buf.slice(0, nl + 1));
          child.stdout.destroy();
          child.unref();
          process.exit(1);
        }
      });
    `;
    const parent = spawn(process.execPath, ['-e', launcherScript], {
      cwd: dir,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let out = '';
    parent.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    const parentCode = await new Promise<number | null>((resolve) => parent.on('exit', resolve));
    expect(parentCode).toBe(1);

    const hs = JSON.parse(out.trim()) as { pid: number; origin: string; token: string };
    expect(typeof hs.pid).toBe('number');
    try {
      expect(await until(() => !alive(hs.pid), 10000)).toBe(true);
    } finally {
      if (alive(hs.pid)) await killTree(hs.pid);
    }
  }, 60000);
});
