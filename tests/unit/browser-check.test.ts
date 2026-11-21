import { describe, expect, it } from 'vitest';
import { createBrowserCheck, type ProbeBrowser } from '../../src/studio/browser-check.js';
import { systemRoutes } from '../../src/studio/routes/system.js';
import type { RouteContext } from '../../src/studio/routes/types.js';

const NOT_FOUND = new Error("browserType.launch: Executable doesn't exist at C:\\secret\\path\\chrome.exe");

function fake(installed: Array<'chromium' | 'chrome' | 'msedge' | 'custom'>) {
  const calls: Array<Record<string, unknown>> = [];
  let closed = 0;
  const launch = async (options: { channel?: string; executablePath?: string }): Promise<ProbeBrowser> => {
    calls.push({ ...options });
    const which = options.executablePath !== undefined ? 'custom' : (options.channel ?? 'chromium');
    if (!installed.includes(which as 'chromium')) throw NOT_FOUND;
    return { close: async () => void closed++ };
  };
  return { launch, calls, closed: () => closed };
}

describe('browser check', () => {
  it('names the first browser of the chain and closes it', async () => {
    const f = fake(['chrome']);
    const check = createBrowserCheck({ env: {}, launch: f.launch });
    expect(await check.check()).toEqual({ available: true, browser: 'chrome' });
    expect(f.closed()).toBe(1);
  });

  it('names edge for the msedge channel and custom for DAEMONIZE_CHROMIUM_PATH', async () => {
    expect(await createBrowserCheck({ env: {}, launch: fake(['msedge']).launch }).check()).toEqual({ available: true, browser: 'edge' });
    const custom = createBrowserCheck({ env: { DAEMONIZE_CHROMIUM_PATH: 'C:\\x\\brave.exe' }, launch: fake(['custom']).launch });
    expect(await custom.check()).toEqual({ available: true, browser: 'custom' });
  });

  it('answers not available when nothing is installed or the launch fails', async () => {
    expect(await createBrowserCheck({ env: {}, launch: fake([]).launch }).check()).toEqual({ available: false });
    const broken = createBrowserCheck({ env: {}, launch: async () => { throw new Error('boom'); } });
    expect(await broken.check()).toEqual({ available: false });
  });

  it('caches for 30 s and checks again after', async () => {
    let t = 1000;
    const f = fake(['chromium']);
    const check = createBrowserCheck({ env: {}, now: () => t, launch: f.launch });
    await check.check();
    t += 29_999;
    await check.check();
    expect(f.calls).toHaveLength(1);
    t += 1;
    await check.check();
    expect(f.calls).toHaveLength(2);
  });

  it('shares one launch between simultaneous calls', async () => {
    const f = fake(['chromium']);
    const check = createBrowserCheck({ env: {}, launch: f.launch });
    await Promise.all([check.check(), check.check(), check.check()]);
    expect(f.calls).toHaveLength(1);
  });

  it('never puts a path in the answer', async () => {
    const custom = createBrowserCheck({ env: { DAEMONIZE_CHROMIUM_PATH: 'C:\\x\\brave.exe' }, launch: fake(['custom']).launch });
    expect(JSON.stringify(await custom.check())).not.toMatch(/brave|C:|\\\\/);
    expect(JSON.stringify(await createBrowserCheck({ env: {}, launch: fake([]).launch }).check())).not.toMatch(/secret|C:/);
  });
});

describe('GET /api/system/browser', () => {
  const ctx = (): RouteContext =>
    ({
      services: { browser: createBrowserCheck({ env: {}, launch: fake(['chromium']).launch }), vault: { values: () => [] } },
      studioEnv: {},
    }) as unknown as RouteContext;
  const signal = new AbortController().signal;

  it('is a loopback-only GET route that answers 200', async () => {
    const [route] = systemRoutes(ctx());
    expect(route?.path).toBe('/api/system/browser');
    expect(route?.remote).toBe('blocked');
    expect(Object.keys(route?.handlers ?? {})).toEqual(['GET']);
    const res = await route!.handlers.GET!({ method: 'GET', query: new URLSearchParams(), body: {}, signal });
    expect(res).toEqual({ status: 200, body: { available: true, browser: 'chromium' } });
  });

  it('rejects a query field with 400', async () => {
    const [route] = systemRoutes(ctx());
    const res = await route!.handlers.GET!({ method: 'GET', query: new URLSearchParams('x=1'), body: {}, signal });
    expect(res.status).toBe(400);
  });
});
