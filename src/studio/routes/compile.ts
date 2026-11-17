/** Group G4: `POST /api/compile` and `GET /api/compile/status`. */
import { COMPILE_BODY_MUST_BE_EMPTY, COMPILE_BUSY } from '../messages/compile.js';
import type { RouteContext, RouteDef } from './types.js';

export function compileRoutes(ctx: RouteContext): RouteDef[] {
  return [
    {
      path: '/api/compile',
      remote: 'blocked',
      handlers: {
        POST: async (req) => {
          if (Object.keys(req.body).length > 0) return { status: 400, body: { error: COMPILE_BODY_MUST_BE_EMPTY } };
          if (!ctx.services.compiler.tryStart()) return { status: 409, body: { error: COMPILE_BUSY } };
          return { status: 202, body: { state: 'running' } };
        },
      },
    },
    {
      path: '/api/compile/status',
      remote: 'allowed',
      handlers: {
        GET: async () => ({ status: 200, body: ctx.services.compiler.status() }),
      },
    },
  ];
}
