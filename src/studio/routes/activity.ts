/** `GET /api/activity`: the Audit_Log, newest first, with the filters `tool` and `decision`. */
import { ACTIVITY_DECISION_INVALID, ACTIVITY_LIMIT_INVALID, ACTIVITY_TOOL_INVALID, ACTIVITY_UNEXPECTED_FIELD } from '../messages/activity.js';
import type { ActivityQuery } from '../contracts.js';
import { redactForStudio } from '../redact.js';
import type { RouteContext, RouteDef, RouteResponse } from './types.js';

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;
const DECISIONS = new Set(['auto', 'approved', 'denied', 'timeout', 'unavailable']);
const bad = (error: string, field: string): RouteResponse => ({ status: 400, body: { error, field } });

/** The query of a request, or the 400 answer that names the field. */
export function parseActivityQuery(query: URLSearchParams): ActivityQuery | RouteResponse {
  for (const name of new Set(query.keys())) {
    if (name !== 'limit' && name !== 'tool' && name !== 'decision') return bad(ACTIVITY_UNEXPECTED_FIELD, name);
  }
  const once = (name: string): string | undefined | null => {
    const all = query.getAll(name);
    return all.length === 0 ? undefined : all.length === 1 ? all[0] : null;
  };
  let limit = ACTIVITY_DEFAULT_LIMIT;
  const rawLimit = once('limit');
  if (rawLimit !== undefined) {
    if (rawLimit === null || !/^[0-9]{1,4}$/.test(rawLimit)) return bad(ACTIVITY_LIMIT_INVALID, 'limit');
    limit = Number(rawLimit);
    if (limit < 1 || limit > ACTIVITY_MAX_LIMIT) return bad(ACTIVITY_LIMIT_INVALID, 'limit');
  }
  const out: ActivityQuery = { limit };
  const tool = once('tool');
  if (tool !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (tool === null || tool.length < 1 || tool.length > 200 || /[\u0000-\u001f\u007f]/.test(tool)) return bad(ACTIVITY_TOOL_INVALID, 'tool');
    out.tool = tool;
  }
  const decision = once('decision');
  if (decision !== undefined) {
    if (decision === null || !DECISIONS.has(decision)) return bad(ACTIVITY_DECISION_INVALID, 'decision');
    out.decision = decision as ActivityQuery['decision'];
  }
  return out;
}

export function activityRoutes(ctx: RouteContext): RouteDef[] {
  const { activity, vault } = ctx.services;
  return [
    {
      path: '/api/activity',
      remote: 'blocked',
      handlers: {
        GET: async (req) => {
          const parsed = parseActivityQuery(req.query);
          if ('status' in parsed) return parsed;
          const answer = await activity.list(parsed);
          return { status: 200, body: redactForStudio(answer, { env: ctx.studioEnv, secretValues: vault.values() }) };
        },
      },
    },
  ];
}
