/** Group G3: `GET /api/sessions` and `POST /api/sessions/forget`. Only the Application_Key and a boolean go over the wire. */
import { SESSION_KEY_INVALID, SESSION_KEY_REQUIRED } from '../messages/record.js';
import { UNEXPECTED_FIELD } from '../messages/common.js';
import { applicationKey } from '../validate-action.js';
import type { RouteContext, RouteDef, RouteResponse } from './types.js';

const MAX_KEY = 300;

/** An exact origin: `new URL(key).origin === key`, http(s), at most 300 characters. */
export function exactOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > MAX_KEY || value.includes('\0')) return undefined;
  return applicationKey(value) === value ? value : undefined;
}

export function sessionRoutes(ctx: RouteContext): RouteDef[] {
  const { sessions } = ctx.services;

  const list = async (query: URLSearchParams): Promise<RouteResponse> => {
    await sessions.refresh().catch(() => undefined);
    if (query.has('key')) {
      const key = exactOrigin(query.get('key'));
      if (key === undefined) return { status: 400, body: { error: SESSION_KEY_INVALID, field: 'key' } };
      return { status: 200, body: { applicationKey: key, available: await sessions.available(key) } };
    }
    const keys = new Set<string>();
    try {
      const { set } = await ctx.loadSet();
      const key = set?.startUrl === undefined ? undefined : sessions.keyFor(set.startUrl);
      if (key !== undefined) keys.add(key);
    } catch {
      // An unreadable Workflow_File has no applications to list
    }
    const entries = await Promise.all([...keys].sort().map(async (applicationKey) => ({ applicationKey, available: await sessions.available(applicationKey) })));
    return { status: 200, body: { sessions: entries } };
  };

  const forget = async (body: Record<string, unknown>): Promise<RouteResponse> => {
    for (const name of Object.keys(body)) {
      if (name !== 'applicationKey') return { status: 400, body: { error: UNEXPECTED_FIELD, field: name } };
    }
    if (body.applicationKey === undefined) return { status: 400, body: { error: SESSION_KEY_REQUIRED, field: 'applicationKey' } };
    const key = exactOrigin(body.applicationKey);
    if (key === undefined) return { status: 400, body: { error: SESSION_KEY_INVALID, field: 'applicationKey' } };
    await sessions.forget(key);
    await sessions.refresh().catch(() => undefined);
    return { status: 200, body: { applicationKey: key, available: false } };
  };

  return [
    { path: '/api/sessions', remote: 'blocked', handlers: { GET: async (req) => list(req.query) } },
    { path: '/api/sessions/forget', remote: 'blocked', handlers: { POST: async (req) => forget(req.body) } },
  ];
}
