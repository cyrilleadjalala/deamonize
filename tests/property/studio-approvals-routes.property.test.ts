// Feature: kiro-native-agent-and-firewall, Property 28: Decide accepts only a valid decision (Properties 29 and 30 follow below, each tagged)
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import type { AuditEntry } from '../../src/replay/runtime/audit-log.js';
import { auditEntry, routeCall } from '../helpers/firewall-arbitraries.js';

// The reader is replaced by a local fake of the design's behaviour (newest first); the real one belongs to group G-B
const store = vi.hoisted(() => ({ entries: [] as unknown[] }));
vi.mock('../../src/replay/runtime/audit-log.js', () => ({
  AUDIT_MAX_ENTRIES: 1000,
  readAuditEntries: async () => store.entries,
}));

import { activityRoutes } from '../../src/studio/routes/activity.js';
import { approvalsRoutes } from '../../src/studio/routes/approvals.js';
import { createActivityService } from '../../src/studio/activity-service.js';
import { AGENT_ALLOWED, agentMayCall } from '../../src/studio/agent-access.js';
import type { RouteContext, RouteRequest } from '../../src/studio/routes/types.js';

const RUNS = { numRuns: 100 };
const DECISIONS = ['auto', 'approved', 'denied', 'timeout', 'unavailable'] as const;
const req = (method: 'GET' | 'POST', query = '', body: Record<string, unknown> = {}): RouteRequest => ({ method, query: new URLSearchParams(query), body, signal: new AbortController().signal });

describe('Studio approval and activity routes', () => {
  // Feature: kiro-native-agent-and-firewall, Property 28: Decide accepts only a valid decision
  it('Property 28: Decide accepts only a valid decision', async () => {
    // **Validates: Requirements 12.8, 13.11**
    const hex32 = fc.stringMatching(/^[0-9a-f]{32}$/);
    const body = fc.oneof(
      fc.record({ id: hex32, decision: fc.constantFrom('approved', 'denied') }),
      fc.record({ id: hex32, decision: fc.string() }),
      fc.record({ id: fc.string(), decision: fc.constantFrom('approved', 'denied') }),
      fc.record({ id: hex32, decision: fc.constantFrom('approved', 'denied'), extra: fc.anything() }),
      fc.dictionary(fc.string({ maxLength: 8 }), fc.anything())
    );
    await fc.assert(
      fc.asyncProperty(body, async (b) => {
        const calls: Array<[string, string]> = [];
        const ctx = {
          services: {
            approvals: { decide: async (id: string, d: 'approved' | 'denied') => (calls.push([id, d]), { ok: true as const, decision: d }), list: async () => [] },
            vault: { values: () => [] },
          },
          studioEnv: {},
        } as unknown as RouteContext;
        const decide = approvalsRoutes(ctx).find((r) => r.path === '/api/approvals/decide')!.handlers.POST!;
        const out = await decide(req('POST', '', b as Record<string, unknown>));
        const keys = Object.keys(b);
        const valid =
          keys.length === 2 && typeof b.id === 'string' && /^[0-9a-f]{32}$/.test(b.id) && (b.decision === 'approved' || b.decision === 'denied');
        if (valid) {
          expect(out.status).toBe(200);
          expect(calls).toEqual([[b.id, b.decision]]);
        } else {
          expect(out.status).toBe(400);
          expect(calls).toEqual([]);
        }
      }),
      RUNS
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 29: Activity filters and errors
  it('Property 29: Activity filters and errors', async () => {
    // **Validates: Requirements 16.2, 16.3**
    const query = fc.record(
      {
        limit: fc.oneof(fc.integer({ min: -5, max: 300 }).map(String), fc.string({ maxLength: 4 })),
        tool: fc.oneof(fc.constantFrom('a_tool', 'b_tool', 'c_tool'), fc.constant('')),
        decision: fc.oneof(fc.constantFrom(...DECISIONS), fc.constantFrom('maybe', '')),
        other: fc.constant('1'),
      },
      { requiredKeys: [] }
    );
    await fc.assert(
      fc.asyncProperty(fc.array(auditEntry, { maxLength: 40 }), query, async (entries, q) => {
        const tools = ['a_tool', 'b_tool', 'c_tool'];
        const sorted = entries.map((e, i) => ({ ...e, tool: tools[i % 3] }) as AuditEntry);
        store.entries = sorted;
        const ctx = {
          services: { activity: createActivityService({ appData: { check: async () => ({ ok: true, dir: 'x' }) } as never }), vault: { values: () => [] } },
          studioEnv: {},
        } as unknown as RouteContext;
        const get = activityRoutes(ctx)[0].handlers.GET!;
        const params = new URLSearchParams(Object.entries(q) as Array<[string, string]>);
        const out = await get(req('GET', params.toString()));
        const limitOk = q.limit === undefined || (/^[0-9]{1,4}$/.test(q.limit) && Number(q.limit) >= 1 && Number(q.limit) <= 200);
        const toolOk = q.tool === undefined || q.tool !== '';
        const decisionOk = q.decision === undefined || (DECISIONS as readonly string[]).includes(q.decision);
        if (q.other !== undefined || !limitOk || !toolOk || !decisionOk) {
          expect(out.status).toBe(400);
          const expected = q.other !== undefined ? 'other' : !limitOk ? 'limit' : !toolOk ? 'tool' : 'decision';
          expect((out.body as { field: string }).field).toBe(expected);
          return;
        }
        expect(out.status).toBe(200);
        const body = out.body as { entries: AuditEntry[]; total: number };
        const limit = q.limit === undefined ? 50 : Number(q.limit);
        const matching = sorted.filter((e) => (q.tool === undefined || e.tool === q.tool) && (q.decision === undefined || e.decision === q.decision));
        expect(body.total).toBe(matching.length);
        expect(body.entries).toHaveLength(Math.min(limit, matching.length));
        expect(body.entries.map((e) => e.at)).toEqual(matching.slice(0, limit).map((e) => e.at));
        for (const e of body.entries) {
          if (q.tool !== undefined) expect(e.tool).toBe(q.tool);
          if (q.decision !== undefined) expect(e.decision).toBe(q.decision);
        }
      }),
      RUNS
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 30: The agent principal is confined
  it('Property 30: The agent principal is confined', () => {
    // **Validates: Requirements 6.1, 14.3**
    const owned = ['/api/approvals', '/api/approvals/decide', '/api/secrets/set', '/api/power/approval', '/api/power/remove', '/api/power/daemonize/install', '/api/sessions/forget', '/api/power/auto-add', '/api/pbt/run'];
    fc.assert(
      fc.property(
        routeCall,
        fc.constantFrom(...owned),
        fc.constantFrom<'GET' | 'POST'>('GET', 'POST'),
        (call, ownerPath, method) => {
          // Whatever the route, the agent may call it only when a rule lists exactly that method and path
          const listed = AGENT_ALLOWED.some((r) => r.method === call.method && (typeof r.path === 'string' ? r.path === call.path : r.path.test(call.path)));
          expect(agentMayCall(call.method, call.path)).toBe(listed);
          // The owner-only routes are never reachable, with either method and with a trailing slash or a query-like suffix
          expect(agentMayCall(method, ownerPath)).toBe(false);
          expect(agentMayCall(method, `${ownerPath}/`)).toBe(false);
          expect(agentMayCall(method, ownerPath.toUpperCase())).toBe(false);
        }
      ),
      RUNS
    );
  });
});
