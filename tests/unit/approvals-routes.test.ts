import { describe, expect, it } from 'vitest';
import { approvalsRoutes } from '../../src/studio/routes/approvals.js';
import { activityRoutes, parseActivityQuery } from '../../src/studio/routes/activity.js';
import type { ActivityQuery, ApprovalsService, ApprovalView, DecideOutcome } from '../../src/studio/contracts.js';
import type { RouteContext, RouteDef, RouteRequest } from '../../src/studio/routes/types.js';
import { sampleApprovals, sampleAuditEntries } from '../../src/studio/sample-activity.js';

const FAKE_SECRET = ['Fake', 'Secret', 'Value-98765'].join('');

function makeCtx(over: { approvals?: Partial<ApprovalsService>; list?: (q: ActivityQuery) => Promise<unknown> } = {}): RouteContext {
  const approvals: ApprovalsService = {
    start: async () => undefined,
    list: async () => sampleApprovals(),
    decide: async (): Promise<DecideOutcome> => ({ ok: true, decision: 'approved' }),
    close: async () => undefined,
    ...over.approvals,
  };
  return {
    services: {
      approvals,
      activity: { list: over.list ?? (async () => ({ entries: sampleAuditEntries(), tools: ['create_invoice'], total: 5 })) },
      vault: { values: () => [FAKE_SECRET] },
    },
    studioEnv: {},
    sample: false,
  } as unknown as RouteContext;
}

const req = (method: 'GET' | 'POST', over: { query?: string; body?: Record<string, unknown> } = {}): RouteRequest => ({
  method,
  query: new URLSearchParams(over.query ?? ''),
  body: over.body ?? {},
  signal: new AbortController().signal,
});
const find = (routes: RouteDef[], path: string): RouteDef => routes.find((r) => r.path === path) as RouteDef;

describe('approvals routes', () => {
  const routes = approvalsRoutes(makeCtx());
  const decide = (body: Record<string, unknown>) => (find(routes, '/api/approvals/decide').handlers.POST as (r: RouteRequest) => Promise<{ status: number; body: any }>)(req('POST', { body }));

  it('are POST only for decide, GET only for the list, and blocked for a remote listener', () => {
    for (const r of routes) {
      expect(r.remote).toBe('blocked');
    }
    expect(Object.keys(find(routes, '/api/approvals').handlers)).toEqual(['GET']);
    expect(Object.keys(find(routes, '/api/approvals/decide').handlers)).toEqual(['POST']);
  });

  it('lists the pending questions with the server time', async () => {
    const out = await (find(routes, '/api/approvals').handlers.GET as (r: RouteRequest) => Promise<{ status: number; body: any }>)(req('GET'));
    expect(out.status).toBe(200);
    expect(out.body.pending).toHaveLength(1);
    expect(typeof out.body.serverTime).toBe('string');
  });

  it('decides with a valid id and decision', async () => {
    const out = await decide({ id: '0123456789abcdef0123456789abcdef', decision: 'denied' });
    expect(out).toEqual({ status: 200, body: { id: '0123456789abcdef0123456789abcdef', decision: 'approved' } });
  });

  it('answers 400 for another field, a bad id and another decision, naming the field', async () => {
    const id = '0123456789abcdef0123456789abcdef';
    expect(await decide({ id, decision: 'approved', extra: 1 })).toMatchObject({ status: 400, body: { field: 'extra' } });
    expect(await decide({ id: 'ABC', decision: 'approved' })).toMatchObject({ status: 400, body: { field: 'id' } });
    expect(await decide({ id: id.toUpperCase(), decision: 'approved' })).toMatchObject({ status: 400, body: { field: 'id' } });
    expect(await decide({ id, decision: 'timeout' })).toMatchObject({ status: 400, body: { field: 'decision' } });
    expect(await decide({ id })).toMatchObject({ status: 400, body: { field: 'decision' } });
  });

  it('answers 404 with the plain text for an ended question', async () => {
    const ended = approvalsRoutes(makeCtx({ approvals: { decide: async () => ({ ok: false, reason: 'ended' }) } }));
    const out = await (find(ended, '/api/approvals/decide').handlers.POST as (r: RouteRequest) => Promise<{ status: number; body: any }>)(
      req('POST', { body: { id: 'a'.repeat(32), decision: 'approved' } })
    );
    expect(out).toEqual({ status: 404, body: { error: 'This question has already ended.' } });
  });

  it('removes a known secret value from what it shows', async () => {
    const view = { ...(sampleApprovals()[0] as ApprovalView), arguments: { note: `x ${FAKE_SECRET} y` } };
    const r = approvalsRoutes(makeCtx({ approvals: { list: async () => [view] } }));
    const out = await (find(r, '/api/approvals').handlers.GET as (q: RouteRequest) => Promise<{ status: number; body: unknown }>)(req('GET'));
    expect(JSON.stringify(out.body)).not.toContain(FAKE_SECRET);
  });
});

describe('activity route', () => {
  const get = (query: string, list?: (q: ActivityQuery) => Promise<unknown>) =>
    (find(activityRoutes(makeCtx({ list })), '/api/activity').handlers.GET as (r: RouteRequest) => Promise<{ status: number; body: any }>)(req('GET', { query }));

  it('is GET only and blocked for a remote listener', () => {
    const [route] = activityRoutes(makeCtx());
    expect(route.remote).toBe('blocked');
    expect(Object.keys(route.handlers)).toEqual(['GET']);
  });

  it('defaults the limit to 50 and passes the filters', async () => {
    let seen: ActivityQuery | undefined;
    const out = await get('tool=create_invoice&decision=denied&limit=7', async (q) => {
      seen = q;
      return { entries: [], tools: [], total: 0 };
    });
    expect(out.status).toBe(200);
    expect(seen).toEqual({ limit: 7, tool: 'create_invoice', decision: 'denied' });
    await get('', async (q) => ((seen = q), { entries: [], tools: [], total: 0 }));
    expect(seen).toEqual({ limit: 50 });
  });

  it('answers 400 naming the field for a bad limit, decision, tool or query name', async () => {
    for (const [query, field] of [['limit=0', 'limit'], ['limit=201', 'limit'], ['limit=abc', 'limit'], ['limit=1&limit=2', 'limit'], ['decision=maybe', 'decision'], ['tool=', 'tool'], ['page=2', 'page']] as const) {
      const out = await get(query);
      expect(out.status, query).toBe(400);
      expect(out.body.field, query).toBe(field);
    }
    expect('status' in parseActivityQuery(new URLSearchParams('limit=200'))).toBe(false);
  });

  it('removes a known secret value from the answer', async () => {
    const out = await get('', async () => ({ entries: [{ outcome: `bad ${FAKE_SECRET}` }], tools: [], total: 1 }));
    expect(JSON.stringify(out.body)).not.toContain(FAKE_SECRET);
  });
});
