/** `GET /api/approvals` and `POST /api/approvals/decide`. Owner only (the agent principal is refused before the handler). */
import {
  APPROVAL_DECISION_INVALID,
  APPROVAL_ENDED,
  APPROVAL_ID_INVALID,
  APPROVAL_UNEXPECTED_FIELD,
} from '../messages/approvals.js';
import { redactForStudio } from '../redact.js';
import type { RouteContext, RouteDef, RouteResponse } from './types.js';

const ID = /^[0-9a-f]{32}$/;

export function approvalsRoutes(ctx: RouteContext): RouteDef[] {
  const { approvals, vault } = ctx.services;
  const redact = <T>(value: T): T => redactForStudio(value, { env: ctx.studioEnv, secretValues: vault.values() });

  const list = async (): Promise<RouteResponse> => {
    const pending = await approvals.list();
    return { status: 200, body: redact({ pending, serverTime: new Date().toISOString() }) };
  };

  const decide = async (body: Record<string, unknown>): Promise<RouteResponse> => {
    for (const name of Object.keys(body)) {
      if (name !== 'id' && name !== 'decision') return { status: 400, body: { error: APPROVAL_UNEXPECTED_FIELD, field: name } };
    }
    if (typeof body.id !== 'string' || !ID.test(body.id)) return { status: 400, body: { error: APPROVAL_ID_INVALID, field: 'id' } };
    if (body.decision !== 'approved' && body.decision !== 'denied') return { status: 400, body: { error: APPROVAL_DECISION_INVALID, field: 'decision' } };
    const outcome = await approvals.decide(body.id, body.decision);
    if (!outcome.ok) {
      return outcome.reason === 'invalid'
        ? { status: 400, body: { error: APPROVAL_ID_INVALID, field: 'id' } }
        : { status: 404, body: { error: APPROVAL_ENDED } };
    }
    return { status: 200, body: { id: body.id, decision: outcome.decision } };
  };

  return [
    { path: '/api/approvals', remote: 'blocked', handlers: { GET: async () => list() } },
    { path: '/api/approvals/decide', remote: 'blocked', writes: true, handlers: { POST: async (req) => decide(req.body) } },
  ];
}
