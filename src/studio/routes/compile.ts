/** Group G4: `POST /api/compile` and `GET /api/compile/status`. Group G-I: the body carries the optional compile options. */
import { UNEXPECTED_FIELD } from '../messages/common.js';
import { COMPILE_BUSY, COMPILE_HEAL_INVALID, COMPILE_HTTP_INVALID } from '../messages/compile.js';
import type { CompileOptionsInput } from '../contracts.js';
import type { RouteContext, RouteDef, RouteResponse } from './types.js';

const FIELDS = new Set(['http', 'healSupport']);

/** Validates the body: the options to use, or the 400 answer. Nothing is stored here. */
function parseBody(body: Record<string, unknown>): CompileOptionsInput | RouteResponse {
  for (const field of Object.keys(body)) {
    if (!FIELDS.has(field)) return { status: 400, body: { error: UNEXPECTED_FIELD, code: 'UNEXPECTED_FIELD', field } };
  }
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k);
  if (has('http') && body.http !== 'off' && body.http !== 'auto') {
    return { status: 400, body: { error: COMPILE_HTTP_INVALID, field: 'http' } };
  }
  if (has('healSupport') && typeof body.healSupport !== 'boolean') {
    return { status: 400, body: { error: COMPILE_HEAL_INVALID, field: 'healSupport' } };
  }
  return {
    http: has('http') ? (body.http as 'off' | 'auto') : 'off',
    healSupport: has('healSupport') ? (body.healSupport as boolean) : false,
  };
}

export function compileRoutes(ctx: RouteContext): RouteDef[] {
  return [
    {
      path: '/api/compile',
      remote: 'blocked',
      handlers: {
        POST: async (req) => {
          const parsed = parseBody(req.body);
          if ('status' in parsed) return parsed;
          if (!ctx.services.compiler.tryStart(parsed)) return { status: 409, body: { error: COMPILE_BUSY, code: 'COMPILE_BUSY' } };
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
