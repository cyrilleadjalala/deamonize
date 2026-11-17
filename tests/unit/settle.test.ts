import { describe, it, expect } from 'vitest';
import {
  isIgnorableRequest,
  isPeriodic,
  QuietTracker,
  RequestTracker,
  parseTimeoutMs,
  resolveTimeoutMs,
  resolveStepTimeoutMs,
  boundStepTimeoutMs,
  waitForEffect,
  LONG_LIVED_MS,
  type SettlePage,
} from '../../src/replay/runtime/settle.js';

describe('isIgnorableRequest', () => {
  it('ignores sockets, event streams and inline data', () => {
    expect(isIgnorableRequest('http://x/ws', 'websocket')).toBe(true);
    expect(isIgnorableRequest('http://x/e', 'eventsource')).toBe(true);
    expect(isIgnorableRequest('ws://x/ws', 'fetch')).toBe(true);
    expect(isIgnorableRequest('data:text/plain,hi', 'fetch')).toBe(true);
    expect(isIgnorableRequest('http://x/stream', 'fetch', { Accept: 'text/event-stream' })).toBe(true);
  });

  it('counts ordinary fetch, xhr and document requests', () => {
    expect(isIgnorableRequest('http://x/api', 'fetch', { accept: 'application/json' })).toBe(false);
    expect(isIgnorableRequest('http://x/api', 'xhr')).toBe(false);
    expect(isIgnorableRequest('http://x/page', 'document')).toBe(false);
  });
});

describe('isPeriodic', () => {
  it('recognises an even rhythm and rejects an irregular one', () => {
    expect(isPeriodic([0, 100, 205, 298, 402])).toBe(true);
    expect(isPeriodic([0, 10, 90, 110, 200])).toBe(false);
    expect(isPeriodic([0, 100, 200])).toBe(false);
    expect(isPeriodic([0, 100, 200], 3)).toBe(true);
  });
});

describe('QuietTracker', () => {
  const sample = (count: number, pageNow: number, times: number[]) => ({ count, pageNow, times });

  it('is quiet after the quiet period without mutation', () => {
    const tracker = new QuietTracker(150, 0);
    tracker.observe(sample(0, 0, []), 0);
    expect(tracker.isQuiet(100)).toBe(false);
    expect(tracker.isQuiet(150)).toBe(true);
  });

  it('restarts the period at each mutation', () => {
    const tracker = new QuietTracker(150, 0);
    tracker.observe(sample(0, 0, []), 0);
    tracker.observe(sample(1, 120, [100]), 120);
    expect(tracker.isQuiet(240)).toBe(false);
    expect(tracker.isQuiet(250)).toBe(true);
  });

  it('treats mutations at a fixed rhythm as background noise', () => {
    const tracker = new QuietTracker(150, 0);
    tracker.observe(sample(0, 0, []), 0);
    tracker.observe(sample(5, 500, [100, 200, 300, 400, 500]), 500);
    expect(tracker.isQuiet(500)).toBe(true);
  });

  it('does not treat irregular mutations as noise', () => {
    const tracker = new QuietTracker(150, 0);
    tracker.observe(sample(0, 0, []), 0);
    tracker.observe(sample(5, 500, [100, 110, 190, 210, 500]), 500);
    expect(tracker.isQuiet(520)).toBe(false);
  });
});

describe('RequestTracker', () => {
  it('is not settled until a counted request started and completed', () => {
    const tracker = new RequestTracker();
    expect(tracker.responded(1000)).toBe(false);
    tracker.start('a', 'http://x/api?q=1', 'fetch', {}, 0);
    expect(tracker.responded(10)).toBe(false);
    tracker.finish('a', 20);
    expect(tracker.responded(30)).toBe(false); // grace period
    expect(tracker.responded(100)).toBe(true);
  });

  it('never waits for a socket or an event stream', () => {
    const tracker = new RequestTracker();
    tracker.start('s', 'http://x/sse', 'eventsource', {}, 0);
    tracker.start('f', 'http://x/s2', 'fetch', { accept: 'text/event-stream' }, 0);
    expect(tracker.pending(10)).toBe(0);
    expect(tracker.responded(1000)).toBe(false);
  });

  it('keeps counting a single slow request until it finishes', () => {
    const tracker = new RequestTracker();
    tracker.start('p', 'http://x/slow?_rsc=1', 'fetch', {}, 0);
    expect(tracker.pending(100)).toBe(1);
    expect(tracker.pending(LONG_LIVED_MS + 1)).toBe(1);
    expect(tracker.pending(8000)).toBe(1);
    tracker.finish('p', 8100);
    expect(tracker.pending(8101)).toBe(0);
  });

  it('keeps the long-poll protection for a repeated key', () => {
    const tracker = new RequestTracker();
    tracker.start('e1', 'http://x/events', 'fetch', {}, 0);
    tracker.start('e2', 'http://x/events', 'fetch', {}, 700);
    expect(tracker.pending(1000)).toBe(2);
    expect(tracker.pending(LONG_LIVED_MS + 1)).toBe(1); // only the one younger than 2 s
    expect(tracker.pending(LONG_LIVED_MS + 701)).toBe(0);
  });

  it('ignores requests that repeat on a fixed interval', () => {
    const tracker = new RequestTracker();
    for (const [i, t] of [0, 100, 200].entries()) tracker.start(i, `http://x/poll?t=${t}`, 'fetch', {}, t);
    expect(tracker.pending(210)).toBe(0);
    expect(tracker.responded(1000)).toBe(false);
  });
});

describe('timeouts', () => {
  it('parses positive integers up to the maximum only', () => {
    expect(parseTimeoutMs(500)).toBe(500);
    expect(parseTimeoutMs('500')).toBe(500);
    expect(parseTimeoutMs(0)).toBeUndefined();
    expect(parseTimeoutMs(1.5)).toBeUndefined();
    expect(parseTimeoutMs(600001)).toBeUndefined();
    expect(parseTimeoutMs('abc')).toBeUndefined();
    expect(parseTimeoutMs(undefined)).toBeUndefined();
  });

  it('resolves the whole-replay timeout: call, env, workflow, set, default', () => {
    expect(resolveTimeoutMs({ call: 1, env: '2', workflow: 3, set: 4 })).toBe(1);
    expect(resolveTimeoutMs({ env: '2', workflow: 3, set: 4 })).toBe(2);
    expect(resolveTimeoutMs({ workflow: 3, set: 4 })).toBe(3);
    expect(resolveTimeoutMs({ set: 4 })).toBe(4);
    expect(resolveTimeoutMs({})).toBe(30000);
    expect(resolveTimeoutMs({ call: -5, env: 'x', set: 4 })).toBe(4);
  });

  it('resolves the step timeout: step, env, default', () => {
    expect(resolveStepTimeoutMs({ step: 10, env: '20' })).toBe(10);
    expect(resolveStepTimeoutMs({ env: '20' })).toBe(20);
    expect(resolveStepTimeoutMs({})).toBe(8000);
  });

  it('never lets a step exceed what is left of the replay', () => {
    expect(boundStepTimeoutMs(8000, 500)).toBe(500);
    expect(boundStepTimeoutMs(300, 5000)).toBe(300);
    expect(boundStepTimeoutMs(8000, -10)).toBe(100);
  });
});

describe('waitForEffect with a fake page', () => {
  function fakePage(sampleOf: () => unknown): SettlePage & { handlers: Map<string, (arg: any) => void> } {
    const handlers = new Map<string, (arg: any) => void>();
    return {
      handlers,
      on: (event, handler) => void handlers.set(event, handler),
      off: (event) => void handlers.delete(event),
      evaluate: async () => sampleOf(),
    };
  }

  it('settles once the DOM is quiet', async () => {
    const page = fakePage(() => ({ count: 0, pageNow: 0, times: [] }));
    const started = Date.now();
    expect(await waitForEffect(page, { timeoutMs: 2000 })).toBe('quiet');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('counts a bounded wait as done without throwing', async () => {
    let n = 0;
    // Irregular mutations: never quiet, never periodic
    const page = fakePage(() => {
      n++;
      return { count: n, pageNow: n, times: [n - 40, n - 30, n - 5, n - 3, n] };
    });
    const started = Date.now();
    await expect(waitForEffect(page, { timeoutMs: 300 })).resolves.toBe('bound');
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const request = (url: string) => ({ url: () => url, resourceType: () => 'fetch', headers: () => ({}) });

  it('answers "response" only once the DOM was quiet for quietMs after the last finish', async () => {
    const page = fakePage(() => ({ count: 0, pageNow: 0, times: [] }));
    let finishedAt = 0;
    const reason = await waitForEffect(page, {
      timeoutMs: 3000,
      quietMs: 200,
      action: async () => {
        const r = request('http://x/api');
        page.handlers.get('request')!(r);
        await sleep(30);
        finishedAt = Date.now();
        page.handlers.get('requestfinished')!(r);
      },
    });
    expect(reason).toBe('response');
    expect(Date.now() - finishedAt).toBeGreaterThanOrEqual(190);
    expect(Date.now() - finishedAt).toBeLessThan(1000);
  });

  it('sees an SPA navigation through nav, then returns after 250 ms of quiet', async () => {
    const t0 = Date.now();
    const page = fakePage(() => ({ count: 0, pageNow: 0, times: [], nav: Date.now() - t0 > 300 ? 1 : 0 }));
    const reason = await waitForEffect(page, {
      timeoutMs: 4000,
      quietMs: 50,
      // A pending request keeps the wait open until the navigation shows up
      action: async () => page.handlers.get('request')!(request('http://x/rsc')),
    });
    const elapsed = Date.now() - t0;
    expect(reason).toBe('navigation');
    expect(elapsed).toBeGreaterThanOrEqual(300 + 250 - 40);
  });

  it('sees an SPA navigation through href only', async () => {
    const t0 = Date.now();
    const page = fakePage(() => ({
      count: 0,
      pageNow: 0,
      times: [],
      href: Date.now() - t0 > 300 ? 'http://x/clients' : 'http://x/',
    }));
    const started = Date.now();
    const reason = await waitForEffect(page, {
      timeoutMs: 4000,
      quietMs: 50,
      action: async () => page.handlers.get('request')!(request('http://x/rsc')),
    });
    expect(reason).toBe('navigation');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300 + 250 - 40);
  });

  it('after framenavigated returns once the mutations stopped for 250 ms', async () => {
    const t0 = Date.now();
    const page = Object.assign(
      fakePage(() => {
        const e = Date.now() - t0;
        const last = Math.min(e, 200);
        return { count: Math.floor(last / 20), pageNow: e, times: [last - 17, last - 9, last - 4, last - 1, last] };
      }),
      { mainFrame: () => 'main' }
    );
    const reason = await waitForEffect(page, {
      timeoutMs: 4000,
      action: async () => page.handlers.get('framenavigated')!('main'),
    });
    expect(reason).toBe('navigation');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200 + 250 - 60);
  });

  it('after framenavigated returns at the bound when the mutations never stop', async () => {
    let n = 0;
    const page = Object.assign(
      fakePage(() => {
        n++;
        return { count: n, pageNow: n, times: [n - 40, n - 30, n - 5, n - 3, n] };
      }),
      { mainFrame: () => 'main' }
    );
    const started = Date.now();
    const reason = await waitForEffect(page, {
      timeoutMs: 600,
      action: async () => page.handlers.get('framenavigated')!('main'),
    });
    expect(reason).toBe('navigation');
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('works with samples that carry no nav and href', async () => {
    const page = fakePage(() => ({ count: 0, pageNow: 0, times: [] }));
    expect(await waitForEffect(page, { timeoutMs: 2000, quietMs: 50 })).toBe('quiet');
  });

  it('passes the error of the action on', async () => {
    const page = fakePage(() => ({ count: 0, pageNow: 0, times: [] }));
    await expect(
      waitForEffect(page, { action: async () => { throw new Error('no such element'); } })
    ).rejects.toThrow('no such element');
    expect(page.handlers.size).toBe(0);
  });
});
