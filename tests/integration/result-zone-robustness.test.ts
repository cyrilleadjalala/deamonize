// checkpoint-only: needs G-B, G-C, G-D
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 120000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { record } from '../../src/cli/commands/record.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import { ISOLATED_VAULT_ENV } from '../helpers/isolated-vault.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');

// The page as it was recorded: one list among other lists, no id, a build-specific class
const PAGE_V1 = `<!doctype html>
<html><head><title>Search</title></head>
<body>
<nav><ul><li><a href="#a">Home</a></li><li><a href="#b">Docs</a></li></ul></nav>
<main>
  <h1>Results</h1>
  <button id="go" type="button">Search</button>
  <section class="panel">
    <p class="hint">Showing matches</p>
    <ul class="hits-x7k2p9q">
      <li>Ada Lovelace</li><li>Alan Turing</li><li>Grace Hopper</li>
    </ul>
  </section>
</main>
</body></html>`;

// The same page after a redesign: a wrapper div, siblings reordered, the generated class renamed
const PAGE_V2 = `<!doctype html>
<html><head><title>Search</title></head>
<body>
<nav><ul><li><a href="#a">Home</a></li><li><a href="#b">Docs</a></li></ul></nav>
<main>
  <section class="card">
    <ul class="hits-m4n8b1c">
      <li>Ada Lovelace</li><li>Alan Turing</li><li>Grace Hopper</li>
    </ul>
    <p class="hint">Showing matches</p>
  </section>
  <div class="layout-wrapper">
    <h1>Results</h1>
    <button id="go" type="button">Search</button>
  </div>
</main>
</body></html>`;
// A page where the zone is gone altogether
const PAGE_GONE = `<!doctype html><html><head><title>Search</title></head><body><main><h1>No results page</h1><button id="go" type="button">Search</button></main></body></html>`;

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => { };
  try {
    return await run();
  } finally {
    console.log = log;
  }
}

describe('Result_Zone selector robustness: record -> change the page -> call over MCP', () => {
  let httpServer: Server;
  let dir: string;
  let outputDir: string;
  let client: Client;
  let transport: StdioClientTransport;
  let set: WorkflowSet;
  let toolOf: Map<string, string>;
  let recorded: Workflow;
  let page = PAGE_V1;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(page);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;

    dir = await mkdtemp(join(tmpdir(), 'daemonize-zone-robust-'));
    const out = join(dir, 'workflows.json');

    await quiet(() =>
      record({
        url, name: 'Search', label: 'Marked', out, headless: true,
        drive: async (p) => {
          await p.getByRole('button', { name: 'Search' }).click();
          await p.keyboard.press('Alt+Shift+R');
          await p.locator('ul.hits-x7k2p9q li').first().click();
          await p.locator('[data-daemonize-action=result-kind]').waitFor();
          await p.locator('[data-daemonize-action=result-kind-list][aria-pressed=true]').waitFor();
        },
      })
    );
    const fromFile = deserializeWorkflowSet(await readFile(out, 'utf-8'));
    recorded = fromFile.workflows.find((w) => w.label === 'Marked') as Workflow;

    const base = structuredClone(recorded);
    const variant = (id: string, label: string, zone: Workflow['resultZone']): Workflow => ({ ...structuredClone(base), id, label, resultZone: zone });
    const zone = recorded.resultZone!;
    const oldZone = { selector: zone.selector, extractor: zone.extractor } as Workflow['resultZone'];
    const noMatch = {
      ...structuredClone(zone),
      selector: '#gone-a',
      selectors: ['#gone-a', '#gone-b', 'role=table[name="Gone"]'],
    } as Workflow['resultZone'];
    const oldNoMatch = { selector: '#gone-a', extractor: zone.extractor } as Workflow['resultZone'];
    set = new SchemaInferencer().inferWorkflows({
      ...fromFile,
      workflows: [
        ...fromFile.workflows,
        variant('77777777-7777-4777-8777-777777777771', 'Old zone', oldZone),
        variant('77777777-7777-4777-8777-777777777772', 'No candidate', noMatch),
        variant('77777777-7777-4777-8777-777777777773', 'Old no match', oldNoMatch),
      ],
    });

    outputDir = await mkdtemp(join(workspaceRoot, '.zone-robust-e2e-'));
    const compiled = await quiet(() => new Compiler().compile(set, outputDir));
    toolOf = new Map(set.workflows.map((w) => [w.label, compiled.toolNames.get(w.id) as string]));

    client = new Client({ name: 'zone-robust-e2e', version: '1.0.0' });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(outputDir, 'mcp-server.js')],
      cwd: workspaceRoot,
      env: {
        ...ISOLATED_VAULT_ENV,
        DAEMONIZE_STEP_TIMEOUT_MS: '1500',
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

  async function call(label: string): Promise<{ isError: boolean; result: Record<string, any> }> {
    const response = await client.callTool({ name: toolOf.get(label) as string, arguments: {} });
    const raw = (response.content as Array<{ text: string }>)[0].text;
    return { isError: response.isError === true, result: JSON.parse(raw) };
  }

  const items = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper'];

  it('records several candidates and a fingerprint, with selector equal to the first', () => {
    const zone = recorded.resultZone!;
    expect(zone.selectors?.length).toBeGreaterThanOrEqual(1);
    expect(zone.selectors![0]).toBe(zone.selector);
    expect(zone.fingerprint).toMatchObject({ tag: 'ul', kind: 'list', count: 3 });
  });

  it('on the recorded page the first candidate works and no fallback is reported', async () => {
    page = PAGE_V1;
    const { result } = await call('Marked');
    expect(result.success).toBe(true);
    expect(result.data).toEqual(items);
    expect(result.zoneFallback).toBeUndefined();
  });

  it('after a wrapper, reordered siblings and a renamed class the zone is still returned, with zoneFallback when the first candidate broke', async () => {
    page = PAGE_V2;
    const zone = recorded.resultZone!;
    const { result } = await call('Marked');
    expect(result.success).toBe(true);
    expect(result.data).toEqual(items);
    // `section.panel ul` is gone (class renamed); the structural candidate carries the call
    expect(zone.selectors![0]).toContain('panel');
    expect(result.zoneFallback).toEqual({ position: 2, of: zone.selectors!.length });
  });

  it('an old zone with only `selector` behaves as before: same result on the page, same failure after it broke', async () => {
    page = PAGE_V1;
    const ok = await call('Old zone');
    expect(ok.result.success).toBe(true);
    expect(ok.result.data).toEqual(items);
    expect(ok.result.zoneFallback).toBeUndefined();

    page = PAGE_GONE;
    const failed = await call('Old no match');
    expect(failed.result).toMatchObject({ success: false, error: 'result_zone_not_found' });
    expect(failed.result.failure.candidatesTried).toBeUndefined();
    expect(failed.result.zoneFallback).toBeUndefined();
  });

  it('when no candidate matches, reports result_zone_not_found with candidatesTried', async () => {
    page = PAGE_GONE;
    const { result } = await call('No candidate');
    expect(result.success).toBe(false);
    expect(result.error).toBe('result_zone_not_found');
    expect(result.failure.candidatesTried).toBe(3);
    expect(result.zoneFallback).toBeUndefined();
  });
});
