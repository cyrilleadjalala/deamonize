/**
 * Requirement 18.4 and 12.10: the generated MCP_Server calls no language model unless Heal_Mode is on, and even then
 * only after a deterministic failure of a step that may be healed. A local HTTP server plays the model endpoint (the
 * Anthropic, OpenAI and OpenAI-compatible paths) and counts every request, so the claim is checked on the wire.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { record } from '../../src/cli/commands/record.js';
import { compile } from '../../src/cli/commands/compile.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import { encodedForms, scanForValues } from '../helpers/scan-artifacts.js';
import type { Workflow, WorkflowSet, WorkflowStep } from '../../src/types.js';
import { ISOLATED_VAULT_ENV } from '../helpers/isolated-vault.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const chromiumEnv: Record<string, string> = process.env.DAEMONIZE_CHROMIUM_PATH
  ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH }
  : {};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const MODEL_KEY = 'sk-model-key-8d41f0c2a97b46e5b3a1';
const DECOY_ANTHROPIC = 'sk-ant-decoy-3b9e61d07c5a4f28';
const DECOY_OPENAI = 'sk-openai-decoy-61c0a8e4d2f94b73';
const PASSWORD = 'Tr0ub4dor&3-xyzzy-9f2c';
const VARIABLE_VALUE = 'variable-value-7c1e4b92';
const COOKIE_VALUE = 'cookie-value-5f1d9c77a0b34e2e';

/** Both pages have the same fields. In the drifted one the button is "Delete item", as when an application was redesigned. */
const FIELDS = `<label for="user">Username</label><input id="user" />
<label for="pass">Password</label><input id="pass" type="password" />`;
const PAGES = {
  drifted: `<!doctype html><html><head><title>Items</title></head><body>${FIELDS}
<button id="x9" onclick="document.getElementById('out').textContent = 'removed'">Delete item</button>
<button id="c1">Cancel</button><p id="out"></p></body></html>`,
  good: `<!doctype html><html><head><title>Items</title></head><body>${FIELDS}
<button id="remove" onclick="document.getElementById('out').textContent = 'removed'">Remove</button>
<p id="out"></p></body></html>`,
};

// ---------------------------------------------------------------------------
// The model endpoint
// ---------------------------------------------------------------------------

interface ModelRequest {
  path: string;
  authorization?: string;
  apiKeyHeader?: string;
  body: string;
}
type ModelBehaviour = 'answer' | 'garbage' | 'error500';

/** The text part of a request in any of the two wire formats. */
function promptTextOf(body: any): string {
  const content = body.messages?.find((m: any) => m.role === 'user')?.content ?? [];
  return (content as any[]).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

/** Build the answer from the numbered marks of the prompt: the mark whose name contains `target`. */
function answerFor(prompt: string, target: string): string {
  for (const line of prompt.split('\n')) {
    const m = /^(\d+): role=(\S*) name=(.*)$/.exec(line);
    if (m && m[3].includes(target)) return JSON.stringify({ kind: 'mark', markId: Number(m[1]) });
  }
  return JSON.stringify({ kind: 'none', reason: 'no such mark' });
}

class ModelEndpoint {
  requests: ModelRequest[] = [];
  behaviour: ModelBehaviour = 'answer';
  private server: Server;
  origin = '';

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  reset(behaviour: ModelBehaviour = 'answer'): void {
    this.requests = [];
    this.behaviour = behaviour;
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of req) body += chunk;
    const path = req.url ?? '';
    const authorization = req.headers.authorization;
    this.requests.push({ path, authorization, apiKeyHeader: req.headers['x-api-key'] as string | undefined, body });
    res.setHeader('content-type', 'application/json');
    if (this.behaviour === 'error500') {
      // A badly behaved endpoint that echoes the credentials back in its error
      res.statusCode = 500;
      res.end(JSON.stringify({ error: `upstream failure for ${authorization ?? ''} ${req.headers['x-api-key'] ?? ''}` }));
      return;
    }
    const text = this.behaviour === 'garbage' ? 'I cannot tell, sorry.' : answerFor(promptTextOf(JSON.parse(body)), 'Delete item');
    if (path.endsWith('/v1/messages')) res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    else res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  }
}

// ---------------------------------------------------------------------------
// Helpers for compiling and talking to a generated server
// ---------------------------------------------------------------------------

function step(extra: Partial<WorkflowStep>): WorkflowStep {
  return { actionType: 'click', selectors: [], risk: 'read', ...extra };
}

const removeClick = (index: number, extra: Partial<WorkflowStep> = {}): WorkflowStep =>
  step({
    selectors: ['role=button[name="Remove"]', '#remove'],
    anchor: { role: 'button', name: 'Remove', frame: [] },
    visual: { rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.05 }, intent: "Click the button 'Remove'", thumbnailPath: `workflows.json.assets/step-${index}.png` },
    ...extra,
  });

function workflow(id: string, label: string, steps: WorkflowStep[], extra: Partial<Workflow> = {}): Workflow {
  return { id, label, steps, variables: [], observedPayloads: [], ...extra };
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

interface Connected {
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
}

async function connect(dir: string, env: Record<string, string>): Promise<Connected> {
  const client = new Client({ name: 'no-model-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dir, 'mcp-server.js')],
    cwd: workspaceRoot,
    env: { ...ISOLATED_VAULT_ENV, ...chromiumEnv, DAEMONIZE_STEP_TIMEOUT_MS: '1000', ...env },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  await client.connect(transport);
  return { client, transport, stderr };
}

async function call(server: Connected, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const response = await server.client.callTool({ name, arguments: args });
  const content = response.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

/** Every string a request carries: the body, and the bytes of every base64 run in it (the images). */
function requestStrings(body: string): string[] {
  const out = [body];
  for (const run of body.match(/[A-Za-z0-9+/=]{200,}/g) ?? []) out.push(Buffer.from(run, 'base64').toString('latin1'));
  return out;
}

function leaked(body: string, values: string[]): string[] {
  const haystacks = requestStrings(body);
  return values.filter((v) => encodedForms(v).some((f) => haystacks.some((h) => h.includes(f.text))));
}

// ---------------------------------------------------------------------------

describe('No model call without Heal_Mode', () => {
  const model = new ModelEndpoint();
  let httpServer: Server;
  let page: keyof typeof PAGES = 'drifted';
  let root: string;
  let workflowFile: string;
  let strictDir: string; // compiled without --heal-support
  let healDir: string; // compiled with --heal-support
  const open: Connected[] = [];

  const modelEnv = (provider: 'anthropic' | 'openai' | 'openai-compatible' = 'anthropic'): Record<string, string> => ({
    DAEMONIZE_MODEL_PROVIDER: provider,
    DAEMONIZE_MODEL_NAME: 'mock-vision-1',
    DAEMONIZE_MODEL_API_KEY: MODEL_KEY,
    DAEMONIZE_MODEL_BASE_URL: provider === 'anthropic' ? model.origin : `${model.origin}/v1`,
    ANTHROPIC_API_KEY: DECOY_ANTHROPIC,
    OPENAI_API_KEY: DECOY_OPENAI,
  });
  const secretEnv = { DAEMONIZE_SECRET_PASSWORD: PASSWORD };

  const start = async (dir: string, env: Record<string, string>): Promise<Connected> => {
    const server = await connect(dir, env);
    open.push(server);
    return server;
  };
  let cacheSeq = 0;
  /** A heal cache of its own, so that no case is answered by the locator another one stored. */
  const freshCache = (): Record<string, string> => ({ DAEMONIZE_HEAL_CACHE: join(root, `cache-${cacheSeq++}.json`) });

  beforeAll(async () => {
    await model.start();
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.setHeader('set-cookie', `session=${COOKIE_VALUE}; Path=/`);
      res.end(PAGES[page]);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    const startUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;

    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'No Model Page',
      startUrl,
      workflows: [
        workflow('b1111111-1111-4111-8111-111111111111', 'Remove item', [removeClick(1)]),
        workflow('b2222222-2222-4222-8222-222222222222', 'Remove write', [removeClick(2, { risk: 'write' })]),
        workflow(
          'b3333333-3333-4333-8333-333333333333',
          'Sign in and remove',
          [
            step({ actionType: 'type', selectors: ['#user'], variable: 'username' }),
            step({ actionType: 'type', selectors: ['#pass'], secretRef: 'PASSWORD' }),
            removeClick(3),
          ],
          {
            variables: [{ name: 'username', type: 'string' }],
            observedPayloads: [{ username: 'ada' }],
            secrets: [{ name: 'PASSWORD', kind: 'password' }],
          },
        ),
      ],
    };

    root = await mkdtemp(join(tmpdir(), 'daemonize-no-model-'));
    workflowFile = join(root, 'workflows.json');
    await writeFile(workflowFile, JSON.stringify(set, null, 2));
    await mkdir(join(root, 'workflows.json.assets'));
    for (const n of [1, 2, 3]) await writeFile(join(root, 'workflows.json.assets', `step-${n}.png`), PNG);

    healDir = await compileInto('.no-model-heal-', set, { healSupport: true, workflowFile });
    strictDir = await compileInto('.no-model-strict-', set, {});
  }, 120000);

  afterAll(async () => {
    for (const server of open) await closeClient(server.client, server.transport);
    httpServer?.closeAllConnections();
    await new Promise<void>((done) => httpServer?.close(() => done()));
    await model.stop();
    for (const dir of [healDir, strictDir, root]) if (dir) await removeDir(dir);
  }, 60000);

  it('(a) strict mode, the default: a drifted page fails with drifted: true and no request reaches the model', async () => {
    page = 'drifted';
    model.reset();
    const server = await start(strictDir, modelEnv());
    const result = await call(server, 'remove_item');
    expect(result).toMatchObject({ success: false, drifted: true, error: 'step_failed', mode: 'strict' });
    expect(result.healed).toBeUndefined();
    expect(result.heal).toBeUndefined();
    expect(model.requests).toHaveLength(0);
  });

  it('(b) strict mode on a server compiled with --heal-support: still no request', async () => {
    page = 'drifted';
    model.reset();
    for (const provider of ['anthropic', 'openai', 'openai-compatible'] as const) {
      const server = await start(healDir, { ...modelEnv(provider), ...freshCache() });
      const result = await call(server, 'remove_item');
      expect(result, provider).toMatchObject({ success: false, drifted: true, error: 'step_failed', mode: 'strict' });
      expect(result.heal).toBeUndefined();
    }
    // Any mode word but "heal" is strict
    const odd = await start(healDir, { ...modelEnv(), ...freshCache(), DAEMONIZE_MODE: 'healing' });
    expect(await call(odd, 'remove_item')).toMatchObject({ success: false, error: 'step_failed', mode: 'strict' });
    expect(model.requests).toHaveLength(0);
  });

  it('(c) heal mode on a page that replays deterministically: no failure, no request', async () => {
    page = 'good';
    model.reset();
    const server = await start(healDir, { ...modelEnv(), ...freshCache(), DAEMONIZE_MODE: 'heal' });
    const result = await call(server, 'remove_item');
    expect(result).toMatchObject({ success: true, mode: 'heal', healed: false, healedSteps: [] });
    expect(result.text).toContain('removed');
    expect(model.requests).toHaveLength(0);
  });

  it('(d) heal mode on a server compiled without --heal-support: heal_unavailable and no request', async () => {
    page = 'drifted';
    model.reset();
    const server = await start(strictDir, { ...modelEnv(), ...freshCache(), DAEMONIZE_MODE: 'heal' });
    const result = await call(server, 'remove_item');
    expect(result).toMatchObject({ success: false, drifted: true, error: 'heal_unavailable', mode: 'heal' });
    expect(result.failure.reason).toMatch(/compiled without --heal-support/);
    expect(model.requests).toHaveLength(0);
  });

  it('(e) heal mode refuses a write step without allowHeal: no request', async () => {
    page = 'drifted';
    model.reset();
    const server = await start(healDir, { ...modelEnv(), ...freshCache(), DAEMONIZE_MODE: 'heal' });
    const result = await call(server, 'remove_write');
    expect(result).toMatchObject({ success: false, drifted: true, error: 'step_failed', mode: 'heal', healed: false, healedSteps: [] });
    expect(result.heal).toBeUndefined();
    expect(model.requests).toHaveLength(0);
  });

  describe.each([
    ['anthropic', '/v1/messages'],
    ['openai', '/v1/chat/completions'],
    ['openai-compatible', '/v1/chat/completions'],
  ] as const)('(f) heal mode with a failing read step and a reachable %s endpoint', (provider, path) => {
    it('makes exactly one request, heals, and answers the second call from the cache', async () => {
      page = 'drifted';
      model.reset();
      const env = { ...modelEnv(provider), ...freshCache(), ...secretEnv, DAEMONIZE_MODE: 'heal' };
      const args = { username: VARIABLE_VALUE };

      const first = await call(await start(healDir, env), 'sign_in_and_remove', args);
      expect(first).toMatchObject({ success: true, mode: 'heal', healed: true, healedSteps: [{ stepIndex: 2, source: 'model' }] });
      expect(first.text).toContain('removed');
      expect(model.requests).toHaveLength(1);

      const request = model.requests[0];
      expect(request.path).toBe(path);
      // The configured key was used, not a decoy from the environment
      const sent = provider === 'anthropic' ? request.apiKeyHeader : request.authorization;
      expect(sent).toBe(provider === 'anthropic' ? MODEL_KEY : `Bearer ${MODEL_KEY}`);

      // What the model was told: the intent and the marks, never what was typed, a secret or a cookie
      const text = promptTextOf(JSON.parse(request.body));
      expect(text).toContain("Click the button 'Remove'");
      expect(text).toMatch(/^\d+: role=button name=Delete item$/m);
      expect(leaked(request.body, [PASSWORD, VARIABLE_VALUE, COOKIE_VALUE, MODEL_KEY, DECOY_ANTHROPIC, DECOY_OPENAI])).toEqual([]);

      // A new process: the locator comes from the cache file
      const second = await call(await start(healDir, env), 'sign_in_and_remove', args);
      expect(second).toMatchObject({ success: true, healed: true, healedSteps: [{ stepIndex: 2, source: 'cache' }] });
      expect(model.requests).toHaveLength(1);
    });
  });

  describe.each([
    ['garbage', 'garbage' as const],
    ['an HTTP 500 that echoes the credentials', 'error500' as const],
  ])('(g) heal mode with a model that answers %s', (_name, behaviour) => {
    it('returns the strict failure plus heal.attempted, and no key appears in the result, the log or the screenshot', async () => {
      page = 'drifted';
      model.reset(behaviour);
      const server = await start(healDir, { ...modelEnv('openai'), ...freshCache(), ...secretEnv, DAEMONIZE_MODE: 'heal' });
      const result = await call(server, 'sign_in_and_remove', { username: VARIABLE_VALUE });
      expect(result).toMatchObject({ success: false, drifted: true, error: 'step_failed', mode: 'heal', healed: false, healedSteps: [] });
      expect(result.failure).toMatchObject({ stepIndex: 2, action: 'click' });
      expect(result.heal).toMatchObject({ attempted: true });
      expect(model.requests.length).toBeGreaterThanOrEqual(1);
      expect(model.requests.length).toBeLessThanOrEqual(2); // one retry on a 5xx

      const secrets = [MODEL_KEY, DECOY_ANTHROPIC, DECOY_OPENAI, PASSWORD, VARIABLE_VALUE, COOKIE_VALUE];
      const everything = JSON.stringify(result) + server.stderr.join('');
      for (const value of secrets) expect(everything).not.toContain(value);
      // The request body (what any log of it would show) never held the key; it travelled in a header only
      for (const r of model.requests) expect(r.body).not.toContain(MODEL_KEY);

      const shot: string | undefined = result.failure.screenshot;
      if (shot !== undefined && existsSync(shot)) {
        const dir = await mkdtemp(join(tmpdir(), 'daemonize-no-model-shot-'));
        try {
          await copyFile(shot, join(dir, 'failure.png'));
          expect(await scanForValues(dir, secrets)).toEqual([]);
        } finally {
          await removeDir(dir);
        }
      }
      // Nothing on disk next to the server holds the key either
      expect(await scanForValues(healDir, [MODEL_KEY, DECOY_ANTHROPIC, DECOY_OPENAI, PASSWORD])).toEqual([]);
      expect(JSON.parse(await readFile(workflowFile, 'utf8')).workflows).toHaveLength(3);
    });
  });

  it('daemonize record and daemonize compile never contact the model, whatever their flags', async () => {
    page = 'good';
    model.reset();
    const saved = { ...process.env };
    Object.assign(process.env, modelEnv(), { DAEMONIZE_MODE: 'heal' });
    const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
      const log = console.log;
      const warn = console.warn;
      console.log = () => { };
      console.warn = () => { };
      try {
        return await run();
      } finally {
        console.log = log;
        console.warn = warn;
      }
    };
    const dirs: string[] = [];
    try {
      const file = join(root, 'recorded.json');
      const set = JSON.parse(await readFile(workflowFile, 'utf8')) as WorkflowSet;
      await quietly(() =>
        record({
          url: set.startUrl as string,
          name: 'No Model Page',
          label: 'Press remove',
          out: file,
          headless: true,
          drive: async (p) => {
            await p.getByRole('button', { name: 'Remove' }).click();
            await p.waitForTimeout(300);
          },
        }),
      );
      expect(model.requests).toHaveLength(0);

      for (const options of [{}, { healSupport: true }, { http: 'auto' as const }, { healSupport: true, http: 'auto' as const }]) {
        const out = await mkdtemp(join(root, 'compiled-'));
        dirs.push(out);
        await quietly(() => compile(file, out, options));
      }
      expect(model.requests).toHaveLength(0);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
