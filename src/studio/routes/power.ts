/** `/api/power/*`. Every route is blocked for a remote listener. Answers hold names, paths and counts, never a value. */
import { PowerError } from '../contracts.js';
import { POWER_SCOPE_INVALID, POWER_UNEXPECTED_FIELD } from '../messages/power.js';
import type { RouteContext, RouteDef, RouteRequest, RouteResponse } from './types.js';

async function guarded(run: () => Promise<unknown>): Promise<RouteResponse> {
  try {
    return { status: 200, body: await run() };
  } catch (error) {
    if (error instanceof PowerError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

const bad = (message: string): RouteResponse => ({ status: 400, body: { error: message } });
const unknownField = (body: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(body).some((k) => !allowed.includes(k));
const isScope = (v: unknown): boolean => v === 'global' || v === 'project';

export function powerRoutes(ctx: RouteContext): RouteDef[] {
  const power = ctx.services.power;
  /** Body check shared by the POST routes: no unknown field, and a valid scope when the route takes one. */
  const checked = (req: RouteRequest, allowed: readonly string[], needsScope: boolean): RouteResponse | undefined => {
    if (unknownField(req.body, allowed)) return bad(POWER_UNEXPECTED_FIELD);
    if (needsScope && !isScope(req.body.scope)) return bad(POWER_SCOPE_INVALID);
    return undefined;
  };
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
      handlers: {
        POST: async (req) =>
          checked(req, ['scope', 'workspacePath'], true) ??
          guarded(() => power.preview({ scope: req.body.scope, workspacePath: req.body.workspacePath })),
      },
    },
    {
      path: '/api/power/install',
      remote: 'blocked',
      handlers: {
        POST: async (req) => {
          const refused = checked(req, ['confirmationId', 'kiroPath', 'scope', 'autoAdd'], true);
          if (refused !== undefined) return refused;
          if (req.body.autoAdd !== undefined && typeof req.body.autoAdd !== 'boolean') return bad(POWER_UNEXPECTED_FIELD);
          return guarded(() =>
            power.install({
              confirmationId: req.body.confirmationId,
              kiroPath: req.body.kiroPath,
              scope: req.body.scope,
              ...(req.body.autoAdd === undefined ? {} : { autoAdd: req.body.autoAdd }),
            })
          );
        },
      },
    },
    {
      path: '/api/power/remove',
      remote: 'blocked',
      handlers: { POST: async (req) => checked(req, ['scope'], true) ?? guarded(() => power.remove({ scope: req.body.scope })) },
    },
    {
      path: '/api/power/auto-add',
      remote: 'blocked',
      handlers: {
        GET: () => guarded(() => power.getAutoAdd()),
        POST: async (req) => {
          if (unknownField(req.body, ['enabled']) || req.body.enabled !== false) return bad(POWER_UNEXPECTED_FIELD);
          return guarded(() => power.disableAutoAdd());
        },
      },
    },
  ];
}
