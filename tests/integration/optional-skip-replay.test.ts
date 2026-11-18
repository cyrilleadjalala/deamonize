import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { Compiler } from '../../src/compiler/compiler.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const FIXTURE = join(workspaceRoot, 'tests', 'fixtures', 'web', 'optional-fields.html');

const ID_SKIP = '11111111-1111-4111-8111-111111111111';
const ID_RECORDED = '22222222-2222-4222-8222-222222222222';
const ID_ROW = '33333333-3333-4333-8333-333333333333';
const ID_TERM = '44444444-4444-4444-8444-444444444444';

const fillSteps = [
  { actionType: 'type' as const, selectors: ['#name'], value: 'Ada', variable: 'name' },
  { actionType: 'type' as const, selectors: ['#nick'], value: 'recorded', variable: 'nick' },
  { actionType: 'type' as const, selectors: ['#count'], value: '5', variable: 'count' },
  { actionType: 'click' as const, selectors: ['#show'] },
];

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const html = await readFile(FIXTURE, 'utf-8');
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

async function compileAndConnect(set: WorkflowSet, prefix: string): Promise<{ dir: string; client: Client; transport: StdioClientTransport; call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, any>> }> {
  const dir = await mkdtemp(join(workspaceRoot, prefix));
  const log = console.log;
  console.log = () => {};
  try {
    await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
  } finally {
    console.log = log;
  }
  const client = new Client({ name: 'optional-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dir, 'mcp-server.js')],
    cwd: workspaceRoot,
    env: process.env.DAEMONIZE_CHROMIUM_PATH ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH } : undefined,
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return JSON.parse((response.content as Array<{ text: string }>)[0].text) as Record<string, any>;
  };
  return { dir, client, transport, call };
}

describe('optional Variables through generated code (page, row binding)', () => {
  let http: Server;
  let out: Awaited<ReturnType<typeof compileAndConnect>>;
  let toolFor: Record<string, string> = {};

  beforeAll(async () => {
    const started = await startServer();
    http = started.server;
    const workflows: Workflow[] = [
      {
        id: ID_SKIP,
        label: 'Fill skip',
        steps: fillSteps,
        variables: [
          { name: 'name' },
          { name: 'nick', optional: true, whenOmitted: 'skip' },
          { name: 'count', optional: true, whenOmitted: 'skip', type: 'number' },
        ],
        observedPayloads: [{ name: 'Ada', nick: 'recorded', count: 5 }],
      },
      {
        id: ID_RECORDED,
        label: 'Fill recorded',
        steps: fillSteps,
        variables: [{ name: 'name' }, { name: 'nick', optional: true, whenOmitted: 'useRecorded' }, { name: 'count', optional: true, type: 'number' }],
        observedPayloads: [{ name: 'Ada', nick: 'recorded', count: 5 }],
      },
      {
        id: ID_ROW,
        label: 'Remove person',
        steps: [
          {
            actionType: 'click',
            selectors: ['button.remove'],
            rowBinding: { container: { kind: 'row' }, key: { text: 'Ada', column: 'Name' }, variable: 'person' },
          },
        ],
        variables: [{ name: 'person', optional: true, whenOmitted: 'skip' }],
        observedPayloads: [{ person: 'Ada' }],
      },
    ];
    const set: WorkflowSet = { version: '1', targetType: 'web', targetName: 'Optional app', startUrl: started.baseUrl, workflows };
    out = await compileAndConnect(set, '.optional-');
    const names = JSON.parse(await readFile(join(out.dir, 'name-map.json'), 'utf-8')) as Record<string, string>;
    toolFor = names;
  }, 120000);

  afterAll(async () => {
    if (out) {
      await closeClient(out.client, out.transport);
      await removeDir(out.dir);
    }
    await new Promise<void>((done) => (http ? http.close(() => done()) : done()));
  });

  it('skip: the step of an omitted Variable is left out and listed in skippedSteps', async () => {
    const result = await out.call(toolFor[ID_SKIP], { name: 'Zed' });
    expect(result.success).toBe(true);
    expect(result.text).toContain('name=Zed;nick=;count=;');
    expect(result.skippedSteps).toEqual([1, 2]);
  });

  it('supplied values, including the empty text and zero, are used and nothing is skipped', async () => {
    const result = await out.call(toolFor[ID_SKIP], { name: 'Zed', nick: '', count: 0 });
    expect(result.success).toBe(true);
    expect(result.text).toContain('name=Zed;nick=;count=0;');
    expect(result.skippedSteps).toBeUndefined();
    const other = await out.call(toolFor[ID_SKIP], { name: 'Zed', nick: 'Zeddy' });
    expect(other.text).toContain('nick=Zeddy;count=;');
    expect(other.skippedSteps).toEqual([2]);
  });

  it('useRecorded: the recorded value is typed and skippedSteps is absent', async () => {
    const result = await out.call(toolFor[ID_RECORDED], { name: 'Zed' });
    expect(result.success).toBe(true);
    expect(result.text).toContain('name=Zed;nick=recorded;count=5;');
    expect(result.skippedSteps).toBeUndefined();
  });

  it('row binding: an omitted Variable skips the click, a given one selects the row', async () => {
    const skipped = await out.call(toolFor[ID_ROW], {});
    expect(skipped.success).toBe(true);
    expect(skipped.skippedSteps).toEqual([0]);
    expect(skipped.text).not.toContain('removed');
    const given = await out.call(toolFor[ID_ROW], { person: 'Bob' });
    expect(given.success).toBe(true);
    expect(given.text).toContain('removed Bob;');
    expect(given.skippedSteps).toBeUndefined();
  });
});

describe('optional Variables through generated code (terminal step)', () => {
  let out: Awaited<ReturnType<typeof compileAndConnect>>;
  let toolName = '';
  let sourceDir = '';

  beforeAll(async () => {
    sourceDir = await mkdtemp(join(workspaceRoot, '.optional-term-src-'));
    const script = join(sourceDir, 'echo.mjs');
    await writeFile(script, "process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { for (const l of d.split(/\\r?\\n|\\r/)) if (l) console.log('LINE:' + l); });\n");
    const set: WorkflowSet = {
      version: '1',
      targetType: 'tui',
      targetName: 'Optional term',
      startCommand: [process.execPath, script],
      workflows: [
        {
          id: ID_TERM,
          label: 'Type lines',
          steps: [
            { actionType: 'type', selectors: [], value: 'first\r' },
            { actionType: 'type', selectors: [], value: 'second\r', variable: 'second' },
          ],
          variables: [{ name: 'second', optional: true, whenOmitted: 'skip' }],
          observedPayloads: [{ second: 'second\r' }],
        },
      ],
    };
    out = await compileAndConnect(set, '.optional-term-');
    toolName = (JSON.parse(await readFile(join(out.dir, 'name-map.json'), 'utf-8')) as Record<string, string>)[ID_TERM];
  }, 120000);

  afterAll(async () => {
    if (out) {
      await closeClient(out.client, out.transport);
      await removeDir(out.dir);
    }
    if (sourceDir) await removeDir(sourceDir);
  });

  it('skips the typing of an omitted Variable and lists it', async () => {
    const result = await out.call(toolName, {});
    expect(result.success).toBe(true);
    expect(result.text).toContain('LINE:first');
    expect(result.text).not.toContain('LINE:second');
    expect(result.skippedSteps).toEqual([1]);
    const given = await out.call(toolName, { second: 'other\r' });
    expect(given.text).toContain('LINE:other');
    expect(given.skippedSteps).toBeUndefined();
  });
});
