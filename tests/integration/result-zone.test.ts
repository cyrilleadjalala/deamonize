import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 120000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { record } from '../../src/cli/commands/record.js';
import { recordTui, type TerminalInput } from '../../src/cli/commands/record-tui.js';
import { buildProgram } from '../../src/cli/index.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { Validator } from '../../src/validator/validator.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { MENU_KEY } from '../../src/recorder/key-tokenizer.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import { ISOLATED_VAULT_ENV } from '../helpers/isolated-vault.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const reportProgram = join(workspaceRoot, 'tests', 'fixtures', 'report.mjs');

// A page with a lot around what the caller wants: navigation, a ticking clock, a footer
const NOISY_PAGE = `<!doctype html>
<html><head><title>Orders</title></head>
<body>
<nav aria-label="Main"><a href="#home">Home</a> <a href="#reports">Reports</a></nav>
<div id="clock">00:00:00</div>
<main>
  <h1>Orders dashboard</h1>
  <label for="token">API token</label><input id="token" type="text" />
  <button id="show" type="button">Show orders</button>
  <section id="results" hidden>
    <table id="orders" aria-label="Orders">
      <thead><tr><th>ID</th><th> Customer </th><th>Total</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>Ada Lovelace</td><td>10.50</td></tr>
        <tr><td>2</td><td>Bob</td><td>7</td></tr>
      </tbody>
    </table>
    <pre id="payload">{"status":"ok","items":[1,2,3],"owner":{"name":"Ada"}}</pre>
    <ul id="echo"></ul>
  </section>
</main>
<footer>Copyright Noise Corp 2024</footer>
<script>
  setInterval(() => { document.getElementById('clock').textContent = 'tick ' + Date.now(); }, 30);
  document.getElementById('show').addEventListener('click', () => {
    document.getElementById('results').hidden = false;
    const li = document.createElement('li');
    li.textContent = 'token: ' + document.getElementById('token').value;
    document.getElementById('echo').appendChild(li);
  });
</script>
</body></html>`;

const NOISE = ['Noise Corp', 'Home', 'Reports', 'tick', 'Orders dashboard'];

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => { };
  try {
    return await run();
  } finally {
    console.log = log;
  }
}

describe('Result_Zone on a web page: record → compile → call over MCP', () => {
  let httpServer: Server;
  let dir: string;
  let outputDir: string;
  let client: Client;
  let transport: StdioClientTransport;
  let set: WorkflowSet;
  let toolOf: Map<string, string>;
  let recorded: { table: Workflow; byMark: Workflow; json: Workflow };

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(NOISY_PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;

    dir = await mkdtemp(join(tmpdir(), 'daemonize-zone-'));
    const out = join(dir, 'workflows.json');

    // 1. The zone given on the command line, kind suggested from the element
    const first = await quiet(() =>
      record({
        url, name: 'Orders', label: 'List orders', out, headless: true, resultZone: '#orders',
        drive: async (page) => {
          await page.getByRole('button', { name: 'Show orders' }).click();
          await page.locator('#orders').waitFor();
        },
      })
    );
    expect(first.resultZone).toEqual({ selector: '#orders', kind: 'table' });

    // 2. The element clicked after "Mark result" (here its keyboard shortcut): a cell leads to the table
    const second = await quiet(() =>
      record({
        url, name: 'Orders', label: 'Orders by mark', out, headless: true,
        drive: async (page) => {
          await page.getByRole('button', { name: 'Show orders' }).click();
          await page.keyboard.press('Alt+Shift+R');
          await page.locator('#orders td').first().click();
          await page.locator('[data-daemonize-action=result-kind]').waitFor();
          expect(await page.locator('[data-daemonize-action=result-kind]').inputValue()).toBe('table');
        },
      })
    );
    expect(second.steps).toBe(1); // the click that marks the zone is not a step

    // 3. The same, for a <pre> that holds JSON: the kind is suggested from the element
    await quiet(() =>
      record({
        url, name: 'Orders', label: 'Show payload', out, headless: true,
        drive: async (page) => {
          await page.getByRole('button', { name: 'Show orders' }).click();
          // The panel button does what the shortcut does: no keyboard needed
          await page.getByRole('button', { name: 'Choose the result to capture' }).click();
          await page.locator('#payload').click();
          await page.locator('[data-daemonize-action=result-kind]').waitFor();
          expect(await page.locator('[data-daemonize-action=result-kind]').inputValue()).toBe('json');
        },
      })
    );

    const fromFile = deserializeWorkflowSet(await readFile(out, 'utf-8'));
    const byLabel = (label: string): Workflow => fromFile.workflows.find((w) => w.label === label) as Workflow;
    recorded = { table: byLabel('List orders'), byMark: byLabel('Orders by mark'), json: byLabel('Show payload') };

    // 4. Hand-written variations of the recorded workflow: a zone that matches nothing, and one that holds a secret
    const missing: Workflow = {
      ...structuredClone(recorded.table),
      id: '99999999-9999-4999-8999-999999999999',
      label: 'Missing zone',
      resultZone: { selector: '#nope', extractor: { kind: 'list' } },
    };
    const secret: Workflow = {
      ...structuredClone(recorded.table),
      id: '88888888-8888-4888-8888-888888888888',
      label: 'Echo token',
      steps: [
        { actionType: 'type', selectors: ['#token'], secretRef: 'TOKEN' },
        ...structuredClone(recorded.table.steps),
      ],
      resultZone: { selector: '#echo', extractor: { kind: 'list' } },
      secrets: [{ name: 'TOKEN', kind: 'token' }],
    };
    delete secret.finalScreenId;
    set = new SchemaInferencer().inferWorkflows({ ...fromFile, workflows: [...fromFile.workflows, missing, secret] });

    outputDir = await mkdtemp(join(workspaceRoot, '.zone-e2e-'));
    const compiled = await quiet(() => new Compiler().compile(set, outputDir));
    toolOf = new Map(set.workflows.map((w) => [w.label, compiled.toolNames.get(w.id) as string]));

    client = new Client({ name: 'zone-e2e', version: '1.0.0' });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(outputDir, 'mcp-server.js')],
      cwd: workspaceRoot,
      env: {
        ...ISOLATED_VAULT_ENV,
        DAEMONIZE_STEP_TIMEOUT_MS: '1500',
        DAEMONIZE_SECRET_TOKEN: 's3cr3t-value',
        ...(process.env.DAEMONIZE_CHROMIUM_PATH ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH } : {}),
      },
    });
    await client.connect(transport);
  }, 180000);

  afterAll(async () => {
    await closeClient(client, transport);
    await new Promise<void>((done) => httpServer?.close(() => done()));
    if (outputDir) await removeDir(outputDir);
    if (dir) await removeDir(dir);
  });

  async function call(label: string): Promise<{ isError: boolean; result: Record<string, any>; raw: string }> {
    const response = await client.callTool({ name: toolOf.get(label) as string, arguments: {} });
    const raw = (response.content as Array<{ text: string }>)[0].text;
    return { isError: response.isError === true, result: JSON.parse(raw), raw };
  }

  const expectedRows = [
    { ID: '1', Customer: 'Ada Lovelace', Total: '10.50' },
    { ID: '2', Customer: 'Bob', Total: '7' },
  ];

  function expectNoNoise(text: string): void {
    for (const noise of NOISE) expect(text, `"${noise}" leaked into the result`).not.toContain(noise);
  }

  it('stores the zones on the workflows, with a robust selector and the schema of data', () => {
    expect(recorded.table.resultZone).toMatchObject({ selector: '#orders', extractor: { kind: 'table' } });
    expect(recorded.table.resultZone?.schema).toMatchObject({
      type: 'array',
      items: { properties: { ID: { type: 'string' }, Customer: { type: 'string' }, Total: { type: 'string' } } },
    });
    // The zone marked in the page is found by role and accessible name first
    expect(recorded.byMark.resultZone).toMatchObject({ selector: 'role=table[name="Orders"]', extractor: { kind: 'table' } });
    expect(recorded.json.resultZone).toMatchObject({ selector: '#payload', extractor: { kind: 'json' } });
  });

  it('returns the rows of the table as data, and only the zone as text', async () => {
    const { isError, result } = await call('List orders');

    expect(isError).toBe(false);
    expect(result).toMatchObject({ success: true, screenType: 'dom' });
    expect(result.data).toEqual(expectedRows);
    expect(result.text).toContain('Ada Lovelace');
    expectNoNoise(result.text);
    expectNoNoise(JSON.stringify(result.data));
  });

  it('reads the zone marked in the page the same way', async () => {
    const { result } = await call('Orders by mark');

    expect(result.data).toEqual(expectedRows);
    expectNoNoise(result.text);
  });

  it('parses a JSON <pre> into data', async () => {
    const { result } = await call('Show payload');

    expect(result.data).toEqual({ status: 'ok', items: [1, 2, 3], owner: { name: 'Ada' } });
    expectNoNoise(result.text);
  });

  it('describes `data` in OpenAPI, and the actual data validates against it', async () => {
    const openapi = JSON.parse(await readFile(join(outputDir, 'openapi.json'), 'utf-8'));
    const schemaOf = (workflow: Workflow): Record<string, unknown> =>
      openapi.paths[`/actions/${workflow.id}`].post.responses['200'].content['application/json'].schema;

    const listSchema = schemaOf(set.workflows.find((w) => w.label === 'List orders') as Workflow) as any;
    expect(listSchema.properties.data).toMatchObject({
      type: 'array',
      items: { type: 'object', properties: { ID: { type: 'string' }, Customer: { type: 'string' }, Total: { type: 'string' } } },
    });

    const labels = ['List orders', 'Orders by mark', 'Show payload'];
    const validator = new Validator(
      new Map(labels.map((label) => [label, schemaOf(set.workflows.find((w) => w.label === label) as Workflow)]))
    );
    for (const label of labels) {
      const { result } = await call(label);
      expect(validator.validate(label, result), `${label}: ${JSON.stringify(result)}`).toBeNull();
    }
    // The schema is not vacuous: data of another shape is refused
    const { result } = await call('List orders');
    expect(validator.validate('List orders', { ...result, data: 'plain text' })).not.toBeNull();
  });

  it('puts the shape of data in the description of the tool and in SKILL.md', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === toolOf.get('List orders'));
    expect(tool?.description).toContain('Returns data: an array of objects, one per table row');
    expect(tool?.description).toContain('ID, Customer, Total');

    const skill = await readFile(join(outputDir, 'skills', 'orders', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('Returns data: an array of objects');
  });

  it('fails strictly when the zone matches nothing, and says the action already ran', async () => {
    const { isError, result } = await call('Missing zone');

    expect(isError).toBe(true);
    expect(result).toMatchObject({
      success: false,
      error: 'result_zone_not_found',
      drifted: true,
      failure: { zone: { selector: '#nope' } },
    });
    expect(result.message).toMatch(/already ran/);
    expect(result).not.toHaveProperty('data');
  });

  it('removes secret values from data and text', async () => {
    const { result, raw } = await call('Echo token');

    expect(result.success).toBe(true);
    expect(result.data).toEqual(['token: ***']);
    expect(raw).not.toContain('s3cr3t-value');
  });

  it('keeps the whole page text, without data, for a workflow without a zone', async () => {
    const plain = new SchemaInferencer().inferWorkflows({
      ...set,
      workflows: [{ ...structuredClone(recorded.table), id: '77777777-7777-4777-8777-777777777777', label: 'Whole page', resultZone: undefined }],
    });
    delete plain.workflows[0].resultZone;
    const plainDir = await mkdtemp(join(workspaceRoot, '.zone-plain-'));
    try {
      await quiet(() => new Compiler().compile(plain, plainDir));
      const plainClient = new Client({ name: 'zone-plain', version: '1.0.0' });
      const plainTransport = new StdioClientTransport({
        command: process.execPath,
        args: [join(plainDir, 'mcp-server.js')],
        cwd: workspaceRoot,
        env: { ...ISOLATED_VAULT_ENV, ...(process.env.DAEMONIZE_CHROMIUM_PATH ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH } : {}) },
      });
      await plainClient.connect(plainTransport);
      try {
        const response = await plainClient.callTool({ name: 'whole_page', arguments: {} });
        const result = JSON.parse((response.content as Array<{ text: string }>)[0].text);
        expect(result.success).toBe(true);
        expect(result.text).toContain('Noise Corp');
        expect(result).not.toHaveProperty('data');
      } finally {
        await closeClient(plainClient, plainTransport);
      }
    } finally {
      await removeDir(plainDir);
    }
  });
});

describe('Result_Zone parsed from the CLI options', () => {
  it('rejects options for the wrong kind of target', async () => {
    const parse = (...args: string[]) => buildProgram().parseAsync(['node', 'daemonize', 'record', ...args]);
    await expect(parse('http://x/', '-l', 'a', '--result-rect', '1,1,2,2')).rejects.toThrow(/terminal recordings/);
    await expect(parse('http://x/', '-l', 'a', '--result-zone', '#t', '--result-kind', 'regex')).rejects.toThrow(/Unknown --result-kind/);
    await expect(parse('http://x/', '-l', 'a', '--result-kind', 'table')).rejects.toThrow(/needs --result-zone/);
    await expect(parse('-t', 'tui', '-l', 'a', '--result-zone', '#t', '--', 'node')).rejects.toThrow(/web recordings/);
  });
});

/** A user at a terminal: bytes in, what the program shows out. */
function fakeTerminal() {
  const stream = new PassThrough();
  stream.setEncoding('utf8');
  let shown = '';
  return {
    input: stream as unknown as TerminalInput,
    output: { write: (data: string) => (shown += data), columns: 80, rows: 24 },
    type: (bytes: string) => stream.write(bytes),
    async waitFor(text: string, timeoutMs = 10000) {
      const startedAt = Date.now();
      while (!shown.includes(text)) {
        if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for "${text}"; saw: ${JSON.stringify(shown)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

describe('Result_Zone on a terminal program: record → compile → call over MCP', () => {
  let dir: string;
  let outputDir: string;
  let client: Client;
  let transport: StdioClientTransport;
  let set: WorkflowSet;
  let toolOf: Map<string, string>;

  async function recordReport(out: string, label: string, zone: Parameters<typeof recordTui>[0]): Promise<void> {
    const terminal = fakeTerminal();
    const recording = quiet(() => recordTui({ ...zone, command: [process.execPath, reportProgram], name: 'Inventory', label, out, input: terminal.input, output: terminal.output }));
    await terminal.waitFor('Press Enter');
    terminal.type('\r');
    await terminal.waitFor('Status: OK');
    terminal.type(MENU_KEY);
    terminal.type('e');
    await recording;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-zone-tui-'));
    const out = join(dir, 'workflows.json');

    const base = { command: [], name: '', label: '', out };
    await recordReport(out, 'Stock table', {
      ...base,
      resultRect: { row: 2, col: 0, rows: 4, cols: 40 },
      resultRegex: '^(?<id>\\d+)\\s+(?<name>\\w+)\\s+(?<qty>\\d+)$',
      resultRegexFlags: 'gm',
    });
    await recordReport(out, 'Stock status', {
      ...base,
      resultRect: { row: 6, col: 0, rows: 1, cols: 40 },
      resultRegex: 'Status: (?<state>\\w+) \\((?<count>\\d+) items\\)',
    });
    await recordReport(out, 'Stock banner', { ...base, resultRect: { row: 0, col: 0, rows: 1, cols: 40 } });

    const fromFile = deserializeWorkflowSet(await readFile(out, 'utf-8'));
    const missing: Workflow = {
      ...structuredClone(fromFile.workflows[0]),
      id: '66666666-6666-4666-8666-666666666666',
      label: 'Stock total',
      resultZone: { rect: { row: 6, col: 0, rows: 1, cols: 40 }, extractor: { kind: 'regex', pattern: 'Total: (?<n>\\d+)' } },
    };
    set = new SchemaInferencer().inferWorkflows({ ...fromFile, workflows: [...fromFile.workflows, missing] });

    outputDir = await mkdtemp(join(workspaceRoot, '.zone-tui-e2e-'));
    const compiled = await quiet(() => new Compiler().compile(set, outputDir));
    toolOf = new Map(set.workflows.map((w) => [w.label, compiled.toolNames.get(w.id) as string]));

    client = new Client({ name: 'zone-tui-e2e', version: '1.0.0' });
    transport = new StdioClientTransport({ command: process.execPath, args: [join(outputDir, 'mcp-server.js')], cwd: workspaceRoot, env: { ...ISOLATED_VAULT_ENV } });
    await client.connect(transport);
  }, 180000);

  afterAll(async () => {
    await closeClient(client, transport);
    if (outputDir) await removeDir(outputDir);
    if (dir) await removeDir(dir);
  });

  async function call(label: string): Promise<{ isError: boolean; result: Record<string, any> }> {
    const response = await client.callTool({ name: toolOf.get(label) as string, arguments: {} });
    return { isError: response.isError === true, result: JSON.parse((response.content as Array<{ text: string }>)[0].text) };
  }

  it('returns every match of the pattern as an array of objects, and only the rectangle as text', async () => {
    const { result } = await call('Stock table');

    expect(result).toMatchObject({ success: true, screenType: 'terminal' });
    expect(result.data).toEqual([
      { id: '1', name: 'Widget', qty: '5' },
      { id: '2', name: 'Gadget', qty: '12' },
      { id: '3', name: 'Gizmo', qty: '0' },
    ]);
    expect(result.text).toContain('Gadget');
    expect(result.text).not.toContain('INVENTORY');
    expect(result.text).not.toContain('Status');
  });

  it('returns the named groups of a status line as an object', async () => {
    const { result } = await call('Stock status');

    expect(result.data).toEqual({ state: 'OK', count: '3' });
    expect(result.text).toBe('Status: OK (3 items)');
  });

  it('returns the text of a rectangle without extractor', async () => {
    const { result } = await call('Stock banner');

    expect(result.data).toBe('INVENTORY TERMINAL v1');
    expect(result.text).toBe('INVENTORY TERMINAL v1');
  });

  it('validates the data of every tool against the output schema of OpenAPI', async () => {
    const openapi = JSON.parse(await readFile(join(outputDir, 'openapi.json'), 'utf-8'));
    const labels = ['Stock table', 'Stock status', 'Stock banner'];
    const schemas = new Map(
      labels.map((label) => {
        const workflow = set.workflows.find((w) => w.label === label) as Workflow;
        return [label, openapi.paths[`/actions/${workflow.id}`].post.responses['200'].content['application/json'].schema];
      })
    );
    const validator = new Validator(schemas);
    for (const label of labels) {
      const { result } = await call(label);
      expect(validator.validate(label, result), label).toBeNull();
    }
    expect(schemas.get('Stock status')).toMatchObject({ properties: { data: { type: 'object', properties: { state: { type: 'string' }, count: { type: 'string' } } } } });
  });

  it('fails strictly when the pattern matches nothing in the zone', async () => {
    const { isError, result } = await call('Stock total');

    expect(isError).toBe(true);
    expect(result).toMatchObject({
      success: false,
      error: 'result_zone_not_found',
      drifted: true,
      failure: { zone: { rect: { row: 6, col: 0, rows: 1, cols: 40 } } },
    });
    expect(result.message).toMatch(/already ran/);
  });
});
