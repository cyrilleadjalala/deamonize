import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlaygroundSession,
  ShotStore,
  buildChildEnv,
  initialMode,
  redactArguments,
  sanitizeSchema,
  sensitiveValues,
  validateArguments,
  HISTORY_SIZE,
  type ConnectFn,
  type LaunchSpec,
  type ToolMeta,
} from '../../src/studio/playground.js';
import { SAMPLE_PNG } from '../../src/studio/sample-data.js';
import { buildArguments, coerceValue, describeField, fieldsFromSchema, formatElapsed, initialValues, parseTimeout } from '../../src/studio/ui/js/schema-form.js';

const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    q: { type: 'string', minLength: 1, description: 'What to search' },
    password: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    _timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
  },
  required: ['q', '_timeoutMs'],
  additionalProperties: false,
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** A stand-in for the stdio connection: it records what the session does to it. */
function fakeServer(options: { delayMs?: number; answer?: (name: string, args: Record<string, unknown>) => Record<string, unknown> } = {}) {
  const state = {
    connects: 0,
    closes: 0,
    listCalls: 0,
    active: 0,
    maxActive: 0,
    order: [] as string[],
    calls: [] as Array<{ name: string; args: Record<string, unknown>; timeout?: number }>,
    specs: [] as LaunchSpec[],
    crash: undefined as (() => void) | undefined,
    failWith: undefined as { code?: number; name?: string; message?: string } | undefined,
  };
  const connect: ConnectFn = async (spec) => {
    state.connects += 1;
    state.specs.push(spec);
    const listeners: Array<() => void> = [];
    state.crash = () => listeners.forEach((l) => l());
    return {
      client: {
        listTools: async () => {
          state.listCalls += 1;
          return {
            tools: [
              { name: 'search', description: 'Search things', inputSchema: SCHEMA },
              { name: 'delete_all', description: 'Delete things', inputSchema: { type: 'object', properties: {} } },
            ],
          };
        },
        callTool: async (params, _schema, opts) => {
          state.active += 1;
          state.maxActive = Math.max(state.maxActive, state.active);
          state.order.push(`start:${String(params.arguments?.q ?? params.name)}`);
          state.calls.push({ name: params.name, args: params.arguments ?? {}, timeout: opts?.timeout });
          try {
            if (state.failWith !== undefined) throw Object.assign(new Error(state.failWith.message ?? 'boom'), state.failWith);
            await sleep(options.delayMs ?? 0);
            const result = options.answer?.(params.name, params.arguments ?? {}) ?? { success: true, drifted: false, driftChecked: true, text: 'ok', mode: 'strict' };
            return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
          } finally {
            state.order.push(`end:${String(params.arguments?.q ?? params.name)}`);
            state.active -= 1;
          }
        },
      },
      onClose: (l) => listeners.push(l),
      close: async () => {
        state.closes += 1;
      },
      stderrTail: () => 'it crashed',
    };
  };
  return { state, connect };
}

const launch = () => ({ command: process.execPath, args: ['server.js'], mcpEnv: {}, cwd: tmpdir() });
const META: Record<string, ToolMeta> = { search: { risk: 'read', sensitiveArgs: [] }, delete_all: { risk: 'delete', sensitiveArgs: [] } };

const sessions: PlaygroundSession[] = [];
function makeSession(connect: ConnectFn, extra: Partial<ConstructorParameters<typeof PlaygroundSession>[0]> = {}): PlaygroundSession {
  const s = new PlaygroundSession({ outDir: tmpdir(), connect, launch, healSupport: true, env: {}, toolMeta: (t) => META[t], ...extra });
  sessions.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

describe('buildChildEnv', () => {
  const processEnv = { PATH: '/bin', Path: undefined, HOME: '/home/u', TEMP: '/tmp', RANDOM_TOKEN: 'leak-1', AWS_SECRET_ACCESS_KEY: 'leak-2', NODE_OPTIONS: '--require x', LC_ALL: 'C' };
  const studioEnv = { DAEMONIZE_SECRET_CRM: 'pw-123', DAEMONIZE_MODE: 'heal', DAEMONIZE_MODEL_API_KEY: 'model-key', ANTHROPIC_API_KEY: 'sk-ant', OTHER: 'x' };

  it('passes system basics and DAEMONIZE_* only, never other variables', () => {
    const env = buildChildEnv({ processEnv, studioEnv, mode: 'strict' });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/u', TEMP: '/tmp', LC_ALL: 'C', DAEMONIZE_SECRET_CRM: 'pw-123' });
    for (const bad of ['RANDOM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'OTHER']) expect(env).not.toHaveProperty(bad);
  });

  it('gives model credentials to heal mode only, and sets the mode and the preview itself', () => {
    const strict = buildChildEnv({ processEnv, studioEnv, mode: 'strict' });
    expect(strict).not.toHaveProperty('DAEMONIZE_MODEL_API_KEY');
    expect(strict).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(strict.DAEMONIZE_MODE).toBe('strict');
    expect(strict).not.toHaveProperty('DAEMONIZE_SCREENSHOT');
    const heal = buildChildEnv({ processEnv, studioEnv, mode: 'heal', preview: true });
    expect(heal).toMatchObject({ DAEMONIZE_MODEL_API_KEY: 'model-key', ANTHROPIC_API_KEY: 'sk-ant', DAEMONIZE_MODE: 'heal', DAEMONIZE_SCREENSHOT: 'final' });
  });

  it('ignores ${VAR} placeholders of mcp.json and lets the Studio environment win over its literals', () => {
    const env = buildChildEnv({ processEnv: { PATH: '/bin' }, studioEnv: { DAEMONIZE_TIMEOUT_MS: '5' }, mcpEnv: { DAEMONIZE_SECRET_CRM: '${DAEMONIZE_SECRET_CRM}', DAEMONIZE_TIMEOUT_MS: '9', DAEMONIZE_STEP_TIMEOUT_MS: '7' }, mode: 'strict' });
    expect(env).not.toHaveProperty('DAEMONIZE_SECRET_CRM');
    expect(env.DAEMONIZE_TIMEOUT_MS).toBe('5');
    expect(env.DAEMONIZE_STEP_TIMEOUT_MS).toBe('7');
  });

  it('starts in heal mode only when the environment says exactly heal', () => {
    expect(initialMode({ DAEMONIZE_MODE: 'heal' })).toBe('heal');
    expect(initialMode({ DAEMONIZE_MODE: 'HEAL' })).toBe('strict');
    expect(initialMode({}, { DAEMONIZE_MODE: 'heal' })).toBe('heal');
    expect(initialMode({})).toBe('strict');
  });
});

describe('arguments: validation and redaction', () => {
  it('removes $schema and the reserved _timeoutMs from the schema the form and the validator use', () => {
    const clean = sanitizeSchema(SCHEMA) as { $schema?: string; properties: Record<string, unknown>; required: string[] };
    expect(clean.$schema).toBeUndefined();
    expect(clean.properties).not.toHaveProperty('_timeoutMs');
    expect(clean.required).toEqual(['q']);
  });

  it('refuses arguments that do not fit, with the path and the message, and accepts valid ones', () => {
    const schema = sanitizeSchema(SCHEMA);
    expect(validateArguments('search', schema, { q: 'a', limit: 3 })).toBeNull();
    const issues = validateArguments('search', schema, { limit: 99, extra: 1 });
    expect([...new Set(issues?.map((i) => i.path))].sort()).toEqual(['(arguments)', 'limit'].sort());
    expect(issues?.some((i) => /required/.test(i.message))).toBe(true);
  });

  it('shows a secret field as *** whatever its value, and scrubs known values elsewhere', () => {
    const scrub = (t: string): string => t.split('hunter2!').join('***');
    const shown = redactArguments({ q: 'x hunter2! y', password: 'hunter2!', nested: { apiKey: 12345, ok: 'fine' }, login_pin: '1234' }, ['crm_field'], scrub) as Record<string, any>;
    expect(shown).toEqual({ q: 'x *** y', password: '***', nested: { apiKey: '***', ok: 'fine' }, login_pin: '***' });
    expect((redactArguments({ CRM_Field: 'abc' }, ['crm_field']) as Record<string, string>).CRM_Field).toBe('***');
    expect(sensitiveValues({ password: 'hunter2!', q: 'public', deep: [{ token: 'tok-abc' }] })).toEqual(['hunter2!', 'tok-abc']);
  });
});

describe('PlaygroundSession', () => {
  it('reports which DAEMONIZE_SECRET_* variables the server would find, by name and never by value', async () => {
    const { connect } = fakeServer();
    const session = makeSession(connect, {
      env: { DAEMONIZE_SECRET_CRM: 'pw-123', DAEMONIZE_SECRET_EMPTY: '', DAEMONIZE_SECRET_FROM_ENV: 'x', OTHER_SECRET: 'nope' },
      launch: () => ({ command: process.execPath, args: ['server.js'], mcpEnv: { DAEMONIZE_SECRET_LITERAL: 'lit', DAEMONIZE_SECRET_PLACEHOLDER: '${DAEMONIZE_SECRET_PLACEHOLDER}', RANDOM: 'x' }, cwd: tmpdir() }),
    });
    const configured = await session.configuredSecretVariables();
    expect([...configured].sort()).toEqual(['DAEMONIZE_SECRET_CRM', 'DAEMONIZE_SECRET_FROM_ENV', 'DAEMONIZE_SECRET_LITERAL']);
    expect(JSON.stringify([...configured])).not.toContain('pw-123');
  });
  it('also reports the names held by the vault (names only), even without an mcp.json env', async () => {
    const { connect } = fakeServer();
    const vault = { snapshot: async () => ({ CRM: 'vault-pw-1' }), names: async () => new Set(['CRM', 'lower']), values: () => ['vault-pw-1'] };
    const session = makeSession(connect, { env: { DAEMONIZE_SECRET_FROM_ENV: 'x' }, vault, requiredSecretNames: async () => ['CRM'] });
    const configured = await session.configuredSecretVariables();
    expect([...configured].sort()).toEqual(['DAEMONIZE_SECRET_CRM', 'DAEMONIZE_SECRET_FROM_ENV', 'DAEMONIZE_SECRET_LOWER']);
    expect(JSON.stringify([...configured])).not.toContain('vault-pw-1');
  });

  it('puts a vault value in the child environment, over the Studio value of the same name', async () => {
    const { state, connect } = fakeServer();
    const vault = { snapshot: async () => ({ CRM: 'vault-pw-1' }), names: async () => new Set(['CRM']), values: () => ['vault-pw-1'] };
    const env = { DAEMONIZE_SECRET_CRM: 'studio-pw' };
    const session = makeSession(connect, { env, vault, requiredSecretNames: async () => ['CRM'] });
    await session.listTools();
    expect(state.specs[0].env.DAEMONIZE_SECRET_CRM).toBe('vault-pw-1');
    expect(state.specs[0].args).toEqual(['server.js']);
    expect(env.DAEMONIZE_SECRET_CRM).toBe('studio-pw');
  });

  it('starts no process when the vault cannot be read', async () => {
    const { state, connect } = fakeServer();
    const { VaultUnreadableError } = await import('../../src/studio/contracts.js');
    const vault = {
      snapshot: async (): Promise<Record<string, string>> => {
        throw new VaultUnreadableError('x');
      },
      names: async () => new Set<string>(),
      values: () => [],
    };
    const session = makeSession(connect, { vault });
    const outcome = await session.call({ tool: 'search', arguments: { q: 'a' } });
    expect(outcome.status).toBe(503);
    expect(state.connects).toBe(0);
  });

  it('starts lazily, lists the tools once and caches them', async () => {
    const { state, connect } = fakeServer();
    const session = makeSession(connect);
    expect(state.connects).toBe(0);
    expect(session.serverStarted).toBe(false);
    const first = await session.listTools();
    await session.listTools();
    expect(first.map((t) => t.name)).toEqual(['search', 'delete_all']);
    expect(state.connects).toBe(1);
    expect(state.listCalls).toBe(1);
    expect(session.serverStarted).toBe(true);
  });

  it('runs calls one at a time, in the order they were made', async () => {
    const { state, connect } = fakeServer({ delayMs: 40 });
    const session = makeSession(connect);
    const results = await Promise.all(['a', 'b', 'c'].map((q) => session.call({ tool: 'search', arguments: { q } })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(state.maxActive).toBe(1);
    expect(state.order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('answers 429 when too many calls wait', async () => {
    const { connect } = fakeServer({ delayMs: 30 });
    const session = makeSession(connect);
    const all = await Promise.all(Array.from({ length: 12 }, (_, i) => session.call({ tool: 'search', arguments: { q: String(i) } })));
    expect(all.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    expect(all.filter((r) => r.status === 200).length).toBeGreaterThan(0);
  });

  it('stops the server after the idle time and starts it again on the next call', async () => {
    const { state, connect } = fakeServer();
    const session = makeSession(connect, { idleMs: 80 });
    await session.call({ tool: 'search', arguments: { q: 'x' } });
    expect(session.serverStarted).toBe(true);
    await sleep(300);
    expect(session.serverStarted).toBe(false);
    expect(state.closes).toBe(1);
    const again = await session.call({ tool: 'search', arguments: { q: 'y' } });
    expect(again.status).toBe(200);
    expect(state.connects).toBe(2);
  });

  it('does not stop a server that is in the middle of a call', async () => {
    const { state, connect } = fakeServer({ delayMs: 250 });
    const session = makeSession(connect, { idleMs: 60 });
    const out = await session.call({ tool: 'search', arguments: { q: 'slow' } });
    expect(out.body.success).toBe(true);
    expect(state.closes).toBe(0);
  });

  it('starts a new server after a crash', async () => {
    const { state, connect } = fakeServer();
    const session = makeSession(connect);
    await session.listTools();
    state.crash?.();
    expect(session.serverStarted).toBe(false);
    expect(session.lastCrash).toContain('it crashed');
    const out = await session.call({ tool: 'search', arguments: { q: 'x' } });
    expect(out.status).toBe(200);
    expect(state.connects).toBe(2);
    expect(state.listCalls).toBe(2);
  });

  it('reports a timeout, stops the server and keeps working afterwards', async () => {
    const { state, connect } = fakeServer();
    const session = makeSession(connect);
    state.failWith = undefined;
    await session.listTools();
    state.failWith = { code: -32001, message: 'Request timed out' };
    const out = await session.call({ tool: 'search', arguments: { q: 'x' }, timeoutMs: 100 });
    expect(out.body).toMatchObject({ ok: false, error: 'timeout' });
    expect(state.closes).toBe(1);
    expect(state.calls[0].timeout).toBe(100 + 15_000);
    state.failWith = undefined;
    expect((await session.call({ tool: 'search', arguments: { q: 'y' } })).body.success).toBe(true);
  });

  it('refuses invalid arguments before the server is asked, with the validation message', async () => {
    const { state, connect } = fakeServer();
    const session = makeSession(connect);
    const out = await session.call({ tool: 'search', arguments: { limit: 500 } });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: false, refused: 'validation', error: 'validation', success: false });
    expect(String(out.body.message)).toMatch(/refused before reaching the server/);
    expect(state.calls).toHaveLength(0);
  });

  it('needs confirm for a write or delete tool, and for a tool it has no workflow for', async () => {
    const { state, connect } = fakeServer();
    const session = makeSession(connect);
    const denied = await session.call({ tool: 'delete_all', arguments: {} });
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ error: 'confirmation_required', risk: 'delete' });
    expect(state.calls).toHaveLength(0);
    expect((await session.call({ tool: 'delete_all', arguments: {}, confirm: true })).status).toBe(200);
    const unknownMeta = makeSession(connect, { toolMeta: () => undefined });
    expect((await unknownMeta.call({ tool: 'search', arguments: { q: 'x' } })).status).toBe(409);
    expect((await session.call({ tool: 'nope', arguments: {} })).status).toBe(404);
  });

  it('puts the reserved timeout in the call and refuses heal mode when the server has no heal support', async () => {
    const { state, connect } = fakeServer();
    const session = makeSession(connect, { healSupport: false });
    await session.call({ tool: 'search', arguments: { q: 'x' }, timeoutMs: 2500 });
    expect(state.calls[0].args).toEqual({ q: 'x', _timeoutMs: 2500 });
    const heal = await session.call({ tool: 'search', arguments: { q: 'x' }, mode: 'heal' });
    expect(heal.status).toBe(400);
    expect(heal.body.error).toBe('mode_unsupported');
  });

  it('restarts the server with the other mode and the environment it asked for', async () => {
    const { state, connect } = fakeServer();
    const session = makeSession(connect, { env: { DAEMONIZE_SECRET_A: 'secret-a', DAEMONIZE_MODEL_API_KEY: 'k-123' } });
    await session.call({ tool: 'search', arguments: { q: 'x' } });
    await session.call({ tool: 'search', arguments: { q: 'x' }, mode: 'heal', preview: true });
    expect(state.connects).toBe(2);
    expect(state.closes).toBe(1);
    expect(state.specs[0].env).toMatchObject({ DAEMONIZE_MODE: 'strict' });
    expect(state.specs[0].env).not.toHaveProperty('DAEMONIZE_MODEL_API_KEY');
    expect(state.specs[1].env).toMatchObject({ DAEMONIZE_MODE: 'heal', DAEMONIZE_SCREENSHOT: 'final', DAEMONIZE_MODEL_API_KEY: 'k-123' });
    expect(session.mode).toBe('heal');
  });

  it('keeps the last 50 calls with secret fields as *** and never echoes env secrets or typed secrets', async () => {
    const { connect } = fakeServer({ answer: (_n, args) => ({ success: true, drifted: false, driftChecked: true, text: `echo ${JSON.stringify(args)} env=ENVSECRET-9f8e`, data: { again: args.password } }) });
    const session = makeSession(connect, { env: { DAEMONIZE_SECRET_CRM: 'ENVSECRET-9f8e' } });
    const out = await session.call({ tool: 'search', arguments: { q: 'find ENVSECRET-9f8e', password: 'typed-pass-77' } });
    const shown = JSON.stringify([out, session.history()]);
    expect(shown).not.toContain('ENVSECRET-9f8e');
    expect(shown).not.toContain('typed-pass-77');
    expect(session.history()[0].arguments).toEqual({ q: 'find ***', password: '***' });
    for (let i = 0; i < HISTORY_SIZE + 10; i++) await session.call({ tool: 'search', arguments: { q: String(i) } });
    expect(session.history()).toHaveLength(HISTORY_SIZE);
    expect(session.history()[HISTORY_SIZE - 1].arguments).toEqual({ q: String(HISTORY_SIZE + 9) });
  });

  it('stops everything on close and refuses later calls', async () => {
    const { state, connect } = fakeServer();
    const session = makeSession(connect);
    await session.listTools();
    await session.close();
    expect(state.closes).toBe(1);
    expect((await session.call({ tool: 'search', arguments: { q: 'x' } })).status).toBe(503);
  });
});

describe('ShotStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('keeps only PNG files under the folders a server writes pictures to, by random id', async () => {
    const store = new ShotStore();
    const folder = join(tmpdir(), 'daemonize-failures');
    await mkdir(folder, { recursive: true });
    const good = join(folder, `unit-${Date.now()}.png`);
    await writeFile(good, SAMPLE_PNG);
    const elsewhere = await mkdtemp(join(tmpdir(), 'daemonize-elsewhere-'));
    dirs.push(elsewhere);
    const outside = join(elsewhere, 'x.png');
    await writeFile(outside, SAMPLE_PNG);
    const notPng = join(folder, `unit-${Date.now()}-text.png`);
    await writeFile(notPng, 'not a picture');
    try {
      const id = await store.addFile(good);
      expect(id).toMatch(/^[a-f0-9]{24}$/);
      expect((await store.read(id as string))?.equals(SAMPLE_PNG)).toBe(true);
      expect(await store.addFile(outside)).toBeUndefined();
      expect(await store.addFile(notPng)).toBeUndefined();
      expect(await store.addFile(join(folder, '..', '..', 'etc', 'passwd'))).toBeUndefined();
      expect(await store.read('../../etc/passwd')).toBeUndefined();
      expect(await store.read('0'.repeat(24))).toBeUndefined();
      const dir = store.directory as string;
      expect(existsSync(dir)).toBe(true);
      await store.close();
      expect(existsSync(dir)).toBe(false);
      expect(await store.read(id as string)).toBeUndefined();
    } finally {
      await rm(good, { force: true });
      await rm(notPng, { force: true });
    }
  });
});

describe('schema form helpers', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Customer name', minLength: 2 },
      email: { type: 'string', format: 'email' },
      born: { type: 'string', format: 'date' },
      age: { type: 'integer', minimum: 0, maximum: 150 },
      score: { type: 'number' },
      vip: { type: 'boolean' },
      country: { type: 'string', enum: ['FR', 'DE'] },
      tags: { type: 'array', items: { type: 'string' } },
      password: { type: 'string' },
      _timeoutMs: { type: 'integer' },
    },
    required: ['name', 'age'],
  };

  it('makes a field per property, required first, with the input kind of its type and format', () => {
    const fields = fieldsFromSchema(schema);
    expect(fields.map((f) => f.name).slice(0, 2).sort()).toEqual(['age', 'name']);
    expect(fields.find((f) => f.name === '_timeoutMs')).toBeUndefined();
    const by = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(by.email).toMatchObject({ inputType: 'email', required: false });
    expect(by.born.inputType).toBe('date');
    expect(by.age).toMatchObject({ kind: 'integer', inputType: 'number', min: 0, max: 150, required: true });
    expect(by.vip.inputType).toBe('checkbox');
    expect(by.country).toMatchObject({ inputType: 'select', options: ['FR', 'DE'] });
    expect(by.tags.inputType).toBe('textarea');
    expect(by.password).toMatchObject({ inputType: 'password', sensitive: true });
    expect(describeField(by.name)).toContain('at least 2 characters');
    expect(fieldsFromSchema({ type: 'object', properties: { user_pass: { type: 'string' } } }, ['user_pass'])[0].sensitive).toBe(true);
  });

  it('turns typed text into arguments: numbers, JSON, omitted optionals, and says what is wrong', () => {
    const fields = fieldsFromSchema(schema);
    const ok = buildArguments(fields, { name: 'Ada', age: '36', score: '1.5', vip: true, country: 'FR', tags: '["a"]', email: '', born: '', password: '' });
    expect(ok.errors).toEqual({});
    expect(ok.args).toEqual({ name: 'Ada', age: 36, score: 1.5, vip: true, country: 'FR', tags: ['a'] });
    const bad = buildArguments(fields, { name: '', age: '3.5', score: 'abc', tags: '{oops' });
    expect(bad.errors).toMatchObject({ name: 'This field is required.', age: 'Enter a whole number.', score: 'Enter a number.', tags: 'Enter valid JSON.' });
    expect(coerceValue(fields.find((f) => f.name === 'vip')!, false)).toEqual({ ok: true, omit: true });
  });

  it('starts from the schema defaults, parses the timeout and formats durations', () => {
    expect(initialValues(fieldsFromSchema({ type: 'object', properties: { a: { type: 'string', default: 'x' }, b: { type: 'boolean' }, c: { type: 'integer', default: 3 } } }))).toEqual({ a: 'x', b: false, c: '3' });
    expect(parseTimeout('')).toEqual({ ok: true });
    expect(parseTimeout(' 2500 ')).toEqual({ ok: true, value: 2500 });
    expect(parseTimeout('0').ok).toBe(false);
    expect(parseTimeout('600001').ok).toBe(false);
    expect(parseTimeout('1.5').ok).toBe(false);
    expect([formatElapsed(412), formatElapsed(1500), formatElapsed(42000)]).toEqual(['412 ms', '1.5 s', '42 s']);
  });
});
