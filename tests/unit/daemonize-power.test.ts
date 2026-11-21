import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonizePower, DAEMONIZE_SERVER_KEY } from '../../src/studio/daemonize-power.js';
import { createInstallRecords } from '../../src/studio/install-records.js';
import { defaultFsOps, type FsOps } from '../../src/studio/power-fs.js';
import type { AppData, DaemonizePowerInstaller } from '../../src/studio/contracts.js';
import { removeDir } from '../helpers/cleanup.js';

const SOURCE_MCP = { mcpServers: { 'daemonize-studio': { type: 'stdio', command: 'daemonize', args: ['mcp'], env: { DAEMONIZE_MODE: 'strict', SOME_TOKEN: 'abcdefghijklmnopqrstuvwxyz0123456789ABCD', KEPT: '${NAME}' } } } };
const PROGRAM = { command: 'node', args: ['/pkg/cli/index.js'] };

let root: string;
let counter = 0;

/** A fixture copy of the `power/` folder (the real one is written by another group). */
async function writeFixture(dir: string): Promise<void> {
  await mkdir(join(dir, 'steering'), { recursive: true });
  await mkdir(join(dir, 'skills', 'daemonize-builder'), { recursive: true });
  await mkdir(join(dir, 'agents'), { recursive: true });
  await writeFile(join(dir, 'mcp.json'), JSON.stringify(SOURCE_MCP));
  await writeFile(join(dir, 'steering', 'rules.md'), '# Rules\n');
  await writeFile(join(dir, 'skills', 'daemonize-builder', 'SKILL.md'), '---\nname: daemonize-builder\n---\nSkill\n');
  await writeFile(join(dir, 'agents', 'daemonize.md'), '---\nname: daemonize\n---\nAgent\n');
}

interface Env {
  dir: string;
  home: string;
  ws: string;
  power: string;
  installer: DaemonizePowerInstaller;
}
async function setup(fsOps?: FsOps): Promise<Env> {
  const dir = join(root, `t${counter++}`);
  const home = join(dir, 'home');
  const ws = join(dir, 'ws');
  const power = join(dir, 'power');
  await mkdir(home, { recursive: true });
  await mkdir(ws, { recursive: true });
  await writeFixture(power);
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
  const appData: AppData = {
    dir: dataDir,
    check: async () => ({ ok: true, dir: dataDir }),
    ensure: async () => ({ ok: true, dir: dataDir }),
  } as unknown as AppData;
  const installer = createDaemonizePower({
    cwd: ws,
    home,
    appData,
    env: {},
    powerDir: power,
    program: PROGRAM,
    records: createInstallRecords({ appData }),
    ...(fsOps === undefined ? {} : { fsOps }),
  });
  return { dir, home, ws, power, installer };
}

const read = (path: string) => readFile(path, 'utf-8');
const mcpOf = (home: string) => join(home, '.kiro', 'settings', 'mcp.json');
async function install(env: Env, replace?: string[], scope: 'global' | 'project' = 'global') {
  const plan = await env.installer.preview({ scope, ...(scope === 'project' ? { workspacePath: env.ws } : {}) });
  return { plan, result: await env.installer.install({ confirmationId: plan.confirmationId, kiroPath: plan.kiroPath, scope, ...(replace === undefined ? {} : { replace }) }) };
}

describe('Daemonize Power install', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'daemonize-power-unit-'));
  });
  afterAll(async () => {
    await removeDir(root);
  });

  it('previews the folder and files in the fake home and writes nothing', async () => {
    const env = await setup();
    const plan = await env.installer.preview({ scope: 'global' });
    expect(plan.kiroPath).toBe(join(env.home, '.kiro'));
    expect(plan.files.map((f) => f.path).sort()).toEqual(['agents/daemonize.md', 'settings/mcp.json', 'skills/daemonize-builder/SKILL.md', 'steering/rules.md']);
    expect(plan.files.every((f) => f.outcome === 'create')).toBe(true);
    expect(plan.alreadyInstalled).toBe(false);
    expect(plan.conflicts).toEqual([]);
    await expect(lstat(join(env.home, '.kiro'))).rejects.toThrow();
  });

  it('writes the files and an entry with the located program, placeholders and no secret-looking value', async () => {
    const env = await setup();
    const { result } = await install(env);
    expect(result.alreadyInstalled).toBe(false);
    expect(await read(join(env.home, '.kiro', 'agents', 'daemonize.md'))).toContain('Agent');
    const settings = JSON.parse(await read(mcpOf(env.home)));
    expect(settings.mcpServers[DAEMONIZE_SERVER_KEY]).toEqual({
      type: 'stdio', command: 'node', args: ['/pkg/cli/index.js', 'mcp'], env: { DAEMONIZE_MODE: 'strict', KEPT: '${NAME}' },
    });
  });

  it('writes the agent part without the steering', async () => {
    const env = await setup();
    const plan = await env.installer.preview({ scope: 'global', parts: 'agent' });
    expect(plan.files.map((f) => f.path)).not.toContain('steering/rules.md');
    await env.installer.install({ confirmationId: plan.confirmationId, kiroPath: plan.kiroPath, scope: 'global' });
    await expect(lstat(join(env.home, '.kiro', 'steering'))).rejects.toThrow();
  });

  it('says it is already installed and writes nothing the second time', async () => {
    const env = await setup();
    await install(env);
    const before = await read(mcpOf(env.home));
    const again = await install(env);
    expect(again.plan.alreadyInstalled).toBe(true);
    expect(again.plan.files).toEqual([]);
    expect(again.result).toEqual({ written: [], skipped: [], alreadyInstalled: true });
    expect(await read(mcpOf(env.home))).toBe(before);
  });

  it('reports a file with other content and keeps it unless the user confirms', async () => {
    const env = await setup();
    const agent = join(env.home, '.kiro', 'agents', 'daemonize.md');
    await mkdir(join(env.home, '.kiro', 'agents'), { recursive: true });
    await writeFile(agent, 'mine');
    const first = await install(env);
    expect(first.plan.conflicts).toEqual(['agents/daemonize.md']);
    expect(first.result.skipped).toEqual(['agents/daemonize.md']);
    expect(await read(agent)).toBe('mine');
    const second = await install(env, ['agents/daemonize.md']);
    expect(second.result.written).toEqual(['agents/daemonize.md']);
    expect(await read(agent)).toContain('Agent');
  });

  it('uses a confirmation once and only for the path it showed', async () => {
    const env = await setup();
    const plan = await env.installer.preview({ scope: 'global' });
    await expect(env.installer.install({ confirmationId: plan.confirmationId, kiroPath: join(env.dir, 'other', '.kiro'), scope: 'global' })).rejects.toMatchObject({ status: 409 });
    await expect(lstat(join(env.home, '.kiro'))).rejects.toThrow();
    await env.installer.install({ confirmationId: plan.confirmationId, kiroPath: plan.kiroPath, scope: 'global' });
    await expect(env.installer.install({ confirmationId: plan.confirmationId, kiroPath: plan.kiroPath, scope: 'global' })).rejects.toMatchObject({ status: 409 });
  });

  it('rolls back every file when a write fails', async () => {
    const failing: FsOps = {
      ...defaultFsOps,
      rename: async (from, to) => {
        if (to.endsWith('mcp.json')) throw new Error('disk full');
        return defaultFsOps.rename(from, to);
      },
    };
    const env = await setup(failing);
    await mkdir(join(env.home, '.kiro', 'settings'), { recursive: true });
    const original = JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2) + '\n';
    await writeFile(mcpOf(env.home), original);
    const plan = await env.installer.preview({ scope: 'global' });
    await expect(env.installer.install({ confirmationId: plan.confirmationId, kiroPath: plan.kiroPath, scope: 'global' })).rejects.toMatchObject({ status: 500 });
    expect(await read(mcpOf(env.home))).toBe(original);
    await expect(lstat(join(env.home, '.kiro', 'agents'))).rejects.toThrow();
    await expect(lstat(join(env.home, '.kiro', 'skills'))).rejects.toThrow();
    expect((await readdir(join(env.home, '.kiro', 'settings'))).filter((n) => n.includes('tmp'))).toEqual([]);
  });

  it('removes only what it wrote and leaves other servers unchanged', async () => {
    const env = await setup();
    await mkdir(join(env.home, '.kiro', 'settings'), { recursive: true });
    const original = JSON.stringify({ mcpServers: { other: { command: 'x' } }, keep: 1 }, null, 2) + '\n';
    await writeFile(mcpOf(env.home), original);
    await writeFile(join(env.home, '.kiro', 'notes.md'), 'mine');
    await install(env);
    const removed = await env.installer.remove({ scope: 'global' });
    expect(removed.removed).toEqual(expect.arrayContaining(['settings/mcp.json', 'agents/daemonize.md']));
    expect(await read(mcpOf(env.home))).toBe(original);
    expect(await read(join(env.home, '.kiro', 'notes.md'))).toBe('mine');
    await expect(lstat(join(env.home, '.kiro', 'agents', 'daemonize.md'))).rejects.toThrow();
    await expect(env.installer.remove({ scope: 'global' })).rejects.toMatchObject({ status: 409 });
  });

  it('installs into the project folder only', async () => {
    const env = await setup();
    await install(env, undefined, 'project');
    expect(await read(join(env.ws, '.kiro', 'agents', 'daemonize.md'))).toContain('Agent');
    await expect(lstat(join(env.home, '.kiro'))).rejects.toThrow();
    const info = await env.installer.info();
    expect(info.installs).toEqual([{ scope: 'project', parts: 'power' }]);
    expect(info.agentPresent).toEqual({ project: true, global: false });
  });

  it('refuses a bad scope, a bad parts value and a settings file that is not JSON', async () => {
    const env = await setup();
    await expect(env.installer.preview({ scope: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(env.installer.preview({ scope: 'global', parts: 'all' })).rejects.toMatchObject({ status: 400 });
    await mkdir(join(env.home, '.kiro', 'settings'), { recursive: true });
    await writeFile(mcpOf(env.home), '{ nope');
    await expect(env.installer.preview({ scope: 'global' })).rejects.toMatchObject({ status: 409 });
    expect(await read(mcpOf(env.home))).toBe('{ nope');
  });
});
