/**
 * Requirement 18.1 to 18.4: `compile --suggest` writes an editable suggestions file, `compile` applies the accepted
 * entries (names and texts only), and nothing contacts a model unless a model suggestion was asked for.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { copyFile, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildProgram } from '../../src/cli/index.js';
import { recordTui, type TerminalInput } from '../../src/cli/commands/record-tui.js';
import { MENU_KEY } from '../../src/recorder/key-tokenizer.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { SuggestionSet } from '../../src/suggest/suggester.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const greeter = join(workspaceRoot, 'tests', 'fixtures', 'greeter.mjs');
const MODEL_KEY = 'sk-suggest-model-key-5d1e8a30c9b24f67';
const PLANTED = 'planted-constant-value-6c2f9e41';

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const { log, warn } = console;
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  console.warn = (...a: unknown[]) => void logs.push(a.join(' '));
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** A user at a terminal, as in record-tui.test.ts. */
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

/** The model endpoint: counts requests and answers with a suggestion for the first workflow. */
class ModelEndpoint {
  requests: Array<{ path: string; authorization?: string; prompt: string }> = [];
  origin = '';
  private server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      const user = body.messages?.find((m: { role: string }) => m.role === 'user')?.content;
      this.requests.push({ path: req.url ?? '', authorization: req.headers.authorization, prompt: typeof user === 'string' ? user : JSON.stringify(user) });
      const answer = { workflows: [{ id: 'w1', toolName: 'greet_the_user', description: 'Greets a person by name.' }] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  async start(): Promise<void> {
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

describe('compile --suggest', () => {
  let dir: string;
  let file: string;
  const model = new ModelEndpoint();
  const saved: Record<string, string | undefined> = {};
  const modelEnv = (): Record<string, string> => ({
    DAEMONIZE_MODEL_PROVIDER: 'openai-compatible',
    DAEMONIZE_MODEL_NAME: 'suggest-test',
    DAEMONIZE_MODEL_BASE_URL: `${model.origin}/v1`,
    DAEMONIZE_MODEL_API_KEY: MODEL_KEY,
  });
  const compileCli = (args: string[]) => quiet(() => buildProgram().parseAsync(['node', 'daemonize', 'compile', ...args]));

  beforeAll(async () => {
    await model.start();
    dir = await mkdtemp(join(tmpdir(), 'daemonize-suggest-'));
    file = join(dir, 'workflows.json');
    // The model variables are set in this process for the whole file: only an explicit model suggestion may use them
    for (const [k, v] of Object.entries(modelEnv())) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    // Record a terminal workflow (this is the `record` side of "0 model calls")
    const terminal = fakeTerminal();
    const recording = recordTui({ command: [process.execPath, greeter], name: 'Greeter', label: 'Greet someone', out: file, input: terminal.input, output: terminal.output });
    await terminal.waitFor('Your name:');
    terminal.type('Ada\r');
    await terminal.waitFor('Hello Ada!');
    terminal.type(MENU_KEY);
    await terminal.waitFor('make the last typed text a variable');
    terminal.type('v');
    await terminal.waitFor('variable name: your_name');
    terminal.type('\r');
    await terminal.waitFor('variable "your_name" saved');
    terminal.type('1\r');
    await terminal.waitFor('Hello again Ada!');
    terminal.type(MENU_KEY);
    terminal.type('e');
    await recording;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await model.stop();
    await removeDir(dir);
  });

  it('recording and a plain compile make no model call, and create no suggestions file', async () => {
    expect(model.requests).toHaveLength(0);
    await compileCli([file, '--out', join(dir, 'out-plain')]);
    expect(model.requests).toHaveLength(0);
    expect(await readdir(dir)).not.toContain('workflows.json.suggestions.json');
  });

  it('writes deterministic suggestions with no model call, applies nothing until accepted, then applies the edited file', async () => {
    const { logs } = await compileCli([file, '--out', join(dir, 'out-1'), '--suggest=deterministic']);
    expect(logs.join('\n')).toMatch(/Suggestions from deterministic rules: 1 workflow\(s\) written to/);
    expect(model.requests).toHaveLength(0);
    const path = `${file}.suggestions.json`;
    const suggestions = JSON.parse(await readFile(path, 'utf-8')) as SuggestionSet;
    expect(suggestions).toMatchObject({ version: '1', source: 'deterministic' });
    expect(suggestions.workflows).toHaveLength(1);
    expect(suggestions.workflows[0].accepted).toBe(false);
    const original = JSON.parse(await readFile(join(dir, 'out-1', 'name-map.json'), 'utf-8')) as Record<string, string>;
    expect(Object.values(original)).toEqual(['greet_someone']);

    // Edit: accept, rename, describe
    suggestions.workflows[0].accepted = true;
    suggestions.workflows[0].toolName = 'say_hello';
    suggestions.workflows[0].description = 'Greets a person by name.';
    await writeFile(path, JSON.stringify(suggestions, null, 2));
    // A new --suggest keeps the edits
    const again = await compileCli([file, '--out', join(dir, 'out-2'), '--suggest=deterministic']);
    expect(again.logs.join('\n')).toMatch(/kept your edits/);
    expect(JSON.parse(await readFile(path, 'utf-8')).workflows[0]).toMatchObject({ accepted: true, toolName: 'say_hello' });
    // A plain compile applies the accepted entry
    await compileCli([file, '--out', join(dir, 'out-3')]);
    expect(Object.values(JSON.parse(await readFile(join(dir, 'out-3', 'name-map.json'), 'utf-8')))).toEqual(['say_hello']);
    expect(model.requests).toHaveLength(0);

    // The generated server lists the edited name and description
    await symlink(join(workspaceRoot, 'node_modules'), join(dir, 'out-3', 'node_modules'), 'junction');
    const client = new Client({ name: 'suggest-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(dir, 'out-3', 'mcp-server.js')], env: process.env as Record<string, string>, cwd: dir });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['say_hello']);
      expect(tools[0].description).toContain('Greets a person by name.');
      expect(tools[0].description).toContain('your_name');
    } finally {
      await closeClient(client, transport);
    }

    // What is replayed does not change: the replay modules are identical with and without the suggestions
    const plain = join(dir, 'out-plain');
    for (const name of ['replay.ts', 'replay.js', 'docker-replay.ts', 'docker-replay.js', 'step-plan.ts', 'extract.ts', 'pattern-wait.ts', 'settle.ts', 'screen-hash.ts']) {
      expect(await readFile(join(dir, 'out-3', name), 'utf-8'), name).toBe(await readFile(join(plain, name), 'utf-8'));
    }
    expect(await readFile(join(dir, 'out-3', 'sandbox', 'image.json'), 'utf-8')).toBe(await readFile(join(plain, 'sandbox', 'image.json'), 'utf-8'));
  });

  it('with --suggest-force the file is replaced by fresh, unaccepted suggestions', async () => {
    await compileCli([file, '--out', join(dir, 'out-4'), '--suggest=deterministic', '--suggest-force']);
    const suggestions = JSON.parse(await readFile(`${file}.suggestions.json`, 'utf-8')) as SuggestionSet;
    expect(suggestions.workflows[0]).toMatchObject({ accepted: false, toolName: 'greet_someone' });
    expect(Object.values(JSON.parse(await readFile(join(dir, 'out-4', 'name-map.json'), 'utf-8')))).toEqual(['greet_someone']);
  });

  it('asks the model when one is configured, sends structure only, and records the source', async () => {
    // A copy of the workflow with a long constant typed value, to prove it never reaches the model
    const copy = join(dir, 'planted.json');
    const set = deserializeWorkflowSet(await readFile(file, 'utf-8'));
    set.workflows[0].steps.find((s) => s.value === '1')!.value = PLANTED;
    await writeFile(copy, serializeWorkflowSet(set));
    const { logs } = await compileCli([copy, '--out', join(dir, 'out-5'), '--suggest=model']);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].path).toBe('/v1/chat/completions');
    expect(model.requests[0].authorization).toBe(`Bearer ${MODEL_KEY}`);
    expect(model.requests[0].prompt).not.toContain(PLANTED);
    expect(model.requests[0].prompt).not.toContain(MODEL_KEY);
    expect(model.requests[0].prompt).toContain('Greet someone');
    expect(logs.join('\n')).toMatch(/Suggestions from model openai-compatible\/suggest-test/);
    const suggestions = JSON.parse(await readFile(`${copy}.suggestions.json`, 'utf-8')) as SuggestionSet;
    expect(suggestions).toMatchObject({ source: 'model', model: 'openai-compatible/suggest-test' });
    expect(suggestions.workflows[0]).toMatchObject({ accepted: false, toolName: 'greet_the_user', description: 'Greets a person by name.' });
    // Not accepted: not applied
    expect(Object.values(JSON.parse(await readFile(join(dir, 'out-5', 'name-map.json'), 'utf-8')))).toEqual(['greet_someone']);
  });

  it('falls back to the rules, and says so, when the model is not configured or not reachable', async () => {
    const copy = join(dir, 'fallback.json');
    await copyFile(file, copy);
    const before = model.requests.length;
    const saved2 = { ...process.env };
    delete process.env.DAEMONIZE_MODEL_PROVIDER;
    try {
      const { logs } = await compileCli([copy, '--out', join(dir, 'out-6'), '--suggest']);
      expect(logs.join('\n')).toMatch(/Deterministic rules were used instead of a model: no model available: DAEMONIZE_MODEL_PROVIDER is not set/);
      const suggestions = JSON.parse(await readFile(`${copy}.suggestions.json`, 'utf-8')) as SuggestionSet;
      expect(suggestions).toMatchObject({ source: 'deterministic' });
      expect(suggestions.fallbackReason).toMatch(/no model available/);
    } finally {
      Object.assign(process.env, saved2);
    }
    // unreachable: the port is closed
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    process.env.DAEMONIZE_MODEL_BASE_URL = `http://127.0.0.1:${port}/v1`;
    try {
      const { logs } = await compileCli([copy, '--out', join(dir, 'out-7'), '--suggest=model', '--suggest-force']);
      expect(logs.join('\n')).toMatch(/Deterministic rules were used instead of a model: model suggestions failed/);
    } finally {
      process.env.DAEMONIZE_MODEL_BASE_URL = modelEnv().DAEMONIZE_MODEL_BASE_URL;
    }
    expect(model.requests.length).toBe(before);
  });
});
