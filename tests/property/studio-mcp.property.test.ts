import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { agentMayCall } from '../../src/studio/agent-access';
import { describeTools, INPUT_SCHEMAS } from '../../src/studio/mcp/schemas';
import { boundAnswer } from '../../src/studio/mcp/server';
import { STUDIO_MCP_TOOL_NAMES, type StudioMcpToolName } from '../../src/studio/mcp/tool-names';
import { startMcpHarness } from '../helpers/fake-studio';
import { plainName, secretLikeString } from '../helpers/firewall-arbitraries';

const RUNS = { numRuns: 100 };
const word = fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,24}[A-Za-z]$/);
const safeId = fc.constantFrom('wf-read', 'wf-write', 'nope');
const scope = fc.constantFrom('global' as const, 'project' as const);

/** Valid arguments of each tool (some name a tool or an action that does not exist, which is still a valid call). */
const validCall: fc.Arbitrary<{ name: StudioMcpToolName; args: Record<string, unknown> }> = fc.oneof(
  fc.constant({ name: 'list_actions' as const, args: {} }),
  safeId.map((id) => ({ name: 'get_action' as const, args: { id } })),
  fc.constant({ name: 'list_credentials' as const, args: {} }),
  fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }).map((limit) => ({ name: 'get_activity' as const, args: limit === undefined ? {} : { limit } })),
  fc.tuple(word, fc.option(fc.boolean(), { nil: undefined })).map(([name, reuseSession]) => ({ name: 'start_recording' as const, args: { name, url: 'https://example.com/app', ...(reuseSession === undefined ? {} : { reuseSession }) } })),
  fc.constant({ name: 'get_recording_status' as const, args: {} }),
  fc.constant({ name: 'finish_recording' as const, args: {} }),
  fc.record({ http: fc.constantFrom('off', 'auto'), healSupport: fc.boolean() }, { requiredKeys: [] }).map((args) => ({ name: 'compile' as const, args })),
  fc
    .record(
      {
        tool: fc.constantFrom('look_up_customer', 'add_customer', 'unknown_tool'),
        arguments: fc.dictionary(plainName, fc.stringMatching(/^[A-Za-z0-9 ]{0,20}$/), { maxKeys: 3 }),
        mode: fc.constantFrom('strict', 'heal'),
        timeoutMs: fc.integer({ min: 1, max: 600000 }),
        confirm: fc.boolean(),
      },
      { requiredKeys: ['tool'] }
    )
    .map((args) => ({ name: 'test_action' as const, args })),
  scope.map((s) => ({ name: 'preview_kiro_install' as const, args: { scope: s } })),
  fc.tuple(scope, fc.constantFrom('confirm-1', 'guess')).map(([s, confirmationId]) => ({ name: 'install_to_kiro' as const, args: { scope: s, confirmationId } })),
  fc.tuple(safeId, fc.option(fc.boolean(), { nil: undefined }), fc.option(word, { nil: undefined })).map(([id, confirm, label]) => ({
    name: 'update_action' as const,
    args: { id, ...(confirm === undefined ? {} : { confirm }), ...(label === undefined ? {} : { label }) },
  })),
  fc.tuple(safeId, fc.option(fc.boolean(), { nil: undefined })).map(([id, confirm]) => ({ name: 'delete_action' as const, args: { id, ...(confirm === undefined ? {} : { confirm }) } }))
);

describe('Studio_MCP properties', () => {
  it('Property 4: The tool list is exactly the specified list and every schema is closed', () => {
    // Feature: kiro-native-agent-and-firewall, Property 4: The tool list is exactly the specified list and every schema is closed
    // Validates: Requirements 6.8, 2.1, 3.1, 4.1, 5.1
    expect(describeTools().map((t) => t.name)).toEqual([...STUDIO_MCP_TOOL_NAMES]);
    expect(Object.keys(INPUT_SCHEMAS).sort()).toEqual([...STUDIO_MCP_TOOL_NAMES].sort());
    fc.assert(
      fc.property(fc.constantFrom(...STUDIO_MCP_TOOL_NAMES), (name) => {
        const tool = describeTools().find((t) => t.name === name)!;
        expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(tool.name.length).toBeLessThanOrEqual(64);
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.additionalProperties).toBe(false);
        const open: string[] = [];
        const walk = (node: unknown, path: string): void => {
          if (node === null || typeof node !== 'object') return;
          const schema = node as Record<string, unknown>;
          if (schema.type === 'object' && schema.properties !== undefined && schema.additionalProperties !== false) open.push(path);
          for (const [k, v] of Object.entries(schema)) walk(v, `${path}.${k}`);
        };
        walk(tool.inputSchema, name);
        expect(open).toEqual([]);
      }),
      RUNS
    );
  });

  it('Property 5: A bad argument is refused before any request', async () => {
    // Feature: kiro-native-agent-and-firewall, Property 5: A bad argument is refused before any request
    // Validates: Requirements 2.9, 6.7, 3.3
    const required: Array<{ name: StudioMcpToolName; base: Record<string, unknown>; field: string }> = [
      { name: 'get_action', base: { id: 'wf-read' }, field: 'id' },
      { name: 'start_recording', base: { name: 'a', url: 'https://example.com' }, field: 'name' },
      { name: 'start_recording', base: { name: 'a', url: 'https://example.com' }, field: 'url' },
      { name: 'test_action', base: { tool: 'look_up_customer' }, field: 'tool' },
      { name: 'preview_kiro_install', base: { scope: 'global' }, field: 'scope' },
      { name: 'install_to_kiro', base: { scope: 'global', confirmationId: 'c' }, field: 'confirmationId' },
      { name: 'update_action', base: { id: 'wf-read', confirm: true }, field: 'id' },
      { name: 'delete_action', base: { id: 'wf-read', confirm: true }, field: 'id' },
    ];
    const wrongType = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.string(), { maxLength: 2 }), fc.dictionary(fc.string({ maxLength: 4 }), fc.string({ maxLength: 4 }), { maxKeys: 2 }));
    const h = await startMcpHarness();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            // A field the schema does not list
            fc.tuple(fc.constantFrom(...STUDIO_MCP_TOOL_NAMES), fc.stringMatching(/^[a-z]{3,12}$/)).map(([name, key]) => ({ name, args: { ...(name === 'get_action' ? { id: 'wf-read' } : {}), ...(name === 'test_action' ? { tool: 'look_up_customer' } : {}), ...(name === 'preview_kiro_install' ? { scope: 'global' } : {}), ...(name === 'install_to_kiro' ? { scope: 'global', confirmationId: 'c' } : {}), ...(name === 'start_recording' ? { name: 'a', url: 'https://example.com' } : {}), ...(name === 'update_action' || name === 'delete_action' ? { id: 'wf-read' } : {}), [key]: 1 }, field: key, kind: 'unknown_field' as const })).filter(({ name, field }) => !Object.keys((INPUT_SCHEMAS[name].properties as object) ?? {}).includes(field)),
            // A value of the wrong type
            fc.tuple(fc.constantFrom(...required), wrongType).map(([r, value]) => ({ name: r.name, args: { ...r.base, [r.field]: value }, field: r.field, kind: 'invalid_argument' as const })),
            // Numbers out of range
            fc.integer({ min: -1000, max: 0 }).map((limit) => ({ name: 'get_activity' as const, args: { limit }, field: 'limit', kind: 'invalid_argument' as const })),
            fc.integer({ min: 101, max: 5000 }).map((limit) => ({ name: 'get_activity' as const, args: { limit }, field: 'limit', kind: 'invalid_argument' as const })),
            fc.integer({ min: 600001, max: 99999999 }).map((timeoutMs) => ({ name: 'test_action' as const, args: { tool: 'look_up_customer', timeoutMs }, field: 'timeoutMs', kind: 'invalid_argument' as const })),
            // A value outside an enum
            fc.stringMatching(/^[a-z]{3,10}$/).filter((s) => !['off', 'auto'].includes(s)).map((http) => ({ name: 'compile' as const, args: { http }, field: 'http', kind: 'invalid_argument' as const }))
          ),
          async ({ name, args, field, kind }) => {
            h.events.length = 0;
            h.asked.length = 0;
            const result = await h.call(name, args);
            expect(result.isError).toBe(true);
            expect(result.json.error).toBe(kind);
            expect(result.json.field).toBe(field);
            expect(h.events).toEqual([]);
            expect(h.studio.requests).toEqual([]);
            expect(h.asked).toEqual([]);
          }
        ),
        RUNS
      );
    } finally {
      await h.close();
    }
  });

  it('Property 6: The Studio_MCP touches only allowed routes', async () => {
    // Feature: kiro-native-agent-and-firewall, Property 6: The Studio_MCP touches only allowed routes
    // Validates: Requirements 6.1, 14.5, 14.6, 5.10
    const forbidden = [/\/api\/approvals/, /\/api\/secrets\/forget/, /\/api\/power\/approval/, /\/api\/power\/remove/, /\/api\/power\/daemonize/, /\/api\/sessions/, /\/api\/pbt/, /\/api\/power\/auto-add/];
    const h = await startMcpHarness();
    try {
      await fc.assert(
        fc.asyncProperty(validCall, fc.constantFrom('approved', 'denied', 'timeout', 'unavailable'), async ({ name, args }, decision) => {
          h.events.length = 0;
          h.decision.value = decision;
          await h.call(name, args);
          for (const event of h.events.filter((e) => e !== 'ASK')) {
            const [method, path] = event.split(' ');
            expect(agentMayCall(method!, path!)).toBe(true);
            expect(path!.startsWith('/api/')).toBe(true);
            for (const pattern of forbidden) expect(path).not.toMatch(pattern);
            // The only POST that can store anything is a write of the Studio's documented editor routes
            if (method === 'POST') expect(['/api/record/start', '/api/record/stop', '/api/compile', '/api/workflows/update', '/api/workflows/delete', '/api/playground/call', '/api/power/preview', '/api/power/install']).toContain(path);
          }
        }),
        RUNS
      );
      // What the Studio really received is inside the same list
      for (const r of h.studio.requests) expect(agentMayCall(r.method, r.path)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('Property 7: Answers hold no secret, path, address or stack', async () => {
    // Feature: kiro-native-agent-and-firewall, Property 7: Answers hold no secret, path, address or stack
    // Validates: Requirements 2.5, 2.10, 4.11, 6.2, 6.6
    const calls: Array<[StudioMcpToolName, Record<string, unknown>]> = [
      ['list_actions', {}],
      ['get_action', { id: 'wf' }],
      ['list_credentials', {}],
      ['get_activity', {}],
      ['start_recording', { name: 'a', url: 'https://example.com' }],
      ['get_recording_status', {}],
      ['finish_recording', {}],
      ['compile', {}],
      ['test_action', { tool: 'look_up_customer', arguments: { customer: 'x' } }],
      ['preview_kiro_install', { scope: 'project' }],
      ['install_to_kiro', { scope: 'project', confirmationId: 'confirm-1' }],
      ['update_action', { id: 'wf', confirm: true, label: 'x' }],
      ['delete_action', { id: 'wf', confirm: true }],
    ];
    const env: NodeJS.ProcessEnv = {};
    const h = await startMcpHarness({ env });
    try {
      await fc.assert(
        fc.asyncProperty(secretLikeString, fc.constantFrom(200, 400, 409, 500, 503), async (secret, status) => {
          env.DAEMONIZE_SECRET_PLANTED = secret;
          const leak = `before ${secret} after`;
          const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ error: leak, message: leak, ...extra });
          const ok = status === 200;
          const view = { id: 'wf', label: leak, toolName: leak, description: leak, risk: { highest: 'write' }, variables: [{ name: leak, type: 'string', optional: false }], steps: [{ label: leak }], writeSteps: [{ index: 0, label: leak, risk: 'write', kind: 'action' }] };
          h.studio.set('GET /api/workflows', ok ? { status: 200, body: { workflows: [view] } } : { status: status, body: body() });
          h.studio.set('GET /api/secrets', ok ? { status: 200, body: { secrets: [{ name: leak, kind: 'password', configured: false }] } } : { status, body: body() });
          h.studio.set('GET /api/activity', ok ? { status: 200, body: { entries: [{ tool: leak, outcome: leak, arguments: { a: leak } }] } } : { status, body: body() });
          h.studio.set('POST /api/record/start', { status: ok ? 202 : status, body: ok ? { state: 'recording' } : body({ field: 'url' }) });
          h.studio.set('GET /api/record/status', ok ? { status: 200, body: { state: 'error', steps: 1, labels: [leak], error: leak, recoveryFile: `${h.workspace}/rec.json` } } : { status, body: body() });
          h.studio.set('POST /api/record/stop', { status: ok ? 202 : status, body: ok ? { state: 'saving' } : body() });
          h.studio.set('POST /api/compile', { status: ok ? 202 : status, body: ok ? { state: 'running' } : body() });
          h.studio.set('GET /api/compile/status', { status: 200, body: { state: 'error', error: leak } });
          h.studio.set('GET /api/playground', ok ? { status: 200, body: { available: true, tools: [{ name: 'look_up_customer', risk: 'read', writeSteps: [], sensitiveArgs: [] }] } } : { status, body: body() });
          h.studio.set('POST /api/playground/call', ok ? { status: 200, body: { success: false, text: leak, data: { leak }, error: leak, message: leak, failure: { path: h.workspace } } } : { status, body: body() });
          h.studio.set('POST /api/power/preview', ok ? { status: 200, body: { confirmationId: 'confirm-1', serverName: leak, kiroPath: h.dataDir, missingSecrets: [leak] } } : { status, body: body() });
          h.studio.set('POST /api/power/install', ok ? { status: 200, body: { missingSecrets: [leak], written: [h.dataDir] } } : { status, body: body() });
          h.studio.set('POST /api/workflows/update', ok ? { status: 200, body: { workflow: view, recompile: 'started' } } : { status, body: body() });
          h.studio.set('POST /api/workflows/delete', ok ? { status: 200, body: { remaining: 0 } } : { status, body: body() });
          for (const [name, args] of calls) {
            const result = await h.call(name, args);
            expect(result.text).not.toContain(secret);
            expect(result.text).not.toContain(h.studio.agentToken);
            expect(result.text).not.toContain(h.studio.origin);
            expect(result.text).not.toContain(h.workspace);
            expect(result.text).not.toContain(h.dataDir);
            expect(result.text).not.toMatch(/\n\s+at\s+\S+.*:\d+:\d+/);
            expect(result.text).not.toMatch(/\bat\s+\S+\s+\([^)]*:\d+:\d+\)/);
          }
        }),
        RUNS
      );
    } finally {
      await h.close();
    }
  }, 120_000);

  it('Property 8: An answer is bounded and valid', async () => {
    // Feature: kiro-native-agent-and-firewall, Property 8: An answer is bounded and valid
    // Validates: Requirements 6.4, 6.5
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), fc.string({ minLength: 0, maxLength: 60_000 }), (value, big) => {
        for (const text of [JSON.stringify(value) ?? 'null', JSON.stringify({ big }), JSON.stringify({ big: `"\\\n${big}` })]) {
          const out = boundAnswer(text);
          expect(out.length).toBeLessThanOrEqual(20_000);
          const parsed = JSON.parse(out) as Record<string, unknown>;
          if (text.length > 20_000) {
            expect(parsed.truncated).toBe(true);
            expect(typeof parsed.text).toBe('string');
            expect(text.startsWith(parsed.text as string)).toBe(true);
          } else {
            expect(out).toBe(text);
          }
        }
      }),
      RUNS
    );
    // End to end: a Studio that answers a lot still gives one valid, bounded answer
    const h = await startMcpHarness();
    try {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 900 }), async (count, size) => {
          h.studio.set('GET /api/activity', { status: 200, body: { entries: Array.from({ length: count }, (_, i) => ({ i, tool: 't', outcome: 'x\n"\\'.repeat(size) })) } });
          const result = await h.call('get_activity', { limit: 100 });
          expect(result.text.length).toBeLessThanOrEqual(20_000);
          expect(result.isError).toBe(false);
          expect(result.json.entries !== undefined || result.json.truncated === true).toBe(true);
        }),
        RUNS
      );
    } finally {
      await h.close();
    }
  }, 120_000);

  it('Property 9: A change runs only after a human said yes', async () => {
    // Feature: kiro-native-agent-and-firewall, Property 9: A change runs only after a human said yes
    // Validates: Requirements 4.6, 4.7, 4.8, 5.3, 5.4, 5.7, 5.8, 5.9
    const decisions = ['approved', 'denied', 'timeout', 'withdrawn', 'unavailable'] as const;
    const h = await startMcpHarness();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('test_write', 'test_read', 'delete', 'install', 'update'),
          fc.constantFrom(...decisions),
          fc.option(fc.boolean(), { nil: undefined }),
          async (kind, decision, confirm) => {
            h.events.length = 0;
            h.asked.length = 0;
            h.studio.reset();
            h.decision.value = decision;
            const withConfirm = confirm === undefined ? {} : { confirm };
            let mutating: string;
            let result: Awaited<ReturnType<typeof h.call>>;
            if (kind === 'test_write') {
              mutating = 'POST /api/playground/call';
              result = await h.call('test_action', { tool: 'add_customer', arguments: { name: 'Ada' }, ...withConfirm });
            } else if (kind === 'test_read') {
              mutating = 'POST /api/playground/call';
              result = await h.call('test_action', { tool: 'look_up_customer', ...withConfirm });
            } else if (kind === 'delete') {
              mutating = 'POST /api/workflows/delete';
              result = await h.call('delete_action', { id: 'wf-read', ...withConfirm });
            } else if (kind === 'install') {
              mutating = 'POST /api/power/install';
              await h.call('preview_kiro_install', { scope: 'project' });
              h.events.length = 0;
              result = await h.call('install_to_kiro', { scope: 'project', confirmationId: 'confirm-1' });
            } else {
              mutating = 'POST /api/workflows/update';
              result = await h.call('update_action', { id: 'wf-read', label: 'New', ...withConfirm });
            }
            const sent = h.events.includes(mutating);
            const askedAt = h.events.indexOf('ASK');
            if (kind === 'test_read') {
              // A read tool runs with no question
              expect(sent).toBe(true);
              expect(askedAt).toBe(-1);
            } else if (kind === 'install') {
              // The install has no confirm field: the human decision alone decides
              expect(sent).toBe(decision === 'approved');
              if (sent) expect(askedAt).toBeGreaterThanOrEqual(0);
            } else if (kind === 'update') {
              // update_action has a confirm and no question
              expect(sent).toBe(confirm === true);
              expect(askedAt).toBe(-1);
            } else {
              expect(sent).toBe(confirm === true && decision === 'approved');
              if (sent) expect(askedAt).toBeGreaterThanOrEqual(0);
              if (sent) expect(askedAt).toBeLessThan(h.events.indexOf(mutating));
              if (confirm !== true) expect(h.asked).toEqual([]);
            }
            if (!sent) {
              expect(result.isError).toBe(true);
              expect(['confirmation_required', 'approval_denied', 'approval_timeout', 'approval_unavailable']).toContain(result.json.error);
              expect(h.studio.count(mutating)).toBe(0);
            }
          }
        ),
        RUNS
      );
    } finally {
      await h.close();
    }
  }, 120_000);

  it('Property 10: Tool answers and requests match the Studio\'s own data', async () => {
    // Feature: kiro-native-agent-and-firewall, Property 10: Tool answers and requests match the Studio's own data
    // Validates: Requirements 2.2, 2.3, 2.8, 3.2, 4.4, 5.2, 5.6
    const workflow = fc.record({
      id: fc.stringMatching(/^wf-[a-z0-9]{3,8}$/),
      label: word,
      toolName: fc.option(fc.stringMatching(/^[a-z][a-z_]{2,12}$/), { nil: undefined }),
      description: fc.option(word, { nil: undefined }),
      risk: fc.constantFrom('read' as const, 'write' as const, 'delete' as const),
      variables: fc.array(fc.record({ name: fc.stringMatching(/^[a-z][a-z_]{1,10}$/), type: fc.constantFrom('string', 'number', 'boolean'), optional: fc.boolean() }), { maxLength: 4 }),
      steps: fc.array(word, { minLength: 1, maxLength: 5 }),
    });
    const h = await startMcpHarness();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(workflow, { selector: (w) => w.id, minLength: 1, maxLength: 5 }),
          fc.boolean(),
          fc.array(fc.record({ tool: fc.stringMatching(/^[a-z]{3,8}$/), n: fc.nat(1000) }), { maxLength: 10 }),
          word,
          fc.boolean(),
          async (workflows, compiled, entries, name, reuseSession) => {
            const views = workflows.map((w) => ({
              id: w.id,
              label: w.label,
              ...(w.toolName === undefined ? {} : { toolName: w.toolName }),
              ...(w.description === undefined ? {} : { description: w.description }),
              risk: { highest: w.risk },
              variables: w.variables,
              steps: w.steps.map((label, index) => ({ index, action: 'click', label })),
              writeSteps: w.risk === 'read' ? [] : [{ index: 0, label: w.steps[0], risk: w.risk, kind: 'action' }],
            }));
            h.studio.set('GET /api/workflows', { status: 200, body: { workflows: views, truncated: false } });
            h.studio.set('GET /api/overview', { status: 200, body: { sample: false, targetName: 'App', outputCompiled: compiled } });
            h.studio.set('GET /api/activity', { status: 200, body: { entries, tools: [], total: entries.length } });
            h.studio.reset();

            const list = await h.call('list_actions');
            expect(list.json.actions).toEqual(
              workflows.map((w) => ({
                id: w.id,
                tool: w.toolName ?? null,
                label: w.label,
                ...(w.description === undefined ? {} : { description: w.description }),
                risk: w.risk,
                variables: w.variables,
                compiled,
              }))
            );
            for (const w of workflows) {
              const one = await h.call('get_action', { id: w.id });
              expect(one.json).toMatchObject({ id: w.id, label: w.label, risk: w.risk, compiled, steps: w.steps });
              expect((one.json.writeSteps as unknown[]).length).toBe(w.risk === 'read' ? 0 : 1);
            }
            const activity = await h.call('get_activity', { limit: 100 });
            expect(activity.json.entries).toEqual(entries);

            h.studio.reset();
            const url = 'https://example.com/start';
            await h.call('start_recording', { name, url, reuseSession });
            expect(h.studio.requests.find((r) => r.path === '/api/record/start')?.body).toEqual({ name, url, reuseSession });

            const first = workflows[0]!;
            await h.call('update_action', { id: first.id, confirm: true, label: name, variables: first.variables.slice(0, 1).map((v) => ({ name: v.name, optional: !v.optional })) });
            expect(h.studio.requests.find((r) => r.path === '/api/workflows/update')?.body).toEqual({
              id: first.id,
              label: name,
              variables: first.variables.slice(0, 1).map((v) => ({ name: v.name, optional: !v.optional })),
            });
          }
        ),
        RUNS
      );
    } finally {
      await h.close();
    }
  }, 120_000);
});
