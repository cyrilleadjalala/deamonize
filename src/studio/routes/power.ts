/** Group G4: `/api/power/*`. Every route is blocked for a remote listener. */
import { PowerError } from '../contracts.js';
import type { RouteContext, RouteDef, RouteResponse } from './types.js';

async function guarded(run: () => Promise<unknown>): Promise<RouteResponse> {
  try {
    return { status: 200, body: await run() };
  } catch (error) {
    if (error instanceof PowerError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

export function powerRoutes(ctx: RouteContext): RouteDef[] {
  const power = ctx.services.power;
  return [
    {
      path: '/api/power/info',
      remote: 'blocked',
      handlers: { GET: () => guarded(() => power.info()) },
    },
    {
      path: '/api/power/snippet',
      remote: 'blocked',
      handlers: { GET: () => guarded(async () => ({ snippet: await power.snippet() })) },
    },
    {
      path: '/api/power/preview',
      remote: 'blocked',
      handlers: { POST: (req) => guarded(() => power.preview(req.body.workspacePath)) },
    },
    {
      path: '/api/power/install',
      remote: 'blocked',
      handlers: {
        POST: (req) => guarded(() => power.install({ confirmationId: req.body.confirmationId, kiroPath: req.body.kiroPath })),
      },
    },
  ];
}
