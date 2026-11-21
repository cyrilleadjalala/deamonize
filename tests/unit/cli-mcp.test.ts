import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildProgram } from '../../src/cli/index';
import { leaseFor, startFakeStudio, type FakeStudio } from '../helpers/fake-studio';

const dist = resolve('dist', 'cli', 'index.js');
const version = (JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string }).version;

describe('daemonize command list', () => {
  it('adds `mcp` and keeps every earlier command', () => {
    const program = buildProgram();
    expect(program.commands.map((c) => c.name()).sort()).toEqual(['compile', 'mcp', 'merge', 'record', 'sandbox', 'serve', 'studio']);
    const mcp = program.commands.find((c) => c.name() === 'mcp')!;
    expect(mcp.options.map((o) => o.long)).toEqual(['--workspace']);
  });

  it('answers --version with the version of the package', async () => {
    const program = buildProgram();
    let out = '';
    program.exitOverride();
    program.configureOutput({ writeOut: (s) => (out += s), writeErr: () => undefined });
    await expect(program.parseAsync(['node', 'daemonize', '--version'])).rejects.toMatchObject({ code: 'commander.version' });
    expect(out.trim()).toBe(version);
  });
});

// These run the compiled program (`npm run build` first): stdout has to carry MCP messages only
describe.skipIf(!existsSync(dist))('daemonize mcp (compiled)', () => {
  let root: string;
  let studio: FakeStudio;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'dz-climcp-'));
    mkdirSync(join(root, 'data'));
    mkdirSync(join(root, 'project'));
    studio = await startFakeStudio();
    await leaseFor(join(root, 'data'), join(root, 'project'), studio);
  });
  afterEach(async () => {
    await studio.close();
    rmSync(root, { recursive: true, force: true });
  });

  function run(args: string[]) {
    const child = spawn(process.execPath, [dist, ...args], {
      cwd: root,
      env: { ...process.env, DAEMONIZE_DATA_DIR: join(root, 'data') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf-8').on('data', (c: string) => (stderr += c));
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    return { child, exited, out: () => stdout, err: () => stderr };
  }

  it('prints only MCP messages on stdout, serves the tools, and exits when stdin closes', async () => {
    const p = run(['mcp', '--workspace', join(root, 'project')]);
    const send = (message: unknown): void => void p.child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_actions', arguments: {} } });
    const started = Date.now();
    while (!/"id":3/.test(p.out()) && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 50));
    p.child.stdin.end();
    expect(await p.exited).toBe(0);
    const lines = p.out().split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    const list = JSON.parse(lines.find((l) => l.includes('"id":2'))!) as { result: { tools: unknown[] } };
    expect(list.result.tools).toHaveLength(13);
    expect(p.out()).not.toContain(studio.agentToken);
    // It attached to the Studio of the lease, which keeps running
    expect(studio.count('GET /api/workflows')).toBe(1);
  }, 30_000);

  it('reports a missing workspace on stderr and writes nothing to stdout', async () => {
    const p = run(['mcp', '--workspace', join(root, 'nowhere')]);
    p.child.stdin.end();
    expect(await p.exited).toBe(1);
    expect(p.out()).toBe('');
    expect(p.err()).toMatch(/does not exist/);
  }, 30_000);

  it('`--version` prints the version only', async () => {
    const p = run(['--version']);
    expect(await p.exited).toBe(0);
    expect(p.out().trim()).toBe(version);
  }, 30_000);
});
