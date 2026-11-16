import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { cropTerminal, screenId } from '../../src/replay/runtime/screen-hash.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const chromiumEnv = process.env.DAEMONIZE_CHROMIUM_PATH
  ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH }
  : undefined;

async function compileInto(prefix: string, set: WorkflowSet): Promise<string> {
  // Under the workspace so the generated server finds its dependencies in node_modules
  const dir = await mkdtemp(join(workspaceRoot, prefix));
  const log = console.log;
  console.log = () => { };
  try {
    await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
  } finally {
    console.log = log;
  }
  return dir;
}

async function call(client: Client, name: string): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: {} });
  const content = response.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

function workflow(id: string, label: string, steps: Workflow['steps'], extra: Partial<Workflow> = {}): Workflow {
  return { id, label, steps, variables: [], observedPayloads: [], ...extra };
}

describe('Drift of a web page (record → compile → serve → call)', () => {
  let httpServer: Server;
  let outputDir: string;
  let client: Client;
  let webTransport: StdioClientTransport;
  let message = 'v1';
  let tick = 0;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      res.setHeader('content-type', 'text/html');
      if (path === '/result') {
        // The clock changes on every request, like a live clock on a dashboard
        tick += 1;
        res.end(`<!doctype html><html><head><title>Result</title></head><body>
<p id="msg">${message}</p><p id="clock">${tick}</p></body></html>`);
      } else if (path === '/static') {
        res.end('<!doctype html><html><head><title>Static</title></head><body><p id="msg">fixed</p></body></html>');
      } else {
        res.end('<!doctype html><html><head><title>Home</title></head><body><a id="go" href="/result">Go</a> <a id="stat" href="/static">Static</a></body></html>');
      }
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    const { port } = httpServer.address() as AddressInfo;
    const startUrl = `http://127.0.0.1:${port}/`;

    // What the recorder keeps: the final page, or the zone of it
    const browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
    const recordFinal = async (link: string, zone?: string): Promise<string> => {
      const page = await browser.newPage();
      try {
        await page.goto(startUrl);
        await page.click(link);
        await page.waitForLoadState('networkidle');
        return screenId('dom', zone ? await page.locator(zone).first().evaluate((el: Element) => el.outerHTML) : await page.content());
      } finally {
        await page.close();
      }
    };
    let ids: string[];
    try {
      ids = [await recordFinal('#go'), await recordFinal('#go', '#msg'), await recordFinal('#stat')];
    } finally {
      await browser.close();
    }

    const step = (selector: string) => [{ actionType: 'click' as const, selectors: [selector] }];
    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'Drift Page',
      startUrl,
      workflows: [
        workflow('a1111111-1111-4111-8111-111111111111', 'Clock whole page', step('#go'), { finalScreenId: ids[0] as Workflow['finalScreenId'] }),
        workflow('a2222222-2222-4222-8222-222222222222', 'Clock zone', step('#go'), {
          finalScreenId: ids[1] as Workflow['finalScreenId'],
          finalZone: { selector: '#msg' },
        }),
        workflow('a3333333-3333-4333-8333-333333333333', 'Static page', step('#stat'), { finalScreenId: ids[2] as Workflow['finalScreenId'] }),
        workflow('a4444444-4444-4444-8444-444444444444', 'No final screen', step('#go')),
        workflow('a5555555-5555-4555-8555-555555555555', 'Missing zone', step('#go'), {
          finalScreenId: ids[1] as Workflow['finalScreenId'],
          finalZone: { selector: '#nothing-here' },
        }),
      ],
    };
    outputDir = await compileInto('.drift-web-', set);
    client = new Client({ name: 'drift-web-test', version: '1.0.0' });
    webTransport = new StdioClientTransport({ command: process.execPath, args: [join(outputDir, 'mcp-server.js')], cwd: workspaceRoot, env: chromiumEnv });
    await client.connect(webTransport);
  }, 90000);

  afterAll(async () => {
    await closeClient(client, webTransport);
    await new Promise<void>((done) => httpServer?.close(() => done()));
    if (outputDir) await removeDir(outputDir);
  });

  it('is not drifted when the final page is the recorded one', async () => {
    expect(await call(client, 'static_page')).toMatchObject({ success: true, drifted: false, driftChecked: true });
  }, 30000);

  it('is drifted without a zone when a live clock changes the page, and not with the zone', async () => {
    expect(await call(client, 'clock_whole_page')).toMatchObject({ success: true, drifted: true, driftChecked: true });
    expect(await call(client, 'clock_zone')).toMatchObject({ success: true, drifted: false, driftChecked: true });
  }, 60000);

  it('reports drifted: false and driftChecked: false when no final screen was recorded', async () => {
    expect(await call(client, 'no_final_screen')).toMatchObject({ success: true, drifted: false, driftChecked: false });
  }, 30000);

  it('is drifted, with success still true, when the text of the zone changes', async () => {
    message = 'v2';
    expect(await call(client, 'clock_zone')).toMatchObject({ success: true, drifted: true, driftChecked: true });
  }, 30000);

  it('counts a zone that matches nothing as drifted', async () => {
    expect(await call(client, 'missing_zone')).toMatchObject({ success: true, drifted: true });
  }, 30000);
});

describe('Drift of a terminal program (record → compile → serve → call)', () => {
  let outputDir: string;
  let dataDir: string;
  let statusFile: string;
  let client: Client;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'daemonize-drift-'));
    statusFile = join(dataDir, 'status.txt');
    await writeFile(statusFile, 'v1');

    const clockprog = join(workspaceRoot, 'tests', 'fixtures', 'clockprog.mjs');
    const greeter = join(workspaceRoot, 'tests', 'fixtures', 'greeter.mjs');
    const rect = { row: 0, col: 0, rows: 1, cols: 40 };
    // The screens as the recorder keeps them (terminal text, no trailing blanks)
    const clockScreen = (status: string) => `Status: ${status}\nClock: 1\nPress enter: \nDone`;
    const greeterScreen = 'Your name: Ada\nHello Ada!\nChoose [1] Greet again, [2] Quit: 1\nHello again Ada!';

    const enter = [{ actionType: 'keypress' as const, selectors: [], value: 'Enter' }];
    const clock = (id: string, label: string, extra: Partial<Workflow>) => workflow(id, label, enter, extra);
    const set: WorkflowSet = {
      version: '1',
      targetType: 'tui',
      targetName: 'Clock Program',
      startCommand: [process.execPath, clockprog, statusFile],
      workflows: [
        clock('b1111111-1111-4111-8111-111111111111', 'Clock whole screen', {
          finalScreenId: screenId('terminal', clockScreen('v1')) as Workflow['finalScreenId'],
        }),
        clock('b2222222-2222-4222-8222-222222222222', 'Clock zone', {
          finalScreenId: screenId('terminal', cropTerminal(clockScreen('v1'), rect)) as Workflow['finalScreenId'],
          finalZone: { rect },
        }),
        clock('b3333333-3333-4333-8333-333333333333', 'No final screen', {}),
      ],
    };
    // The greeter has no clock: its recorded screen must be recognised exactly
    const greeterSet: WorkflowSet = {
      version: '1',
      targetType: 'tui',
      targetName: 'Greeter Drift',
      startCommand: [process.execPath, greeter],
      workflows: [
        workflow(
          'b4444444-4444-4444-8444-444444444444',
          'Greet Ada',
          [
            { actionType: 'type', selectors: [], value: 'Ada' },
            { actionType: 'keypress', selectors: [], value: 'Enter' },
            { actionType: 'type', selectors: [], value: '1' },
            { actionType: 'keypress', selectors: [], value: 'Enter' },
          ],
          { finalScreenId: screenId('terminal', greeterScreen) as Workflow['finalScreenId'] },
        ),
      ],
    };

    outputDir = await compileInto('.drift-tui-', set);
    greeterDir = await compileInto('.drift-tui-greeter-', greeterSet);
    client = new Client({ name: 'drift-tui-test', version: '1.0.0' });
    tuiTransport = new StdioClientTransport({ command: process.execPath, args: [join(outputDir, 'mcp-server.js')], cwd: workspaceRoot });
    await client.connect(tuiTransport);
    greeterClient = new Client({ name: 'drift-tui-greeter-test', version: '1.0.0' });
    greeterTransport = new StdioClientTransport({ command: process.execPath, args: [join(greeterDir, 'mcp-server.js')], cwd: workspaceRoot });
    await greeterClient.connect(greeterTransport);
  }, 90000);

  let greeterDir: string;
  let greeterClient: Client;
  let tuiTransport: StdioClientTransport;
  let greeterTransport: StdioClientTransport;

  afterAll(async () => {
    await closeClient(client, tuiTransport);
    await closeClient(greeterClient, greeterTransport);
    for (const dir of [outputDir, greeterDir, dataDir]) {
      if (dir) await removeDir(dir);
    }
  });

  it('is not drifted when the final screen is the recorded one', async () => {
    expect(await call(greeterClient, 'greet_ada')).toMatchObject({ success: true, drifted: false, driftChecked: true });
  }, 60000);

  it('is drifted without a zone when a live clock changes the screen, and not with the zone', async () => {
    expect(await call(client, 'clock_whole_screen')).toMatchObject({ success: true, drifted: true, driftChecked: true });
    expect(await call(client, 'clock_zone')).toMatchObject({ success: true, drifted: false, driftChecked: true });
  }, 60000);

  it('reports driftChecked: false when no final screen was recorded', async () => {
    expect(await call(client, 'no_final_screen')).toMatchObject({ success: true, drifted: false, driftChecked: false });
  }, 30000);

  it('is drifted, with success still true, when the zone text changes', async () => {
    await writeFile(statusFile, 'v2');
    expect(await call(client, 'clock_zone')).toMatchObject({ success: true, drifted: true, driftChecked: true });
  }, 30000);
});
