/**
 * `/api/power/daemonize/*`: info, preview, install and remove of the Daemonize Power. Every route is blocked for a
 * remote listener, owner only (none is in AGENT_ALLOWED), and the writes answer 409 in sample mode (RouteDef default).
 * Answers hold names, relative paths and counts, never a value or a token.
 */
import { PowerError } from '../contracts.js';
import { DP_ALREADY_INSTALLED, DP_CONFLICT_KEPT, DP_PLAN_NOTE, DP_RELOAD_HINT, DP_REPLACE_INVALID } from '../messages/daemonize-power.js';
import { POWER_SCOPE_INVALID, POWER_UNEXPECTED_FIELD } from '../messages/power.js';
import type { RouteContext, RouteDef, RouteRequest, RouteResponse } from './types.js';

async function guarded(run: () => Promise<Record<string, unknown>>): Promise<RouteResponse> {
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

export function daemonizePowerRoutes(ctx: RouteContext): RouteDef[] {
  const installer = ctx.services.daemonizePower;
  const checked = (req: RouteRequest, allowed: readonly string[]): RouteResponse | undefined => {
    if (unknownField(req.body, allowed)) return bad(POWER_UNEXPECTED_FIELD);
    if (!isScope(req.body.scope)) return bad(POWER_SCOPE_INVALID);
    return undefined;
  };
  return [
    {
      path: '/api/power/daemonize/info',
      remote: 'blocked',
      handlers: { GET: () => guarded(async () => ({ ...(await installer.info()) })) },
    },
    {
      path: '/api/power/daemonize/preview',
      remote: 'blocked',
      handlers: {
        POST: async (req) =>
          checked(req, ['scope', 'parts', 'workspacePath']) ??
          guarded(async () => ({
            ...(await installer.preview({ scope: req.body.scope, parts: req.body.parts, workspacePath: req.body.workspacePath })),
            message: DP_PLAN_NOTE,
          })),
      },
    },
    {
      path: '/api/power/daemonize/install',
      remote: 'blocked',
      handlers: {
        POST: async (req) => {
          const refused = checked(req, ['confirmationId', 'kiroPath', 'scope', 'replace']);
          if (refused !== undefined) return refused;
          if (req.body.replace !== undefined && !(Array.isArray(req.body.replace) && req.body.replace.every((r) => typeof r === 'string'))) {
            return bad(DP_REPLACE_INVALID);
          }
          return guarded(async () => {
            const result = await installer.install({
              confirmationId: req.body.confirmationId,
              kiroPath: req.body.kiroPath,
              scope: req.body.scope,
              ...(req.body.replace === undefined ? {} : { replace: req.body.replace }),
            });
            const message = result.alreadyInstalled
              ? DP_ALREADY_INSTALLED
              : result.skipped.length > 0
                ? `${DP_CONFLICT_KEPT} ${DP_RELOAD_HINT}`
                : DP_RELOAD_HINT;
            return { ...result, message };
          });
        },
      },
    },
    {
      path: '/api/power/daemonize/remove',
      remote: 'blocked',
      handlers: {
        POST: async (req) => checked(req, ['scope', 'parts']) ?? guarded(async () => ({ ...(await installer.remove({ scope: req.body.scope, parts: req.body.parts })) })),
      },
    },
  ];
}
