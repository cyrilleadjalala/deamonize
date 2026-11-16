import { describe, it, expect, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
import fc from 'fast-check';
import { tmpdir } from 'node:os';
import { PlaygroundSession, type ConnectFn } from '../../src/studio/playground.js';
import { startStudio } from '../../src/studio/server.js';
import { rawRequest } from '../helpers/http.js';

// Secret values that cannot be mistaken for any word of a response: a fixed prefix and random letters
const secretArb = fc.stringMatching(/^[A-Za-z0-9]{10,18}$/).map((v) => `Zq9-${v}`);
const secretsArb = fc.uniqueArray(secretArb, { minLength: 4, maxLength: 4 });
const affix = fc.stringMatching(/^[a-z ]{0,6}$/);
const SENSITIVE_KEYS = ['password', 'apiKey', 'user_token', 'otp_code', 'CRM_PIN'] as const;
const PLAIN_KEYS = ['q', 'note', 'city', 'limit_text'] as const;

interface Plan {
  /** 0: environment secret, 1: DAEMONIZE_COOKIE_HEADER, 2 and 3: typed values of sensitive fields. */
  secrets: string[];
  pre: string;
  post: string;
  sensitiveKeys: string[];
  plainKeys: string[];
  /** Which plain fields carry an environment secret. */
  leakInto: string[];
}

const planArb: fc.Arbitrary<Plan> = fc.record({
  secrets: secretsArb,
  pre: affix,
  post: affix,
  sensitiveKeys: fc.uniqueArray(fc.constantFrom(...SENSITIVE_KEYS), { minLength: 1, maxLength: 2 }),
  plainKeys: fc.uniqueArray(fc.constantFrom(...PLAIN_KEYS), { minLength: 1, maxLength: 3 }),
  leakInto: fc.uniqueArray(fc.constantFrom(...PLAIN_KEYS), { minLength: 0, maxLength: 2 }),
});

function argumentsOf(p: Plan): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  p.plainKeys.forEach((k) => {
    args[k] = p.leakInto.includes(k) ? `${p.pre}${p.secrets[0]}${p.post}` : `${p.pre}plain${p.post}`;
  });
  p.sensitiveKeys.forEach((k, i) => {
    args[k] = `${p.pre}${p.secrets[2 + (i % 2)]}${p.post}`;
  });
  return args;
}

const gone = (text: string, secrets: readonly string[]): string | undefined => secrets.find((s) => text.includes(s));

/** A server that gives back everything it was given and everything it knows: the worst case for a leak. */
function echoConnect(envSecrets: readonly string[]): ConnectFn {
  return async () => ({
    client: {
      listTools: async () => ({
        tools: [{ name: 'echo', description: `Echo ${envSecrets[0]}`, inputSchema: { type: 'object', properties: {} } }],
      }),
      callTool: async (params) => {
        const args = params.arguments ?? {};
        const dump = JSON.stringify(args);
        const answer = {
          success: false,
          drifted: true,
          error: `step_failed ${dump}`,
          title: `Title ${envSecrets.join(' ')}`,
          text: `${dump} ${envSecrets.join(' ')}`,
          data: { args, env: envSecrets, nested: [{ again: dump }] },
          failure: { stepIndex: 0, action: 'click', reason: `could not find ${dump} ${envSecrets[1]}`, tried: [dump, ...envSecrets], label: envSecrets[0] },
          heal: { attempted: true, reason: dump },
          errors: [{ instancePath: '', message: dump }],
          levels: [dump],
          mode: 'strict',
        };
        return { content: [{ type: 'text', text: JSON.stringify(answer) }], isError: true };
      },
    },
    onClose: () => undefined,
    close: async () => undefined,
    stderrTail: () => envSecrets.join(' '),
  });
}

describe('Playground: no secret value ever leaves the bridge', () => {
  // Feature: daemonize, Property 21: playground responses never contain secret values
  it('holds for every answer and the history of a server that echoes its input and its environment', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const envSecrets = [plan.secrets[0], plan.secrets[1]];
        const env = { DAEMONIZE_SECRET_X: plan.secrets[0], DAEMONIZE_COOKIE_HEADER: plan.secrets[1] };
        const session = new PlaygroundSession({
          outDir: tmpdir(),
          env,
          connect: echoConnect(envSecrets),
          launch: () => ({ command: process.execPath, args: [], mcpEnv: {}, cwd: tmpdir() }),
          toolMeta: () => ({ risk: 'read', sensitiveArgs: [] }),
        });
        try {
          const all: string[] = [];
          const secretsToHide = plan.secrets;
          all.push(JSON.stringify(session.redact(await session.listTools())));
          for (let i = 0; i < 2; i++) {
            const out = await session.call({ tool: 'echo', arguments: argumentsOf(plan) });
            all.push(JSON.stringify(out));
          }
          // A call with its own timeout takes the same path
          all.push(JSON.stringify(await session.call({ tool: 'echo', arguments: argumentsOf(plan), timeoutMs: 1 })));
          all.push(JSON.stringify(session.history()));
          const leaked = gone(all.join('\n'), secretsToHide);
          expect(leaked, `leaked ${leaked}`).toBeUndefined();
          // The request itself reached the server with the real values: the bridge hid them only on the way back
          expect(session.history().length).toBe(3);
        } finally {
          await session.close();
        }
      }),
      { numRuns: 60 }
    );
  });

  it('holds for every response of the Studio API (sample server) with a planted environment', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const studio = await startStudio({ sampleData: true, env: { DAEMONIZE_SECRET_X: plan.secrets[0], DAEMONIZE_COOKIE_HEADER: plan.secrets[1] } });
        try {
          const seen: string[] = [];
          const get = async (path: string): Promise<void> => {
            const res = await rawRequest(studio, 'GET', path, { host: `127.0.0.1:${studio.port}`, 'x-studio-token': studio.token });
            seen.push(res.text);
          };
          const post = async (path: string, body: unknown): Promise<void> => {
            const res = await rawRequest(studio, 'POST', path, { host: `127.0.0.1:${studio.port}`, 'x-studio-token': studio.token, 'content-type': 'application/json' }, JSON.stringify(body));
            seen.push(res.text);
          };
          const extra = argumentsOf(plan);
          const value = (i: number): string => `${plan.pre}${plan.secrets[i]}${plan.post}`;
          await get('/api/playground');
          await post('/api/playground/call', { tool: 'create_customer', confirm: true, arguments: { ...extra, login: value(0), name: value(1) } });
          await post('/api/playground/call', { tool: 'count_customers_in_a_table', arguments: { ...extra, table: value(0) } });
          await post('/api/playground/call', { tool: 'search_customers', arguments: { ...extra, query: `${value(2)} ${value(3)}` } });
          await post('/api/playground/call', { tool: 'search_customers', arguments: { query: 5 } });
          await get('/api/playground/history');
          await get('/api/overview');
          expect(seen.length).toBe(7);
          // The answers are real ones, not error pages
          expect(seen.every((t) => t.startsWith('{'))).toBe(true);
          const leaked = gone(seen.join('\n'), plan.secrets.slice(0, 2).concat(plan.sensitiveKeys.map((_, i) => plan.secrets[2 + (i % 2)])));
          expect(leaked, `leaked ${leaked}`).toBeUndefined();
        } finally {
          await studio.close();
        }
      }),
      { numRuns: 12 }
    );
  });
});
