import { describe, expect, it } from 'vitest';
import { InertRecordingManager } from '../../src/studio/inert-services.js';
import type { RecordingManager, RecordingStatus, StartInput, StudioServices } from '../../src/studio/contracts.js';
import { recordRoutes } from '../../src/studio/routes/record.js';
import { sessionRoutes } from '../../src/studio/routes/sessions.js';
import type { RouteContext, RouteDef, RouteMethod, RouteResponse } from '../../src/studio/routes/types.js';
import { MemorySessions } from '../helpers/fake-record.js';

class SpyManager extends InertRecordingManager implements RecordingManager {
  starts: StartInput[] = [];
  busy = false;
  running = true;
  override start(input: StartInput) {
    if (this.busy) return { status: 409 as const, message: 'busy' };
    this.starts.push(input);
    return { status: 202 as const };
  }
  override stop() {
    return this.running ? { status: 202 as const } : { status: 409 as const, message: 'none' };
  }
  override status(): RecordingStatus {
    return { state: 'recording', steps: 1, labels: ['Click Save'] };
  }
}

function setup(workflowUrl: string | null = 'https://shop.test/path') {
  const recording = new SpyManager();
  const sessions = new MemorySessions();
  const ctx = {
    services: { recording, sessions } as unknown as StudioServices,
    loadSet: async () => ({ set: workflowUrl === null ? undefined : { startUrl: workflowUrl }, outputs: {} }),
  } as unknown as RouteContext;
  const routes = [...recordRoutes(ctx), ...sessionRoutes(ctx)];
  const call = async (path: string, method: RouteMethod, body: Record<string, unknown> = {}, query = ''): Promise<RouteResponse> => {
    const route = routes.find((r: RouteDef) => r.path === path);
    const handler = route?.handlers[method];
    if (handler === undefined) throw new Error(`no ${method} ${path}`);
    return handler({ method, query: new URLSearchParams(query), body, signal: new AbortController().signal });
  };
  return { recording, sessions, routes, call };
}

describe('record routes', () => {
  it('declares remote-blocked routes with only the expected methods', () => {
    const { routes } = setup();
    expect(routes.map((r) => [r.path, Object.keys(r.handlers)])).toEqual([
      ['/api/record/start', ['POST']],
      ['/api/record/status', ['GET']],
      ['/api/record/stop', ['POST']],
      ['/api/sessions', ['GET']],
      ['/api/sessions/forget', ['POST']],
    ]);
    expect(routes.every((r) => r.remote === 'blocked')).toBe(true);
  });

  it('accepts a valid start with 202 and trims the inputs', async () => {
    const { call, recording } = setup();
    const res = await call('/api/record/start', 'POST', { name: '  Find order ', url: ' https://shop.test/x ', reuseSession: true });
    expect(res).toEqual({ status: 202, body: { state: 'recording' } });
    expect(recording.starts).toEqual([{ name: 'Find order', url: 'https://shop.test/x', reuseSession: true }]);
  });

  it.each([
    ['empty name', { name: '   ', url: 'https://a.test' }, 'name'],
    ['name with a newline', { name: 'a\nb', url: 'https://a.test' }, 'name'],
    ['non-http address', { name: 'ok', url: 'ftp://a.test' }, 'url'],
    ['address with credentials', { name: 'ok', url: 'https://user:pass@a.test' }, 'url'],
    ['address too long', { name: 'ok', url: `https://a.test/${'a'.repeat(2049)}` }, 'url'],
    ['extra field', { name: 'ok', url: 'https://a.test', extra: 1 }, 'extra'],
    ['non-boolean reuse', { name: 'ok', url: 'https://a.test', reuseSession: 'yes' }, 'reuseSession'],
  ])('rejects %s with 400, the field, and starts nothing', async (_label, body, field) => {
    const { call, recording } = setup();
    const res = await call('/api/record/start', 'POST', body);
    expect(res.status).toBe(400);
    expect((res.body as { field?: string }).field).toBe(field);
    expect(typeof (res.body as { error: string }).error).toBe('string');
    expect(recording.starts).toEqual([]);
  });

  it('answers 409 when busy', async () => {
    const { call, recording } = setup();
    recording.busy = true;
    const res = await call('/api/record/start', 'POST', { name: 'ok', url: 'https://a.test' });
    expect(res).toEqual({ status: 409, body: { error: 'busy' } });
  });

  it('returns the status as the manager reports it', async () => {
    const { call } = setup();
    expect(await call('/api/record/status', 'GET')).toEqual({ status: 200, body: { state: 'recording', steps: 1, labels: ['Click Save'] } });
  });

  it('stop takes an empty body only, and answers 202 or 409', async () => {
    const { call, recording } = setup();
    expect((await call('/api/record/stop', 'POST', { x: 1 })).status).toBe(400);
    expect(await call('/api/record/stop', 'POST')).toEqual({ status: 202, body: { state: 'saving' } });
    recording.running = false;
    expect((await call('/api/record/stop', 'POST')).status).toBe(409);
  });
});

describe('sessions routes', () => {
  it('lists the origin of the Workflow_File with a boolean only', async () => {
    const { call, sessions } = setup();
    sessions.files.set('https://shop.test', { cookies: [] });
    expect(await call('/api/sessions', 'GET')).toEqual({
      status: 200,
      body: { sessions: [{ applicationKey: 'https://shop.test', available: true }] },
    });
  });

  it('lists nothing without a Workflow_File', async () => {
    const { call } = setup(null);
    expect(await call('/api/sessions', 'GET')).toEqual({ status: 200, body: { sessions: [] } });
  });

  it('answers a single key and rejects a key that is not an exact origin', async () => {
    const { call } = setup();
    expect(await call('/api/sessions', 'GET', {}, 'key=https%3A%2F%2Fa.test')).toEqual({
      status: 200,
      body: { applicationKey: 'https://a.test', available: false },
    });
    for (const bad of ['https://a.test/path', '..', 'C:\\x', 'https://a.test%00', 'ftp://a.test', '']) {
      expect((await call('/api/sessions', 'GET', {}, `key=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
  });

  it('forgets a session, also when none existed, and rejects path forms without touching a file', async () => {
    const { call, sessions } = setup();
    sessions.files.set('https://a.test', { cookies: [] });
    expect(await call('/api/sessions/forget', 'POST', { applicationKey: 'https://a.test' })).toEqual({
      status: 200,
      body: { applicationKey: 'https://a.test', available: false },
    });
    expect(sessions.files.size).toBe(0);
    expect((await call('/api/sessions/forget', 'POST', { applicationKey: 'https://never.test' })).status).toBe(200);
    sessions.files.set('https://a.test', { cookies: [] });
    for (const bad of ['../x', '/etc/passwd', 'a\0b', 'https://a.test/..', 5, undefined]) {
      expect((await call('/api/sessions/forget', 'POST', { applicationKey: bad })).status).toBe(400);
    }
    expect((await call('/api/sessions/forget', 'POST', { applicationKey: 'https://a.test', other: 1 })).status).toBe(400);
    expect(sessions.files.size).toBe(1);
  });
});
