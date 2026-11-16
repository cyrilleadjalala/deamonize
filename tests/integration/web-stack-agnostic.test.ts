/**
 * The generated web replay is independent of the front-end stack and strict: every scenario is
 * recorded with the LiveRecorder, compiled, and called over MCP on the same page, on a restyled
 * one, and on a page whose accessible name changed (the strict failure).
 *
 * The fixture pages (tests/fixtures/web/stack-*.html) contain `{{record@@replay@@broken@@broken2}}`
 * markers: the server renders the variant of the current `mode`, so one file describes the page
 * at record time, the same page restyled, and the page after a rename. Every control reports what
 * it did to POST /log, which tells which steps ran.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { record } from '../../src/cli/commands/record.js';
import { Compiler } from '../../src/compiler/compiler.js';
import type { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';

const FIXTURES = new URL('../fixtures/web/', import.meta.url);
const workspaceRoot = resolve(import.meta.dirname, '../..');
const MODES = { record: 0, replay: 1, broken: 2, broken2: 3 } as const;
type Mode = keyof typeof MODES;

let mode: Mode = 'record';
const events: string[] = [];

/** The page of the current mode: `{{record@@replay@@broken@@broken2}}`, a missing variant is the recorded text. */
function render(source: string): string {
  return source.replace(/\{\{([\s\S]*?)\}\}/g, (_all, body: string) => {
    const parts = body.split('@@');
    return parts[MODES[mode]] ?? parts[0];
  });
}

interface Result {
  success: boolean;
  drifted?: boolean;
  driftChecked?: boolean;
  error?: string;
  text?: string;
  failure?: {
    stepIndex: number;
    label: string;
    action: string;
    risk: string;
    tried: string[];
    reason: string;
    screenshot?: string;
    thumbnail?: string;
    missingSecret?: string;
  };
}

describe('the generated web replay does not depend on the front-end stack', () => {
  let httpServer: Server;
  let baseUrl: string;
  const dirs: string[] = [];
  const open: Array<{ client: Client; transport: StdioClientTransport }> = [];

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/log') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          events.push(body);
          res.statusCode = 204;
          res.end();
        });
        return;
      }
      const name = url.pathname.slice(1);
      if (!/^stack-[a-z-]+\.html$/.test(name) || !existsSync(new URL(name, FIXTURES))) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(render(readFileSync(new URL(name, FIXTURES), 'utf8')));
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    for (const { client, transport } of open) await closeClient(client, transport);
    httpServer?.closeAllConnections();
    await new Promise<void>((done) => httpServer?.close(() => done()));
    for (const dir of dirs) await removeDir(dir);
  }, 60000);

  interface Stack {
    tool: string;
    call(args: Record<string, unknown>, on: Mode): Promise<{ result: Result; events: string[] }>;
    connect(env?: Record<string, string>): Promise<Stack>;
  }

  /** Record a workflow on `path`, compile it and start the generated server. */
  async function build(options: {
    path: string;
    label: string;
    drive: (page: Page, live: LiveRecorder) => Promise<void>;
    adjust?: (set: WorkflowSet) => void;
  }): Promise<Stack> {
    mode = 'record';
    const work = await mkdtemp(join(tmpdir(), 'daemonize-stack-'));
    dirs.push(work);
    const out = join(work, 'workflows.json');
    await record({
      url: baseUrl + options.path,
      name: 'stack-app',
      label: options.label,
      out,
      headless: true,
      drive: options.drive,
    });
    const set = deserializeWorkflowSet(readFileSync(out, 'utf8'));
    options.adjust?.(set);

    // Under the workspace so the generated server finds its dependencies in node_modules
    const dir = await mkdtemp(join(workspaceRoot, '.stack-'));
    dirs.push(dir);
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
    } finally {
      console.log = log;
    }

    const connect = async (env: Record<string, string> = {}): Promise<Stack> => {
      const client = new Client({ name: 'stack-test', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(dir, 'mcp-server.js')],
        cwd: workspaceRoot,
        env: {
          DAEMONIZE_STEP_TIMEOUT_MS: '3000',
          ...(process.env.DAEMONIZE_CHROMIUM_PATH ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH } : {}),
          ...env,
        },
      });
      await client.connect(transport);
      open.push({ client, transport });
      const tool = (await client.listTools()).tools[0].name;
      return {
        tool,
        connect,
        async call(args, on) {
          mode = on;
          events.length = 0;
          const response = await client.callTool({ name: tool, arguments: args });
          // The last beacon of the page may still be on its way
          await new Promise<void>((done) => setTimeout(done, 150));
          const content = response.content as Array<{ text: string }>;
          return { result: JSON.parse(content[0].text) as Result, events: [...events] };
        },
      };
    };
    return connect();
  }

  /** What every strict failure reports: no guess, the step, what was tried, a picture. */
  function expectStrictFailure(result: Result, stepIndex: number): NonNullable<Result['failure']> {
    expect(result).toMatchObject({ success: false, drifted: true, error: 'step_failed' });
    const failure = result.failure!;
    expect(failure.stepIndex).toBe(stepIndex);
    expect(failure.tried.length).toBeGreaterThan(0);
    expect(failure.reason.length).toBeGreaterThan(0);
    expect(failure.screenshot).toMatch(/\.png$/);
    expect(existsSync(failure.screenshot!)).toBe(true);
    return failure;
  }

  // -------------------------------------------------------------------------
  it('(a) a portal combobox and listbox: the option comes from the Payload, the page may be restyled', async () => {
    const stack = await build({
      path: 'stack-portal.html',
      label: 'Order a plan',
      drive: async (page) => {
        await page.getByRole('combobox', { name: 'Plan' }).click();
        await page.getByRole('option', { name: 'Pro' }).click();
        await page.getByRole('button', { name: 'Save order' }).click();
        await page.getByRole('button', { name: 'Done' }).click();
        await page.waitForTimeout(200);
      },
      adjust: (set) => {
        // The user edits the workflow file: the option is chosen by a Variable
        const workflow = set.workflows[0];
        workflow.steps[1].variable = 'plan';
        workflow.variables = [{ name: 'plan' }];
        workflow.observedPayloads = [{ plan: 'Pro' }];
      },
    });

    const same = await stack.call({ plan: 'Pro' }, 'record');
    expect(same.result).toMatchObject({ success: true, drifted: false, driftChecked: true });
    expect(same.events).toEqual(['open', 'plan:Pro', 'order:Pro', 'done']);

    // Other option, extra wrapper elements and hashed class names
    const restyled = await stack.call({ plan: 'Free' }, 'replay');
    expect(restyled.result).toMatchObject({ success: true, drifted: true });
    expect(restyled.events).toEqual(['open', 'plan:Free', 'order:Free', 'done']);

    // "Save order" was renamed: nothing is guessed and "Done" never runs
    const broken = await stack.call({ plan: 'Free' }, 'broken');
    const failure = expectStrictFailure(broken.result, 2);
    expect(failure).toMatchObject({ action: 'click', risk: 'write' });
    expect(failure.tried[0]).toContain("getByRole('button', { name: 'Save order', exact: true })");
    expect(broken.events).toEqual(['open', 'plan:Free']);
  });

  // -------------------------------------------------------------------------
  it('(b) two "Save" buttons: the one in the dialog is found through the dialog, and never by guessing', async () => {
    const stack = await build({
      path: 'stack-dialog.html',
      label: 'Edit a customer',
      drive: async (page) => {
        await page.locator('form').getByRole('button', { name: 'Save' }).click();
        await page.getByRole('button', { name: 'Edit customer' }).click();
        await page.getByRole('dialog', { name: 'Edit customer details' }).getByRole('button', { name: 'Save' }).click();
        await page.getByRole('button', { name: 'Done' }).click();
        await page.waitForTimeout(200);
      },
    });

    const ok = await stack.call({}, 'replay');
    expect(ok.result).toMatchObject({ success: true, drifted: false });
    expect(ok.events).toEqual(['page-save', 'dialog-open', 'dialog-save', 'done']);

    // The dialog changed its name: two "Save" buttons remain and neither is chosen
    const broken = await stack.call({}, 'broken');
    const failure = expectStrictFailure(broken.result, 2);
    expect(failure.tried[0]).toContain("in dialog 'Edit customer details'");
    expect(failure.reason).toMatch(/ambiguous/);
    expect(broken.events).toEqual(['page-save', 'dialog-open']);
  });

  // -------------------------------------------------------------------------
  it('(c) an iframe: found by its index, then by its name when another frame took its place', async () => {
    const stack = await build({
      path: 'stack-frame.html',
      label: 'Search in a frame',
      drive: async (page, live) => {
        await page.getByRole('button', { name: 'Start' }).click();
        const child = page.frameLocator('iframe[name=child]');
        await child.getByRole('textbox', { name: 'Query' }).click();
        await page.keyboard.type('cats');
        await child.getByRole('button', { name: 'Search' }).click();
        await page.getByRole('button', { name: 'Done' }).click();
        await page.waitForTimeout(300);
        live.markVariable(1, { name: 'query' });
      },
    });

    const same = await stack.call({ query: 'cats' }, 'record');
    expect(same.result).toMatchObject({ success: true, drifted: false });
    expect(same.events).toEqual(['start', 'search:cats', 'done']);

    // An advertising frame now comes first: index 0 is no longer the search frame
    const shifted = await stack.call({ query: 'dogs' }, 'replay');
    expect(shifted.result).toMatchObject({ success: true, drifted: true });
    expect(shifted.events).toEqual(['start', 'search:dogs', 'done']);

    const broken = await stack.call({ query: 'dogs' }, 'broken');
    const failure = expectStrictFailure(broken.result, 2);
    expect(failure.tried[0]).toContain('in the frame [0]');
    expect(broken.events).toEqual(['start']);
  });

  // -------------------------------------------------------------------------
  it('(d) a pop-up window: the steps continue on the new page and come back', async () => {
    const stack = await build({
      path: 'stack-popup.html',
      label: 'Confirm in a popup',
      drive: async (opener) => {
        const [popup] = await Promise.all([
          opener.context().waitForEvent('page'),
          opener.getByRole('button', { name: 'Open details' }).click(),
        ]);
        await popup.waitForLoadState('domcontentloaded');
        await popup.waitForTimeout(500);
        await popup.getByRole('button', { name: 'Confirm' }).click();
        await popup.waitForTimeout(300);
        await opener.getByRole('button', { name: 'Main action' }).click();
        await opener.waitForTimeout(300);
      },
    });

    const ok = await stack.call({}, 'replay');
    expect(ok.result).toMatchObject({ success: true, drifted: false });
    expect(ok.events).toEqual(['confirm', 'main']);

    // "Confirm" became "Accept" in the pop-up: the click on the opener never happens
    const renamed = await stack.call({}, 'broken');
    const failure = expectStrictFailure(renamed.result, 2);
    expect(failure.tried[0]).toContain("getByRole('button', { name: 'Confirm', exact: true })");
    expect(renamed.events).toEqual([]);

    // The pop-up does not open at all
    const none = await stack.call({}, 'broken2');
    const never = expectStrictFailure(none.result, 1);
    expect(never).toMatchObject({ action: 'switch_page' });
    expect(never.reason).toMatch(/never opened/);
    expect(none.events).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it('(e) a dynamic table whose rows are shuffled: the row is found by the Variable, never by position', async () => {
    const stack = await build({
      path: 'stack-table.html',
      label: 'Delete a customer',
      drive: async (page, live) => {
        const search = page.getByRole('textbox', { name: 'Customer' });
        await search.fill('Ada');
        await search.press('Tab');
        await page.waitForTimeout(200);
        live.markVariable(0, { name: 'customer' });
        await page
          .locator('tbody tr')
          .filter({ has: page.locator('td:first-child', { hasText: /^Ada$/ }) })
          .getByRole('button', { name: 'Delete' })
          .click();
        await page.getByRole('button', { name: 'Refresh' }).click();
        await page.waitForTimeout(200);
      },
    });

    const same = await stack.call({ customer: 'Ada' }, 'record');
    expect(same.result).toMatchObject({ success: true, drifted: false });
    expect(same.events).toEqual(['delete:Ada', 'refresh']);

    // Rows in the opposite order, another customer: only that row is deleted
    for (const customer of ['Grace', 'Bob']) {
      const shuffled = await stack.call({ customer }, 'replay');
      expect(shuffled.result).toMatchObject({ success: true, drifted: true });
      expect(shuffled.events).toEqual([`delete:${customer}`, 'refresh']);
    }

    // The button is now called "Remove": the delete step fails and nothing else runs
    const renamed = await stack.call({ customer: 'Grace' }, 'broken');
    const failure = expectStrictFailure(renamed.result, 1);
    expect(failure).toMatchObject({ risk: 'delete' });
    expect(failure.tried[0]).toContain("in the row containing 'Grace'");
    expect(renamed.events).toEqual([]);

    // Two rows match the Variable: no row is chosen
    const ambiguous = await stack.call({ customer: 'Grace' }, 'broken2');
    const dup = expectStrictFailure(ambiguous.result, 1);
    expect(dup.reason).toMatch(/AMBIGUOUS_ROW: 2 rows match "Grace"/);
    expect(ambiguous.events).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it('(f) a contenteditable element is typed into with keyboard input', async () => {
    const stack = await build({
      path: 'stack-editable.html',
      label: 'Take a note',
      drive: async (page, live) => {
        await page.getByRole('button', { name: 'Start note' }).click();
        await page.getByRole('textbox', { name: 'Notes' }).click();
        await page.keyboard.type('Call Ada');
        await page.getByRole('button', { name: 'Save notes' }).click();
        await page.waitForTimeout(300);
        live.markVariable(1, { name: 'notes' });
        await page.getByRole('button', { name: 'Done' }).click();
        await page.waitForTimeout(200);
      },
    });

    const same = await stack.call({ notes: 'Call Ada' }, 'record');
    expect(same.result).toMatchObject({ success: true, drifted: false });
    expect(same.events).toEqual(['start', 'notes:Call Ada', 'done']);

    const other = await stack.call({ notes: 'Call Grace' }, 'replay');
    expect(other.result).toMatchObject({ success: true, drifted: true });
    expect(other.events).toEqual(['start', 'notes:Call Grace', 'done']);

    const broken = await stack.call({ notes: 'Call Grace' }, 'broken');
    const failure = expectStrictFailure(broken.result, 1);
    expect(failure.action).toBe('type');
    expect(broken.events).toEqual(['start']);
  });

  // -------------------------------------------------------------------------
  it('(g) hashed class names and extra wrappers: the replay goes through role and name', async () => {
    const stack = await build({
      path: 'stack-restyle.html',
      label: 'Subscribe to the newsletter',
      drive: async (page, live) => {
        await page.getByRole('textbox', { name: 'Email' }).fill('ada@example.com');
        await page.getByRole('button', { name: 'Subscribe' }).click();
        await page.waitForTimeout(200);
        live.markVariable(0, { name: 'email' });
        await page.getByRole('button', { name: 'Close' }).click();
        await page.waitForTimeout(200);
      },
    });

    const same = await stack.call({ email: 'ada@example.com' }, 'record');
    expect(same.result).toMatchObject({ success: true, drifted: false });
    expect(same.events).toEqual(['subscribe:ada@example.com', 'close']);

    const restyled = await stack.call({ email: 'grace@example.com' }, 'replay');
    expect(restyled.result).toMatchObject({ success: true, drifted: true });
    expect(restyled.events).toEqual(['subscribe:grace@example.com', 'close']);

    const broken = await stack.call({ email: 'grace@example.com' }, 'broken');
    const failure = expectStrictFailure(broken.result, 1);
    expect(failure).toMatchObject({ risk: 'write' });
    expect(broken.events).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it('reads a typed secret from DAEMONIZE_SECRET_<NAME>, names a missing one before any step, and never returns the value', async () => {
    const stack = await build({
      path: 'stack-restyle.html',
      label: 'Subscribe with a secret',
      drive: async (page) => {
        await page.getByRole('textbox', { name: 'Email' }).fill('ada@example.com');
        await page.getByRole('button', { name: 'Subscribe' }).click();
        await page.waitForTimeout(200);
      },
      adjust: (set) => {
        const step = set.workflows[0].steps[0];
        step.secretRef = 'SUBSCRIBER';
        delete step.value;
      },
    });

    const missing = await stack.call({}, 'replay');
    expect(missing.result).toMatchObject({ success: false, error: 'missing_secret', failure: { missingSecret: 'DAEMONIZE_SECRET_SUBSCRIBER' } });
    expect(missing.events).toEqual([]);

    const withSecret = await stack.connect({ DAEMONIZE_SECRET_SUBSCRIBER: 's3cr3t@example.com' });
    const ok = await withSecret.call({}, 'replay');
    expect(ok.result.success).toBe(true);
    expect(ok.events).toEqual(['subscribe:s3cr3t@example.com']);
    expect(JSON.stringify(ok.result)).not.toContain('s3cr3t@example.com');

    // A step that fails after the secret was typed does not leak it either
    const failed = await withSecret.call({}, 'broken');
    expect(JSON.stringify(failed.result)).not.toContain('s3cr3t@example.com');
  });
});
