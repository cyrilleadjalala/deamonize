/**
 * Daemonize on real software: Adminer (official image) on PostgreSQL, recorded, compiled and called over MCP.
 *
 *   DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/adminer-e2e.test.ts
 *
 * The stack is started with a random database password. The workflows are recorded with examples/adminer/record-workflows.mjs
 * (the script that drives the recorder like a person), compiled in strict mode, and the generated server is called with
 * the password in its environment only. Nothing here is a stand-in for the application: the pages are Adminer's own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 180000, hookTimeout: 900000 });
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compile } from '../../src/cli/commands/compile.js';
import { record } from '../../src/cli/commands/record.js';
import { buildSandboxImage } from '../../src/cli/commands/sandbox.js';
import { buildWorkflows, NO_OUTPUTS } from '../../src/studio/model.js';
import type { WorkflowSet } from '../../src/types.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { adminerSkipReason, startAdminerStack, type AdminerStack } from '../helpers/adminer-stack.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import { scanForValues } from '../helpers/scan-artifacts.js';
import { ISOLATED_VAULT_ENV } from '../helpers/isolated-vault.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const skip = adminerSkipReason();
if (skip) console.warn(skip);

interface Result {
  success: boolean;
  drifted?: boolean;
  driftChecked?: boolean;
  error?: string;
  text?: string;
  data?: any;
  failure?: { stepIndex: number; label: string; action: string; risk: string; tried: string[]; reason: string; screenshot?: string; missingSecret?: string };
}

describe.skipIf(skip !== null)('Adminer + PostgreSQL: record, compile and call over MCP (real software)', () => {
  let stack: AdminerStack;
  let work: string;
  let outputDir: string;
  let workflowFile: string;
  let recordSummaries: Array<{ steps: number; network?: Array<{ level: string; step: number }> }> = [];
  const dirs: string[] = [];
  const open: Array<{ client: Client; transport: StdioClientTransport }> = [];
  /** Every text an MCP server returned, kept to search it for the password */
  const received: string[] = [];

  beforeAll(async () => {
    stack = (await startAdminerStack())!;
    work = await mkdtemp(join(tmpdir(), 'daemonize-adminer-'));
    dirs.push(work);
    workflowFile = join(work, 'daemonize.workflows.json');

    const script = (await import(/* @vite-ignore */ pathToFileURL(resolve(workspaceRoot, 'examples/adminer/record-workflows.mjs')).href)) as {
      recordAdminerWorkflows(o: Record<string, unknown>): Promise<typeof recordSummaries>;
    };
    recordSummaries = await script.recordAdminerWorkflows({ record, url: stack.url, out: workflowFile, password: stack.password, log: () => { } });

    // Under the workspace so the generated server finds its dependencies in node_modules
    outputDir = await mkdtemp(join(workspaceRoot, '.adminer-'));
    dirs.push(outputDir);
    const log = console.log;
    console.log = () => { };
    try {
      // --http auto: Level 1 is only used where the recording found a structured request (it finds none in Adminer)
      await compile(workflowFile, outputDir, { http: 'auto' });
    } finally {
      console.log = log;
    }
  });

  afterAll(async () => {
    for (const { client, transport } of open) await closeClient(client, transport);
    await stack?.stop();
    for (const dir of dirs) await removeDir(dir);
  }, 300000);

  async function connect(env: Record<string, string | undefined> = { DAEMONIZE_SECRET_PASSWORD: stack.password }, dir = outputDir) {
    const client = new Client({ name: 'adminer-test', version: '1.0.0' });
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries({
      ...ISOLATED_VAULT_ENV,
      DAEMONIZE_STEP_TIMEOUT_MS: '10000',
      ...(process.env.DAEMONIZE_CHROMIUM_PATH ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH } : {}),
      ...env,
    })) {
      if (value !== undefined) clean[key] = value;
    }
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(dir, 'mcp-server.js')], cwd: workspaceRoot, env: clean });
    await client.connect(transport);
    open.push({ client, transport });
    return {
      client,
      listing: (await client.listTools()).tools,
      async call(name: string, args: Record<string, unknown>) {
        const response = await client.callTool({ name, arguments: args });
        const text = (response.content as Array<{ text: string }>)[0].text;
        received.push(text);
        // A failed replay is a JSON result (isError); an input refused by the schema is plain text
        let result: Result = { success: false };
        try {
          result = JSON.parse(text) as Result;
        } catch {
          // not a replay result
        }
        return { response, text, result };
      },
    };
  }

  const customerStatus = (name: string) => stack.psql(`select status from customers where name='${name}'`);

  // ---------------------------------------------------------------------------------------------------------------
  it('recorded the four workflows without any secret, any Level 1 request or any positional row', () => {
    const json = readFileSync(workflowFile, 'utf8');
    expect(json).not.toContain(stack.password);
    const set = JSON.parse(json) as WorkflowSet;
    expect(set.workflows.map((w) => w.label)).toEqual(['list_customers', 'find_customers', 'open_customer_for_edit', 'rename_customer']);

    for (const workflow of set.workflows) {
      // The login: system, user and database are constants, the password only a name
      const typed = workflow.steps.filter((s) => s.actionType === 'type').slice(0, 3);
      expect(typed.map((s) => [s.secretRef ?? null, s.value ?? null])).toEqual([[null, 'demo'], ['PASSWORD', null], [null, 'demo']]);
      expect(workflow.steps.find((s) => s.secretRef === 'PASSWORD')).toBeDefined();
      expect(workflow.secrets).toEqual([{ name: 'PASSWORD', kind: 'password' }]);
      // Adminer's hidden CSRF `token` field and its change events are not steps, and its login is not a "write"
      expect(JSON.stringify(workflow.steps.map((s) => s.selectors))).not.toMatch(/token/);
      expect(workflow.steps.some((s) => s.http !== undefined)).toBe(false);
      expect(workflow.steps.flatMap((s) => s.selectors).some((sel) => /nth=|>> nth|:first|:nth-of-type/.test(sel))).toBe(false);
      expect(workflow.variables.map((v) => v.name)).not.toContain('token');
      expect(workflow.steps[0]).toMatchObject({ actionType: 'select', value: 'pgsql' });
      expect(workflow.finalZone?.selector).toBeDefined();
      expect(workflow.resultZone?.selector).toBeDefined();
    }
    const byLabel = (label: string) => set.workflows.find((w) => w.label === label)!;
    expect(byLabel('list_customers').resultZone?.extractor).toEqual({ kind: 'table' });
    expect(byLabel('open_customer_for_edit').resultZone?.extractor).toEqual({ kind: 'fields' });
    expect(byLabel('find_customers').variables).toMatchObject([
      { name: 'operator', enum: ['=', 'LIKE'] },
      { name: 'search_text' },
    ]);
    // The row of the customer is found by the Variable
    for (const label of ['open_customer_for_edit', 'rename_customer']) {
      const edit = byLabel(label).steps.filter((s) => s.rowBinding !== undefined);
      expect(edit.length).toBeGreaterThan(0);
      for (const step of edit) expect(step.rowBinding?.variable).toBe('customer_name');
    }
    // Risks: only saving writes
    const risks = (label: string) => byLabel(label).steps.map((s) => s.risk ?? 'read');
    for (const label of ['list_customers', 'find_customers', 'open_customer_for_edit']) expect(risks(label)).not.toContain('write');
    expect(risks('rename_customer').filter((r) => r === 'write')).toHaveLength(1);
    expect(byLabel('rename_customer').steps.at(-1)).toMatchObject({ actionType: 'click', risk: 'write' });
  });

  it('finds no Level 1 recipe: Adminer is server-rendered HTML, every step stays at Level 2 (honest finding)', () => {
    for (const summary of recordSummaries) {
      expect(summary.network?.length).toBeGreaterThan(0);
      expect(summary.network?.every((n) => n.level === 'accessibility')).toBe(true);
    }
    // What the Studio overview shows: Level 2 (accessibility) for every step with a target, no Level 1 at all
    const set = deserializeWorkflowSet(readFileSync(workflowFile, 'utf8'));
    const views = buildWorkflows([{ set, outputs: NO_OUTPUTS }]).workflows;
    expect(views).toHaveLength(4);
    for (const view of views) {
      for (const step of view.steps) {
        expect(step.levels.http).toBe(false);
        expect(step.primaryLevel).toBe('accessibility');
      }
    }
    const overview = readFileSync(join(outputDir, 'openapi.json'), 'utf8');
    expect(overview).not.toContain('"http"');
    const server = readFileSync(join(outputDir, 'replay.ts'), 'utf8');
    expect(server).not.toMatch(/"http":\s*\{/);
  });

  it('lists four tools, the password as a variable name only, and the enum of the Variables in the input schema', async () => {
    const mcp = JSON.parse(readFileSync(join(outputDir, 'mcp.json'), 'utf8'));
    const env = Object.values(mcp.mcpServers as Record<string, { env: Record<string, string> }>)[0].env;
    expect(env).toMatchObject({ DAEMONIZE_MODE: 'strict', DAEMONIZE_SECRET_PASSWORD: '${DAEMONIZE_SECRET_PASSWORD}' });

    const server = await connect();
    expect(server.listing.map((t) => t.name).sort()).toEqual(['find_customers', 'list_customers', 'open_customer_for_edit', 'rename_customer']);
    const schema = (name: string) => server.listing.find((t) => t.name === name)!.inputSchema as { properties: Record<string, any>; required?: string[] };
    expect(schema('find_customers').properties.operator.enum).toEqual(['=', 'LIKE']);
    expect(schema('rename_customer').properties.status.enum).toEqual(['active', 'inactive', 'pending']);
    expect(schema('rename_customer').required).toEqual(expect.arrayContaining(['customer_name', 'status']));
    expect(JSON.stringify(server.listing)).toContain('DAEMONIZE_SECRET_PASSWORD');
    expect(JSON.stringify(server.listing)).not.toContain(stack.password);
  });

  it('list_customers returns every row of the table as objects keyed by the column headers, with no drift', async () => {
    const server = await connect();
    const { result } = await server.call('list_customers', {});
    expect(result, JSON.stringify(result).slice(0, 600)).toMatchObject({ success: true, drifted: false, driftChecked: true });
    expect(result.data.length).toBeGreaterThanOrEqual(25);
    for (const row of result.data) {
      expect(Object.keys(row)).toEqual(expect.arrayContaining(['id', 'name', 'email', 'country', 'status']));
    }
    expect(result.data.map((r: any) => r.name)).toContain('Chiara Rossi');
    // The same rows as the database
    expect(result.data.length).toBe(Number(stack.psql('select count(*) from customers')));
  });

  it('find_customers filters through the native select and the text field: only the matching rows come back', async () => {
    const server = await connect();
    const like = await server.call('find_customers', { search_text: 'Fran%', operator: 'LIKE' });
    expect(like.result, like.text.slice(0, 600)).toMatchObject({ success: true, drifted: false });
    const expected = Number(stack.psql("select count(*) from customers where country like 'Fran%'"));
    expect(expected).toBeGreaterThan(1);
    expect(like.result.data).toHaveLength(expected);
    for (const row of like.result.data) expect(row.country).toBe('France');

    // Another value and another operator, same recorded steps
    const equal = await server.call('find_customers', { search_text: 'Italy', operator: '=' });
    expect(equal.result).toMatchObject({ success: true, drifted: false });
    expect(equal.result.data.map((r: any) => r.name).sort()).toEqual(['Chiara Rossi', 'Ugo Bianchi']);
  });

  it('open_customer_for_edit finds the row by the name given, and reads the form without saving', async () => {
    const server = await connect();
    const before = stack.psql('select md5(string_agg(c::text, \',\' order by id)) from customers c');
    for (const name of ['Chiara Rossi', 'Yasmin Aziz']) {
      const { result } = await server.call('open_customer_for_edit', { customer_name: name });
      expect(result, JSON.stringify(result).slice(0, 800)).toMatchObject({ success: true, drifted: false });
      expect(result.data).toMatchObject({ name, email: `${name.toLowerCase().replace(' ', '.')}@example.com` });
      expect(Object.keys(result.data)).toEqual(['id', 'name', 'email', 'country', 'status']);
    }
    expect(stack.psql('select md5(string_agg(c::text, \',\' order by id)) from customers c')).toBe(before);
  });

  it('refuses to guess among several rows: a value found in two rows is AMBIGUOUS_ROW', async () => {
    const server = await connect();
    // "France" is in the country column of five customers
    const country = await server.call('open_customer_for_edit', { customer_name: 'France' });
    expect(country.result).toMatchObject({ success: false, error: 'step_failed' });
    expect(country.result.failure?.reason).toMatch(/AMBIGUOUS_ROW: 5 rows match "France"/);
    expect(country.result.failure?.screenshot).toMatch(/\.png$/);

    // The same name twice, in two rows (different ids)
    stack.psql("insert into customers (name, email, country, status) values ('Jan Novak', 'jan.novak2@example.com', 'Slovakia', 'active')");
    try {
      const dup = await server.call('open_customer_for_edit', { customer_name: 'Jan Novak' });
      expect(dup.result).toMatchObject({ success: false, error: 'step_failed' });
      expect(dup.result.failure?.reason).toMatch(/AMBIGUOUS_ROW: 2 rows match "Jan Novak"/);
    } finally {
      stack.psql("delete from customers where email='jan.novak2@example.com'");
    }
    // A name that is in no row is not found, whatever is in the other rows
    const none = await server.call('open_customer_for_edit', { customer_name: 'Nobody Here' });
    expect(none.result).toMatchObject({ success: false, error: 'step_failed' });
    expect(none.result.failure?.reason).toMatch(/ROW_NOT_FOUND|no row/i);
  });

  it('reports a strict failure, and drift, when the password is wrong', async () => {
    const server = await connect({ DAEMONIZE_SECRET_PASSWORD: 'not-the-database-password', DAEMONIZE_STEP_TIMEOUT_MS: '3000' });
    const { result } = await server.call('list_customers', {});
    expect(result).toMatchObject({ success: false, drifted: true, error: 'step_failed' });
    const failure = result.failure!;
    // The login submit went through (step 4), Adminer shows the login page again and the menu link is not there
    expect(failure.stepIndex).toBe(5);
    expect(failure.tried.length).toBeGreaterThan(0);
    expect(failure.reason.length).toBeGreaterThan(0);
    expect(failure.screenshot).toMatch(/\.png$/);
    expect(existsSync(failure.screenshot!)).toBe(true);
    const shots = await mkdtemp(join(tmpdir(), 'daemonize-adminer-shot-'));
    dirs.push(shots);
    await copyFile(failure.screenshot!, join(shots, 'failure.png'));
    expect(await scanForValues(shots, [stack.password, 'not-the-database-password'])).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('not-the-database-password');
  });

  it('names the missing variable before any step runs', async () => {
    const server = await connect({ DAEMONIZE_SECRET_PASSWORD: undefined });
    const { result } = await server.call('list_customers', {});
    expect(result).toMatchObject({ success: false, error: 'missing_secret' });
    expect(result.failure?.missingSecret).toBe('DAEMONIZE_SECRET_PASSWORD');
  });

  it('rename_customer saves the status in the database, and an invalid value is refused before any replay', async () => {
    const server = await connect();
    const initial = customerStatus('Chiara Rossi');
    const next = initial === 'inactive' ? 'active' : 'inactive';
    const done = await server.call('rename_customer', { customer_name: 'Chiara Rossi', status: next });
    expect(done.result, done.text.slice(0, 800)).toMatchObject({ success: true, drifted: false });
    expect(done.result.text).toMatch(/updated/i);
    expect(customerStatus('Chiara Rossi')).toBe(next);

    // Outside the enum: the server answers with an input error and the database is untouched
    const refused = await server.call('rename_customer', { customer_name: 'Chiara Rossi', status: 'archived' });
    expect(refused.response.isError).toBe(true);
    expect(refused.text).toMatch(/status/);
    expect(refused.text).not.toMatch(/step_failed|replay/);
    expect(customerStatus('Chiara Rossi')).toBe(next);

    // Only that row was written
    expect(Number(stack.psql(`select count(*) from customers where status='archived'`))).toBe(0);
    const back = await server.call('rename_customer', { customer_name: 'Chiara Rossi', status: initial });
    expect(back.result).toMatchObject({ success: true });
    expect(customerStatus('Chiara Rossi')).toBe(initial);
  });

  it('keeps the database password out of the workflow file, the compiled output and every MCP result', async () => {
    const results = await mkdtemp(join(tmpdir(), 'daemonize-adminer-results-'));
    dirs.push(results);
    await mkdir(results, { recursive: true });
    await writeFile(join(results, 'results.txt'), received.join('\n'));
    expect(received.length).toBeGreaterThan(5);
    const values = [stack.password];
    expect(await scanForValues(work, values)).toEqual([]);
    expect(await scanForValues(outputDir, values)).toEqual([]);
    expect(await scanForValues(results, values)).toEqual([]);
  });

  it('replays list_customers in a Docker container (--sandbox docker)', async (ctx) => {
    const probe = spawnSync('docker', ['image', 'inspect', 'mcr.microsoft.com/playwright:v1.65.1-noble'], { encoding: 'utf-8' });
    if (probe.status !== 0) {
      console.warn('Docker replay skipped: the image mcr.microsoft.com/playwright:v1.65.1-noble is not available locally');
      return ctx.skip();
    }
    const tag = await buildSandboxImage(outputDir);
    try {
      // Docker Desktop relays the connections of the container to the loopback of the host (where Adminer listens)
      const server = await connect(
        { DAEMONIZE_SECRET_PASSWORD: stack.password, DAEMONIZE_SANDBOX: 'docker', DAEMONIZE_SANDBOX_IMAGE: tag, DAEMONIZE_SANDBOX_URL: `http://host.docker.internal:${stack.port}/` },
      );
      const { result, text } = await server.call('list_customers', {});
      if (result.success === false && /ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|net::|sandbox_unavailable/.test(JSON.stringify(result))) {
        console.warn(`Docker replay skipped: the container cannot reach Adminer through host.docker.internal (${JSON.stringify(result.failure ?? result.error).slice(0, 200)})`);
        return ctx.skip();
      }
      expect(result, text.slice(0, 800)).toMatchObject({ success: true, drifted: false });
      expect(result.data.length).toBeGreaterThanOrEqual(25);
      expect(text).not.toContain(stack.password);
    } finally {
      spawnSync('docker', ['rmi', tag], { stdio: 'ignore' });
    }
  });
});
