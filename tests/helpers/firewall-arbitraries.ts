/**
 * Shared fast-check generators of the firewall work (approval queue, audit log, trace, wrapper, routes, Studio_MCP).
 * Owned by group G0: other groups import this file and do not edit it.
 *
 * Every secret-like value is built at run time from random characters in the SHAPE of a credential (`sk-...`, a JWT,
 * a base64 run, a long hex string). None is a real credential, and the source holds no literal that looks like one.
 */
import fc from 'fast-check';
import type { ApprovalRequestBody, WriteStepMeta } from '../../src/replay/runtime/approval-queue.js';
import type { AuditEntry } from '../../src/replay/runtime/audit-log.js';
import type { TraceLevel, TraceStatus, TraceStep } from '../../src/replay/runtime/trace.js';

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const B64URL = `${ALNUM}-_`;
const HEX = '0123456789abcdef';

const charsFrom = (alphabet: string, min: number, max: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...alphabet.split('')), { minLength: min, maxLength: max }).map((c) => c.join(''));

// ---- strings ----------------------------------------------------------------------------------------------------

/** A value in the shape of a credential: `sk-` plus random characters, a JWT of three base64url parts, a base64 run, or long hex. */
export const secretLikeString: fc.Arbitrary<string> = fc.oneof(
  charsFrom(ALNUM, 24, 48).map((s) => `sk-${s}`),
  fc.tuple(charsFrom(B64URL, 12, 30), charsFrom(B64URL, 12, 60), charsFrom(B64URL, 12, 43)).map(([a, b, c]) => `eyJ${a}.${b}.${c}`),
  charsFrom(`${ALNUM}+/`, 40, 88).map((s) => `${s}==`),
  charsFrom(HEX, 40, 64)
);

/** Text with `"`, `\`, newlines, tabs, controls and Unicode (accents, CJK, emoji, a lone surrogate-free mix). */
export const trickyString: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.stringMatching(/^[a-zA-Z0-9 "\\\n\r\t\u00e9\u00e8\u4e2d\u6587\u{1F600}]{0,200}$/u),
  fc.constantFrom('"', '\\', '\n', '\r\n', '"\\"\n', '\\n', '\u2028', '\u0000x', 'caf\u00e9 \u{1F600}')
);

/** 0 to 5000 characters of mixed text; sometimes holding a secret-like value, so redaction has something to find. */
export const anyText: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.string({ minLength: 0, maxLength: 5000 }), weight: 3 },
  { arbitrary: trickyString, weight: 3 },
  { arbitrary: fc.tuple(fc.string({ maxLength: 300 }), secretLikeString, fc.string({ maxLength: 300 })).map(([a, s, b]) => `${a} ${s} ${b}`), weight: 2 },
  { arbitrary: fc.string({ minLength: 4000, maxLength: 5000 }), weight: 1 }
);

/** Argument names that the redaction pattern treats as sensitive. */
export const sensitiveName: fc.Arbitrary<string> = fc.constantFrom(
  'password', 'passwd', 'passphrase', 'secret', 'client_secret', 'token', 'access_token', 'api_key', 'apiKey', 'otp', 'totp',
  'credential', 'cvv', 'pin', 'ssn', 'private_key', 'authorization', 'cookie', 'Password', 'userPassword'
);

/** A plain argument name (letters and digits, never sensitive). */
export const plainName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9_]{0,15}$/)
  .filter((n) => !/pass|secret|token|otp|api[-_ ]?key|credential|cvv|pin|ssn|private|authorization|cookie/i.test(n));

const jsonValue: fc.Arbitrary<unknown> = fc.oneof(trickyString, fc.integer(), fc.boolean(), fc.constant(null), fc.double({ noNaN: true, noDefaultInfinity: true }));

/** Arguments of a tool call: some plain names, some sensitive names (their values are secret-like), some nested objects. */
export const argumentsWithSensitiveNames: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    fc.dictionary(plainName, jsonValue, { maxKeys: 5 }),
    fc.dictionary(sensitiveName, secretLikeString, { maxKeys: 3 }),
    fc.option(fc.dictionary(plainName, fc.oneof(jsonValue, fc.dictionary(sensitiveName, secretLikeString, { maxKeys: 2 })), { maxKeys: 3 }), { nil: undefined })
  )
  .map(([plain, sensitive, nested]) => ({ ...plain, ...sensitive, ...(nested === undefined ? {} : { nested }) }));

// ---- trace ------------------------------------------------------------------------------------------------------

const TRACE_LEVELS: TraceLevel[] = ['http', 'accessibility', 'vision', 'terminal', 'skipped', 'not_run'];
const TRACE_STATUSES: TraceStatus[] = ['ok', 'failed', 'skipped', 'not_run', 'blocked', 'drifted'];

export const traceStep = (index: number): fc.Arbitrary<TraceStep> =>
  fc.record(
    {
      index: fc.constant(index),
      label: fc.string({ maxLength: 120 }),
      level: fc.constantFrom(...TRACE_LEVELS),
      durationMs: fc.nat({ max: 120_000 }),
      status: fc.constantFrom(...TRACE_STATUSES),
      note: fc.string({ maxLength: 120 }),
    },
    { requiredKeys: ['index', 'label', 'level', 'durationMs', 'status'] }
  );

/** A trace: consecutive indexes from 0, at most `maxSteps` steps. */
export const trace = (maxSteps = 12): fc.Arbitrary<TraceStep[]> =>
  fc.integer({ min: 0, max: maxSteps }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => traceStep(i))) as fc.Arbitrary<TraceStep[]>);

/** The steps of a workflow as the wrapper knows them. */
export const workflowSteps: fc.Arbitrary<Array<{ label?: string; actionType: string; risk?: 'read' | 'write' | 'delete' }>> = fc.array(
  fc.record(
    {
      label: fc.string({ minLength: 1, maxLength: 60 }),
      actionType: fc.constantFrom('click', 'type', 'select', 'navigate', 'wait', 'key'),
      risk: fc.constantFrom('read' as const, 'write' as const, 'delete' as const),
    },
    { requiredKeys: ['actionType'] }
  ),
  { minLength: 1, maxLength: 12 }
);

// ---- audit entries and approval requests ---------------------------------------------------------------------------

const hex = (n: number): fc.Arbitrary<string> => charsFrom(HEX, n, n);
const isoDate: fc.Arbitrary<string> = fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2035-01-01T00:00:00Z'), noInvalidDate: true }).map((d) => d.toISOString());
const toolName: fc.Arbitrary<string> = fc.stringMatching(/^[a-z][a-z0-9_]{2,30}$/);

export const auditEntry: fc.Arbitrary<AuditEntry> = fc
  .record(
    {
      v: fc.constant(1 as const),
      at: isoDate,
      tool: toolName,
      application: fc.webUrl({ validSchemes: ['https'] }).map((u) => new URL(u).origin),
      risk: fc.constantFrom('read' as const, 'write' as const, 'delete' as const),
      source: fc.constantFrom('kiro' as const, 'studio' as const),
      arguments: argumentsWithSensitiveNames,
      decision: fc.constantFrom('auto' as const, 'approved' as const, 'denied' as const, 'timeout' as const, 'unavailable' as const),
      outcome: fc.oneof(fc.constant('success'), fc.constantFrom('approval_denied', 'approval_timeout', 'approval_unavailable', 'validation', 'timeout'), fc.string({ maxLength: 200 })),
      durationMs: fc.nat({ max: 600_000 }),
      steps: trace(8),
    },
    { requiredKeys: ['v', 'at', 'tool', 'application', 'risk', 'source', 'arguments', 'decision', 'outcome', 'durationMs'] }
  )
  .map((e) => (e.steps !== undefined && e.steps.length === 0 ? { ...e, steps: undefined } : e) as AuditEntry);

export const writeStep: fc.Arbitrary<WriteStepMeta> = fc.record({
  index: fc.nat({ max: 50 }),
  label: fc.string({ minLength: 1, maxLength: 60 }),
  risk: fc.constantFrom('write' as const, 'delete' as const),
});

/** The body of an approval request (the record without its `mac`). `timeoutMs` stays in 5000 to 600000. */
export const approvalRequestBody: fc.Arbitrary<ApprovalRequestBody> = fc.record(
  {
    v: fc.constant(1 as const),
    id: hex(32),
    createdAt: isoDate,
    timeoutMs: fc.integer({ min: 5_000, max: 600_000 }),
    pid: fc.integer({ min: 1, max: 4_194_304 }),
    source: fc.constantFrom('kiro' as const, 'studio-mcp' as const),
    kind: fc.constantFrom('tool-call' as const, 'install' as const, 'delete-action' as const, 'test-action' as const),
    tool: toolName,
    application: fc.webUrl({ validSchemes: ['https'] }).map((u) => new URL(u).origin),
    risk: fc.constantFrom('write' as const, 'delete' as const),
    summary: fc.string({ maxLength: 120 }),
    arguments: argumentsWithSensitiveNames,
    writeSteps: fc.array(writeStep, { maxLength: 5 }),
  },
  { requiredKeys: ['v', 'id', 'createdAt', 'timeoutMs', 'pid', 'source', 'kind', 'tool', 'application', 'risk', 'arguments', 'writeSteps'] }
);

// ---- leases and routes ------------------------------------------------------------------------------------------

/** A lease as the Studio_MCP reads it (the shape of `StudioLease`, kept here so this file needs no other group). */
export interface LeaseLike {
  v: 1;
  origin: string;
  agentToken: string;
  pid: number;
  workspace: string;
  startedAt: string;
}
export const lease: fc.Arbitrary<LeaseLike> = fc.record({
  v: fc.constant(1 as const),
  origin: fc.integer({ min: 1024, max: 65535 }).map((port) => `http://127.0.0.1:${port}`),
  agentToken: charsFrom(B64URL, 24, 40),
  pid: fc.integer({ min: 1, max: 4_194_304 }),
  workspace: fc.constantFrom('/work/project', 'C:\\work\\project', '/home/user/app', 'D:\\data\\my project'),
  startedAt: isoDate,
});

/** A method and a path of the Studio API, known or not (the agent principal is confined to a short list). */
export const routeCall: fc.Arbitrary<{ method: 'GET' | 'POST'; path: string }> = fc.record({
  method: fc.constantFrom('GET' as const, 'POST' as const),
  path: fc.oneof(
    fc.constantFrom(
      '/api/health', '/api/overview', '/api/workflows', '/api/secrets', '/api/secrets/forget', '/api/activity', '/api/approvals',
      '/api/approvals/decide', '/api/record/start', '/api/record/stop', '/api/record/status', '/api/compile', '/api/compile/status',
      '/api/workflows/update', '/api/workflows/delete', '/api/playground', '/api/playground/call', '/api/power/info', '/api/power/preview',
      '/api/power/install', '/api/power/approval', '/api/power/remove', '/api/power/auto-add', '/api/power/daemonize/install',
      '/api/sessions/forget', '/api/pbt/run', '/api/system/browser'
    ),
    fc.stringMatching(/^\/api\/[a-z]{1,10}(\/[a-z]{1,10}){0,2}$/)
  ),
});

/** A set of route calls, for the tests of the closed route lists. */
export const routeSet: fc.Arbitrary<Array<{ method: 'GET' | 'POST'; path: string }>> = fc.array(routeCall, { minLength: 1, maxLength: 30 });
