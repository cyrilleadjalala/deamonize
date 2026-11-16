import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 120000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { record } from '../../src/cli/commands/record.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import type { Workflow, WorkflowSet, WorkflowStep } from '../../src/types.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const fakeHealerModule = resolve(import.meta.dirname, '../fixtures/heal/fake-healer-module.mjs');
const canvasPage = resolve(import.meta.dirname, '../fixtures/web/canvas-app.html');
const chromiumEnv: Record<string, string> = process.env.DAEMONIZE_CHROMIUM_PATH
  ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH }
  : {};

/** A valid 1x1 PNG, standing for the thumbnail recorded with a step. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const sha = (buffer: Buffer | string) => createHash('sha256').update(buffer).digest('hex');

/** The page of the application after a redesign: the button has another name and another id than when it was recorded. */
const DRIFTED_PAGE = `<!doctype html><html><head><title>Items</title></head><body>
<button id="x9" onclick="document.getElementById('out').textContent = 'removed'">Delete item</button>
<button id="c1">Cancel</button>
<p id="out"></p>
</body></html>`;

function removeStep(extra: Partial<WorkflowStep>, index: number): WorkflowStep {
  return {
    actionType: 'click',
    selectors: ['role=button[name="Remove"]', '#remove'],
    anchor: { role: 'button', name: 'Remove', frame: [] },
    risk: 'read',
    visual: {
      rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.05 },
      intent: "Click the button 'Remove'",
      thumbnailPath: `workflows.json.assets/step-${index}.png`,
    },
    ...extra,
  };
}

function workflow(id: string, label: string, steps: WorkflowStep[]): Workflow {
  return { id, label, steps, variables: [], observedPayloads: [] };
}

async function compileInto(prefix: string, set: WorkflowSet, options: { healSupport?: boolean; workflowFile?: string }): Promise<string> {
  // Under the workspace so the generated server finds its dependencies in node_modules
  const dir = await mkdtemp(join(workspaceRoot, prefix));
  const log = console.log;
  console.log = () => { };
  try {
    await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir, options);
  } finally {
    console.log = log;
  }
  return dir;
}

interface Server_ {
  client: Client;
  transport: StdioClientTransport;
}

async function connect(dir: string, env: Record<string, string>): Promise<Server_> {
  const client = new Client({ name: 'heal-e2e', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(dir, 'mcp-server.js')], cwd: workspaceRoot, env: { ...chromiumEnv, ...env } });
  await client.connect(transport);
  return { client, transport };
}

async function call(server: Server_, name: string): Promise<Record<string, any>> {
  const response = await server.client.callTool({ name, arguments: {} });
  const content = response.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

const lines = async (file: string): Promise<string[]> =>
  existsSync(file) ? (await readFile(file, 'utf8')).split('\n').filter((l) => l !== '') : [];

describe('Heal mode on a page whose accessible names and selectors changed', () => {
  let httpServer: Server;
  let root: string;
  let workflowFile: string;
  let workflowBytes: string;
  let healDir: string;
  let strictOnlyDir: string;
  let healerLog: string;
  const servers: Server_[] = [];

  const healEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    NODE_ENV: 'test',
    DAEMONIZE_MODE: 'heal',
    DAEMONIZE_HEALER_MODULE: fakeHealerModule,
    DAEMONIZE_FAKE_HEALER_LOG: healerLog,
    DAEMONIZE_FAKE_HEALER_TARGET: 'Delete item',
    DAEMONIZE_STEP_TIMEOUT_MS: '1000',
    DAEMONIZE_WORKFLOW_FILE: workflowFile,
    ...extra,
  });
  const start = async (dir: string, env: Record<string, string>): Promise<Server_> => {
    const server = await connect(dir, env);
    servers.push(server);
    return server;
  };

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(DRIFTED_PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    const startUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;

    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'Heal Page',
      startUrl,
      workflows: [
        workflow('a1111111-1111-4111-8111-111111111111', 'Remove item', [removeStep({}, 1)]),
        workflow('a2222222-2222-4222-8222-222222222222', 'Remove write', [removeStep({ risk: 'write' }, 2)]),
        workflow('a3333333-3333-4333-8333-333333333333', 'Remove allowed', [removeStep({ risk: 'write', allowHeal: true }, 3)]),
      ],
    };

    root = await mkdtemp(join(tmpdir(), 'daemonize-heal-e2e-'));
    workflowFile = join(root, 'workflows.json');
    await writeFile(workflowFile, JSON.stringify(set, null, 2));
    workflowBytes = await readFile(workflowFile, 'utf8');
    await mkdir(join(root, 'workflows.json.assets'));
    for (const n of [1, 2, 3]) await writeFile(join(root, 'workflows.json.assets', `step-${n}.png`), PNG);
    healerLog = join(root, 'healer-calls.log');

    healDir = await compileInto('.heal-e2e-', set, { healSupport: true, workflowFile });
    strictOnlyDir = await compileInto('.heal-e2e-strict-', set, {});
  }, 120000);

  afterAll(async () => {
    for (const server of servers) await closeClient(server.client, server.transport);
    await new Promise<void>((done) => httpServer?.close(() => done()));
    for (const dir of [healDir, strictOnlyDir, root]) if (dir) await removeDir(dir);
  });

  it('fails strictly, with drifted: true and no model call, when the locators no longer match', async () => {
    const server = await start(healDir, { NODE_ENV: 'test', DAEMONIZE_HEALER_MODULE: fakeHealerModule, DAEMONIZE_FAKE_HEALER_LOG: healerLog, DAEMONIZE_STEP_TIMEOUT_MS: '1000' });
    const result = await call(server, 'remove_item');
    expect(result).toMatchObject({ success: false, drifted: true, error: 'step_failed', mode: 'strict' });
    expect(result.failure).toMatchObject({ stepIndex: 0, action: 'click' });
    expect(result.healed).toBeUndefined();
    expect(result.heal).toBeUndefined();
    expect(await lines(healerLog)).toHaveLength(0);
  });

  it('heals with the model, flags it, and leaves the workflow file untouched', async () => {
    const server = await start(healDir, healEnv());
    const result = await call(server, 'remove_item');
    expect(result).toMatchObject({
      success: true,
      mode: 'heal',
      healed: true,
      healedSteps: [{ stepIndex: 0, source: 'model' }],
    });
    expect(result.text).toContain('removed');

    const calls = await lines(healerLog);
    expect(calls).toHaveLength(1);
    // The recorded thumbnail was copied next to the server and given to the model
    expect(JSON.parse(calls[0])).toMatchObject({ intent: "Click the button 'Remove'", thumbnailBytes: PNG.length });

    const cache = JSON.parse(await readFile(join(healDir, '.daemonize', 'heal-cache.json'), 'utf8'));
    expect(Object.keys(cache.entries)).toHaveLength(1);
    expect(sha(await readFile(workflowFile, 'utf8'))).toBe(sha(workflowBytes));
  });

  it('uses the cached locator on the second call, without calling the model', async () => {
    const server = await start(healDir, healEnv());
    const result = await call(server, 'remove_item');
    expect(result).toMatchObject({ success: true, healed: true, healedSteps: [{ stepIndex: 0, source: 'cache' }] });
    expect(await lines(healerLog)).toHaveLength(1);
    expect(await readFile(workflowFile, 'utf8')).toBe(workflowBytes);
  });

  it('never heals a write step unless it has allowHeal', async () => {
    const server = await start(healDir, healEnv());
    const before = (await lines(healerLog)).length;
    const refused = await call(server, 'remove_write');
    expect(refused).toMatchObject({ success: false, drifted: true, error: 'step_failed', mode: 'heal', healed: false, healedSteps: [] });
    expect(refused.heal).toBeUndefined();
    expect((await lines(healerLog)).length).toBe(before);

    const allowed = await call(server, 'remove_allowed');
    expect(allowed).toMatchObject({ success: true, healed: true, healedSteps: [{ stepIndex: 0, source: 'model' }] });
    expect((await lines(healerLog)).length).toBe(before + 1);
  });

  it('returns heal.attempted and the strict failure when the model finds nothing', async () => {
    // Its own cache file, so that the locators cached by the earlier tests are not used
    const isolated = await start(healDir, healEnv({ DAEMONIZE_FAKE_HEALER_TARGET: 'No such button', DAEMONIZE_HEAL_CACHE: join(root, 'empty-cache.json'), DAEMONIZE_FAKE_HEALER_LOG: join(root, 'other.log') }));
    const failed = await call(isolated, 'remove_item');
    expect(failed).toMatchObject({ success: false, drifted: true, error: 'step_failed', healed: false, mode: 'heal' });
    expect(failed.heal).toMatchObject({ attempted: true });
    expect(failed.heal.reason).toMatch(/no mark named No such button/);
  });

  it('reports heal_unavailable when no model is configured, and ignores the test healer module outside NODE_ENV=test', async () => {
    const log = join(root, 'ignored.log');
    const server = await start(healDir, healEnv({ NODE_ENV: 'production', DAEMONIZE_FAKE_HEALER_LOG: log, DAEMONIZE_HEAL_CACHE: join(root, 'unavailable-cache.json') }));
    const result = await call(server, 'remove_item');
    expect(result).toMatchObject({ success: false, drifted: true, error: 'heal_unavailable', mode: 'heal', healed: false });
    expect(result.failure.reason).toMatch(/heal mode was requested but is unavailable: DAEMONIZE_MODEL_PROVIDER is not set/);
    expect(existsSync(log)).toBe(false);
  });

  it('reports heal_unavailable on a server compiled without --heal-support, which holds no model code', async () => {
    const server = await start(strictOnlyDir, healEnv({ DAEMONIZE_HEAL_CACHE: join(root, 'strict-only-cache.json') }));
    const result = await call(server, 'remove_item');
    expect(result).toMatchObject({ success: false, drifted: true, error: 'heal_unavailable', mode: 'heal' });
    expect(result.failure.reason).toMatch(/compiled without --heal-support/);
    expect(existsSync(join(strictOnlyDir, 'heal'))).toBe(false);
  });
});

describe('Heal mode on a canvas, where only coordinates work', () => {
  let httpServer: Server;
  let root: string;
  let outDir: string;
  let log: string;
  const servers: Server_[] = [];

  beforeAll(async () => {
    const html = await readFile(canvasPage, 'utf8');
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(html);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;

    root = await mkdtemp(join(tmpdir(), 'daemonize-heal-canvas-'));
    const file = join(root, 'workflows.json');
    log = join(root, 'healer-calls.log');
    await record({
      url,
      name: 'Canvas',
      label: 'Press go',
      out: file,
      headless: true,
      drive: async (page) => {
        // The "Go" button is drawn at x 150..250, y 120..160 of the canvas, which sits at the page origin
        await page.mouse.click(200, 140);
        await page.waitForFunction(() => document.title === 'Canvas done');
      },
    });
    outDir = await compileInto('.heal-canvas-', deserializeWorkflowSet(await readFile(file, 'utf8')), { healSupport: true, workflowFile: file });
  }, 120000);

  afterAll(async () => {
    for (const server of servers) await closeClient(server.client, server.transport);
    await new Promise<void>((done) => httpServer?.close(() => done()));
    for (const dir of [outDir, root]) if (dir) await removeDir(dir);
  });

  it('records a click on a canvas without selectors, with its rectangle and risk', async () => {
    const set = deserializeWorkflowSet(await readFile(join(root, 'workflows.json'), 'utf8'));
    const step = set.workflows[0].steps[0];
    expect(step.actionType).toBe('click');
    expect(step.selectors).toEqual([]);
    expect(step.anchor).toMatchObject({ role: 'canvas', frame: [] });
    expect(step.risk).toBe('read');
    const rect = step.visual!.rect;
    // The clicked point (200, 140) of a 1280 x 720 viewport
    expect(rect.x + rect.w / 2).toBeCloseTo(200 / 1280, 2);
    expect(rect.y + rect.h / 2).toBeCloseTo(140 / 720, 2);
  });

  it('cannot be replayed strictly: a canvas has no accessible target', async () => {
    const server = await connect(outDir, { ...chromiumEnv, NODE_ENV: 'test' });
    servers.push(server);
    const result = await call(server, 'press_go');
    expect(result).toMatchObject({ success: false, drifted: true, error: 'step_failed', mode: 'strict' });
    expect(result.failure.reason).toMatch(/canvas/);
  });

  it('is replayed in heal mode from the recorded coordinates, with no model call', async () => {
    const server = await connect(outDir, {
      NODE_ENV: 'test',
      DAEMONIZE_MODE: 'heal',
      DAEMONIZE_HEALER_MODULE: fakeHealerModule,
      DAEMONIZE_FAKE_HEALER_LOG: log,
    });
    servers.push(server);
    const result = await call(server, 'press_go');
    expect(result).toMatchObject({ success: true, mode: 'heal', healed: true, healedSteps: [{ stepIndex: 0, source: 'coordinates' }], title: 'Canvas done' });
    expect(existsSync(log)).toBe(false);
  });
});
