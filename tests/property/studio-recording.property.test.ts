import { afterAll, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAppData } from '../../src/studio/app-data.js';
import type { RecordingState, StartInput, StudioServices } from '../../src/studio/contracts.js';
import { makeScrubber } from '../../src/studio/redact.js';
import { createRecordingManager } from '../../src/studio/recording-manager.js';
import { recordRoutes } from '../../src/studio/routes/record.js';
import { sessionRoutes } from '../../src/studio/routes/sessions.js';
import type { RouteContext } from '../../src/studio/routes/types.js';
import { createSessionStore, sessionFileName } from '../../src/studio/session-store.js';
import { FakeCompiler, FakeRecord, MemorySessions } from '../helpers/fake-record.js';
import { removeDir } from '../helpers/cleanup.js';

const input: StartInput = { name: 'Find order', url: 'https://shop.test/start', reuseSession: false };
const settled = async (): Promise<void> => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));
};
function manager(scrub: (t: string) => string = (t) => t) {
  const fake = new FakeRecord();
  const compiler = new FakeCompiler();
  const m = createRecordingManager({ workflowFile: '/w/f.json', sessions: new MemorySessions(), compiler, scrub, record: fake.fn, closeDeadlineMs: 5 });
  return { fake, compiler, m };
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeDir(r);
});

const origin = fc.webUrl({ validSchemes: ['http', 'https'], withQueryParameters: true, withFragments: true });

// Feature: studio-first-flow, Property 14: Application key and session file correspond
describe('Property 14: Application key and session file correspond', () => {
  /** **Validates: Requirements 6.1** */
  it('equal keys give equal file names inside the App_Data_Dir, and non-http URLs have no key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prop14-'));
    roots.push(root);
    const data = join(root, 'data');
    const store = createSessionStore({
      appData: createAppData({ cwd: join(root, 'work'), outDir: join(root, 'work', 'out'), env: { DAEMONIZE_DATA_DIR: data } }),
    });
    await fc.assert(
      fc.asyncProperty(origin, origin, async (a, b) => {
        const ka = store.keyFor(a) as string;
        const kb = store.keyFor(b) as string;
        expect(ka).toBeDefined();
        expect(ka === kb).toBe(sessionFileName(ka) === sessionFileName(kb));
        expect(sessionFileName(ka)).toMatch(/^[0-9a-f]{40}\.storage-state\.json$/);
        await store.save(ka, { cookies: [], origins: [] });
        const path = (await store.pathFor(ka)) as string;
        expect(dirname(path)).toBe(resolve(data));
      }),
      { numRuns: 30 }
    );
    expect(store.keyFor('ftp://x.test')).toBeUndefined();
    expect(store.keyFor('not a url')).toBeUndefined();
  });
});

// Feature: studio-first-flow, Property 11: At most one recording under concurrency
describe('Property 11: At most one recording under concurrency', () => {
  /** **Validates: Requirements 4.4, 4.5, 14.5** */
  it('exactly one of N concurrent starts is accepted and record() runs once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),
        fc.constantFrom<RecordingState>('idle', 'done', 'error'),
        async (n, from) => {
          const { fake, m } = manager();
          if (from !== 'idle') {
            m.start(input);
            fake.steps = from === 'done' ? 1 : 0;
            m.stop();
            await settled();
            expect(m.status().state).toBe(from);
            fake.calls.length = 0;
          }
          fake.endOnAbort = false;
          const outcomes = await Promise.all(Array.from({ length: n }, async () => m.start(input)));
          expect(outcomes.filter((o) => o.status === 202)).toHaveLength(1);
          expect(outcomes.filter((o) => o.status === 409)).toHaveLength(n - 1);
          await settled();
          expect(fake.calls).toHaveLength(1);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: studio-first-flow, Property 12: The recording state machine follows its edges
describe('Property 12: The recording state machine follows its edges', () => {
  type Event = 'start' | 'stop' | 'panel' | 'closed' | 'saveDone' | 'saveFailed' | 'compileOk' | 'compileFailed' | 'launchFailed' | 'close';
  const events: Event[] = ['start', 'stop', 'panel', 'closed', 'saveDone', 'saveFailed', 'compileOk', 'compileFailed', 'launchFailed', 'close'];
  const edges = new Set(['idle>recording', 'done>recording', 'error>recording', 'recording>saving', 'recording>error', 'saving>compiling', 'saving>error', 'compiling>done', 'compiling>error']);

  /** **Validates: Requirements 4.9, 4.14** */
  it('every observed state change is an allowed edge', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...events), { minLength: 1, maxLength: 25 }), async (sequence) => {
        const { fake, compiler, m } = manager();
        let gate: (() => void) | undefined;
        let previous: RecordingState = m.status().state;
        const observe = (): void => {
          const now = m.status().state;
          if (now !== previous) expect(edges.has(`${previous}>${now}`), `${previous} to ${now}`).toBe(true);
          previous = now;
        };
        for (const event of sequence) {
          const before = m.status();
          switch (event) {
            case 'start':
              compiler.gate = new Promise<void>((r) => { gate = r; });
              fake.launchError = undefined;
              fake.steps = 1;
              m.start(input);
              break;
            case 'launchFailed':
              fake.launchError = 'cannot open';
              m.start(input);
              break;
            case 'stop': m.stop(); break;
            case 'panel': fake.end('panel'); break;
            case 'closed': fake.end('closed'); fake.fail(new Error('Recording interrupted: the browser exited.')); break;
            case 'saveDone': fake.end('api'); fake.succeed(); break; // record() reports the end before it saves
            case 'saveFailed': fake.fail(new Error('save failed')); break;
            case 'compileOk': compiler.outcome = { ok: true }; gate?.(); break;
            case 'compileFailed': compiler.outcome = { ok: false, message: 'no', outputMayBeIncomplete: false }; gate?.(); break;
            case 'close': { const closing = m.close(); observe(); await closing; break; }
          }
          observe();
          await settled();
          observe();
          // A start while active changes nothing
          if (event === 'start' && ['recording', 'saving', 'compiling'].includes(before.state)) expect(m.status().state).toBe(before.state);
        }
        gate?.();
        await settled();
        observe();
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: studio-first-flow, Property 13: Status holds step labels only
describe('Property 13: Status holds step labels only', () => {
  /** **Validates: Requirements 4.10, 4.11** */
  it('returns state, count, the last three labels, and no secret value', async () => {
    const secret = fc.string({ minLength: 6, maxLength: 12 }).filter((s) => s.trim().length >= 6);
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string({ maxLength: 20 }), { maxLength: 8 }), fc.nat(50), fc.array(secret, { maxLength: 3 }), async (labels, extra, secrets) => {
        const scrub = makeScrubber(secrets);
        const { fake, m } = manager(scrub);
        expect(m.status()).toEqual({ state: 'idle', steps: 0, labels: [] });
        m.start(input);
        fake.steps = labels.length + extra;
        fake.labels = [...labels, ...secrets.map((s) => `Type ${s}`)];
        const status = m.status();
        expect(status.state).toBe('recording');
        expect(status.steps).toBe(fake.steps);
        expect(status.labels.length).toBe(Math.min(3, fake.labels.length));
        for (const s of secrets) for (const l of status.labels) expect(l).not.toContain(s);
        expect(status).not.toHaveProperty('error');
        expect(status).not.toHaveProperty('recoveryFile');
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: studio-first-flow, Property 19: Plain-name fields reject path forms (applicationKey)
describe('Property 19: Plain-name fields reject path forms (applicationKey)', () => {
  /** **Validates: Requirements 13.9** */
  it('the sessions routes reject path forms and leave the session folder byte-identical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prop19-'));
    roots.push(root);
    const data = join(root, 'data');
    await mkdir(data, { recursive: true });
    const store = createSessionStore({
      appData: createAppData({ cwd: join(root, 'work'), outDir: join(root, 'work', 'out'), env: { DAEMONIZE_DATA_DIR: data } }),
    });
    await store.save('https://a.test', { cookies: [], origins: [] });
    await writeFile(join(data, 'other.txt'), 'x');
    const ctx = { services: { sessions: store } as unknown as StudioServices, loadSet: async () => ({ set: undefined, outputs: {} }) } as unknown as RouteContext;
    const forget = sessionRoutes(ctx).find((r) => r.path === '/api/sessions/forget')?.handlers.POST;
    const get = sessionRoutes(ctx).find((r) => r.path === '/api/sessions')?.handlers.GET;
    const snapshot = async (): Promise<string> => {
      const names = (await readdir(data)).sort();
      return JSON.stringify(await Promise.all(names.map(async (n) => [n, await readFile(join(data, n), 'utf8')])));
    };
    const before = await snapshot();
    const pathLike = fc.oneof(
      fc.constantFrom('..', '../x', '..\\x', '/etc/passwd', 'C:\\Windows', 'a\0b', 'https://a.test/..', 'https://a.test/x', '\\\\host\\share'),
      fc.tuple(fc.string(), fc.constantFrom('/', '\\', '\0', '..')).map(([s, sep]) => `${s}${sep}${s}`)
    );
    await fc.assert(
      fc.asyncProperty(pathLike, async (value) => {
        const signal = new AbortController().signal;
        const res = await forget!({ method: 'POST', query: new URLSearchParams(), body: { applicationKey: value }, signal });
        expect(res.status).toBe(400);
        const res2 = await get!({ method: 'GET', query: new URLSearchParams({ key: value }), body: {}, signal });
        expect(res2.status).toBe(400);
        expect(await snapshot()).toBe(before);
      }),
      { numRuns: 100 }
    );
    void recordRoutes;
  });
});
