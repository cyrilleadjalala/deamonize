import { describe, expect, it } from 'vitest';
import { PowerError, type StudioServices } from '../../src/studio/contracts.js';
import { compileRoutes } from '../../src/studio/routes/compile.js';
import { powerRoutes } from '../../src/studio/routes/power.js';
import type { RouteContext, RouteDef, RouteRequest } from '../../src/studio/routes/types.js';

const req = (body: Record<string, unknown> = {}, method: 'GET' | 'POST' = 'POST'): RouteRequest => ({
  method,
  query: new URLSearchParams(),
  body,
  signal: new AbortController().signal,
});
const find = (routes: RouteDef[], path: string): RouteDef => routes.find((r) => r.path === path)!;

describe('compile routes', () => {
  const make = (accept: boolean) => {
    const services = {
      compiler: { tryStart: () => accept, status: () => ({ state: 'running', phase: 'installing' }) },
    } as unknown as StudioServices;
    return compileRoutes({ services } as RouteContext);
  };

  it('declares who may call them and which methods exist', () => {
    const routes = make(true);
    expect(find(routes, '/api/compile').remote).toBe('blocked');
    expect(Object.keys(find(routes, '/api/compile').handlers)).toEqual(['POST']);
    expect(find(routes, '/api/compile/status').remote).toBe('allowed');
    expect(Object.keys(find(routes, '/api/compile/status').handlers)).toEqual(['GET']);
  });

  it('answers 202, 409 and 400 for a body with fields', async () => {
    expect(await find(make(true), '/api/compile').handlers.POST!(req())).toEqual({ status: 202, body: { state: 'running' } });
    expect((await find(make(false), '/api/compile').handlers.POST!(req())).status).toBe(409);
    expect((await find(make(true), '/api/compile').handlers.POST!(req({ x: 1 }))).status).toBe(400);
  });

  it('returns the status', async () => {
    const res = await find(make(true), '/api/compile/status').handlers.GET!(req({}, 'GET'));
    expect(res).toEqual({ status: 200, body: { state: 'running', phase: 'installing' } });
  });
});

describe('power routes', () => {
  const power = {
    info: async () => ({ available: true, defaultWorkspace: '/w', outputPath: '/o' }),
    snippet: async () => {
      throw new PowerError(409, 'Compile first');
    },
    preview: async (r: { workspacePath?: unknown }) => {
      const p = r.workspacePath;
      if (typeof p !== 'string') throw new PowerError(400, 'Enter the workspace folder.');
      return { confirmationId: 'id', kiroPath: p };
    },
    install: async (r: { confirmationId: unknown; kiroPath: unknown }) => ({ written: [String(r.confirmationId)], placeholders: [] }),
  };
  const routes = powerRoutes({ services: { power } as unknown as StudioServices } as RouteContext);

  it('blocks every route for a remote listener', () => {
    expect(routes.map((r) => r.path)).toEqual([
      '/api/power/info', '/api/power/snippet', '/api/power/preview', '/api/power/install',
      '/api/power/remove', '/api/power/approval', '/api/power/auto-add',
    ]);
    expect(routes.map((r) => r.remote)).toEqual(Array(7).fill('blocked'));
    expect(routes.map((r) => Object.keys(r.handlers))).toEqual([['GET'], ['GET'], ['POST'], ['POST'], ['POST'], ['POST'], ['GET', 'POST']]);
  });

  it('maps results and PowerError to bodies', async () => {
    expect((await find(routes, '/api/power/info').handlers.GET!(req({}, 'GET'))).status).toBe(200);
    expect(await find(routes, '/api/power/snippet').handlers.GET!(req({}, 'GET'))).toEqual({ status: 409, body: { error: 'Compile first' } });
    expect(await find(routes, '/api/power/preview').handlers.POST!(req({ scope: 'project' }))).toEqual({ status: 400, body: { error: 'Enter the workspace folder.' } });
    expect((await find(routes, '/api/power/preview').handlers.POST!(req({ scope: 'project', workspacePath: '/x' }))).body).toEqual({ confirmationId: 'id', kiroPath: '/x' });
    expect((await find(routes, '/api/power/install').handlers.POST!(req({ confirmationId: 'a', kiroPath: 'b', scope: 'global' }))).body).toEqual({ written: ['a'], placeholders: [] });
  });
});
