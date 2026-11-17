import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  RequestTracker,
  waitForEffect,
  isIgnorableRequest,
  isPeriodic,
  LONG_LIVED_MS,
  type SettlePage,
} from '../../src/replay/runtime/settle.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fake page: events are fired by the test, the DOM sample is computed from the elapsed time. */
function fakePage(sampleAt: (elapsed: number) => Record<string, unknown>) {
  const handlers = new Map<string, (arg: any) => void>();
  const t0 = Date.now();
  const main = {};
  const page: SettlePage & { fire(event: string, arg?: unknown): void; main: object } = {
    main,
    on: (event, handler) => void handlers.set(event, handler),
    off: (event) => void handlers.delete(event),
    evaluate: async () => sampleAt(Date.now() - t0),
    mainFrame: () => main,
    waitForLoadState: async () => undefined,
    fire: (event, arg) => handlers.get(event)?.(arg),
  };
  return page;
}

const req = (url: string, type = 'fetch', headers: Record<string, string> = {}) => ({
  url: () => url,
  resourceType: () => type,
  headers: () => headers,
});

/** Samples of a DOM that mutates irregularly until `endAt`, and an optional nav counter. */
function mutatingDom(endAt: number, navAt?: number) {
  return (elapsed: number) => {
    const all: number[] = [];
    for (let t = 10, i = 0; t <= Math.min(elapsed, endAt); i++) {
      all.push(t);
      t += [7, 31, 13, 47, 19][i % 5];
    }
    return {
      count: all.length,
      pageNow: elapsed,
      times: all.slice(-8),
      nav: navAt !== undefined && elapsed >= navAt ? 1 : 0,
      href: navAt !== undefined && elapsed >= navAt ? 'http://x/clients' : 'http://x/',
    };
  };
}

// The original pending(): a request counts until finished, or until LONG_LIVED_MS of age
function originalPending(
  entries: Array<{ key: string; startedAt: number; ignorable: boolean; finishedAt?: number }>,
  starts: Map<string, number[]>,
  now: number
): number {
  let n = 0;
  for (const e of entries) {
    if (e.finishedAt !== undefined) continue;
    if (e.ignorable) continue;
    if (isPeriodic(starts.get(e.key) ?? [], 3)) continue;
    if (now - e.startedAt < LONG_LIVED_MS) n++;
  }
  return n;
}

describe('settle: bug condition (Property 1)', () => {
  // Feature: nextjs-spa-replay-fixes, Property 1: Bug Condition - Wait covers slow requests, SPA navigation and hydration
  // **Validates: Requirements 2.1, 2.3, 2.4**
  it('counts a single slow request until it finishes, whatever its duration above 2 s', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60000 }), fc.stringMatching(/^[a-z]{1,8}$/), (extra, name) => {
        const tracker = new RequestTracker();
        tracker.start('a', `http://x/${name}?_rsc=1`, 'fetch', {}, 0);
        expect(tracker.pending(LONG_LIVED_MS + extra)).toBe(1);
        tracker.finish('a', LONG_LIVED_MS + extra + 1);
        expect(tracker.pending(LONG_LIVED_MS + extra + 2)).toBe(0);
      })
    );
  });

  it('does not return "response" before an SPA navigation after the request and 250 ms of DOM quiet', async () => {
    const navAt = 200; // 100 ms after the response, like React committing after the RSC payload
    const page = fakePage(mutatingDom(0, navAt));
    const started = Date.now();
    const reason = await waitForEffect(page, {
      timeoutMs: 4000,
      action: async () => {
        const r = req('http://x/clients?_rsc=1');
        page.fire('request', r);
        await sleep(100);
        page.fire('requestfinished', r);
      },
    });
    const elapsed = Date.now() - started;
    expect(reason).toBe('navigation');
    expect(elapsed).toBeGreaterThanOrEqual(navAt + 250 - 40);
    expect(elapsed).toBeLessThan(3000);
  });

  it('after framenavigated waits for a 250 ms DOM quiet period, within the bound', async () => {
    const page = fakePage(mutatingDom(200));
    const started = Date.now();
    const reason = await waitForEffect(page, {
      timeoutMs: 4000,
      action: async () => page.fire('framenavigated', page.main),
    });
    const elapsed = Date.now() - started;
    expect(reason).toBe('navigation');
    expect(elapsed).toBeGreaterThanOrEqual(200 + 250 - 40);
    expect(elapsed).toBeLessThan(2000);
  });

  it('never goes past the bound when the DOM keeps mutating after a navigation', async () => {
    const page = fakePage(mutatingDom(1e9));
    const started = Date.now();
    const reason = await waitForEffect(page, {
      timeoutMs: 700,
      action: async () => page.fire('framenavigated', page.main),
    });
    const elapsed = Date.now() - started;
    expect(reason).toBe('navigation');
    expect(elapsed).toBeGreaterThanOrEqual(650);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('settle: preservation (Property 2)', () => {
  // Feature: nextjs-spa-replay-fixes, Property 2: Preservation - Streams, polls, quiet pages and bounds settle as before
  // **Validates: Requirements 2.2, 3.1, 3.2, 3.3, 3.4**
  const ignorable = fc.constantFrom<[string, string, Record<string, string>]>(
    ['http://x/ws', 'websocket', {}],
    ['http://x/e', 'eventsource', {}],
    ['http://x/s', 'fetch', { Accept: 'text/event-stream' }],
    ['data:text/plain,hi', 'fetch', {}],
    ['blob:http://x/1234', 'fetch', {}]
  );

  it('RequestTracker.pending equals the original for ignorable and periodic entries', () => {
    fc.assert(
      fc.property(
        fc.array(ignorable, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 50, max: 400 }),
        fc.integer({ min: 0, max: 6000 }),
        (ignored, period, now) => {
          const tracker = new RequestTracker();
          const entries: Array<{ key: string; startedAt: number; ignorable: boolean }> = [];
          const starts = new Map<string, number[]>();
          ignored.forEach(([url, type, headers], i) => {
            tracker.start(`i${i}`, url, type, headers, 0);
            const key = url.split(/[?#]/)[0];
            entries.push({ key, startedAt: 0, ignorable: isIgnorableRequest(url, type, headers) });
            starts.set(key, [...(starts.get(key) ?? []), 0]);
          });
          const times = [0, period, 2 * period, 3 * period];
          times.forEach((t, i) => {
            tracker.start(`p${i}`, `http://x/poll?t=${t}`, 'fetch', {}, t);
            entries.push({ key: 'http://x/poll', startedAt: t, ignorable: false });
          });
          starts.set('http://x/poll', times);
          const at = Math.max(now, 3 * period);
          expect(tracker.pending(at)).toBe(originalPending(entries, starts, at));
          expect(tracker.pending(at)).toBe(0);
        }
      )
    );
  });

  it('a mix of ignorable requests with a quiet DOM returns "quiet" quickly', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(ignorable, { minLength: 1, maxLength: 4 }), async (ignored) => {
        const page = fakePage((e) => ({ count: 0, pageNow: e, times: [] }));
        const started = Date.now();
        const reason = await waitForEffect(page, {
          timeoutMs: 3000,
          quietMs: 60,
          action: async () => ignored.forEach(([u, t, h], i) => page.fire('request', req(u, t, h) as never)),
        });
        expect(reason).toBe('quiet');
        expect(Date.now() - started).toBeLessThan(1500);
      }),
      { numRuns: 10 }
    );
  });

  it('a request that never ends returns "bound" at the timeout', async () => {
    const page = fakePage((e) => ({ count: 0, pageNow: e, times: [] }));
    const started = Date.now();
    const reason = await waitForEffect(page, {
      timeoutMs: 400,
      quietMs: 50,
      action: async () => page.fire('request', req('http://x/never')),
    });
    expect(reason).toBe('bound');
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
  });

  it('a counted request that responds returns "response"', async () => {
    const page = fakePage((e) => ({ count: 0, pageNow: e, times: [] }));
    const reason = await waitForEffect(page, {
      timeoutMs: 3000,
      quietMs: 200,
      action: async () => {
        const r = req('http://x/api');
        page.fire('request', r);
        await sleep(30);
        page.fire('requestfinished', r);
      },
    });
    expect(reason).toBe('response');
  });

  it('a full navigation on a quiet page returns shortly after domcontentloaded', async () => {
    const page = fakePage((e) => ({ count: 0, pageNow: e, times: [] }));
    const started = Date.now();
    const reason = await waitForEffect(page, {
      timeoutMs: 4000,
      action: async () => page.fire('framenavigated', page.main),
    });
    expect(reason).toBe('navigation');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('passes the error of the action on', async () => {
    const page = fakePage((e) => ({ count: 0, pageNow: e, times: [] }));
    await expect(waitForEffect(page, { action: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
  });
});
