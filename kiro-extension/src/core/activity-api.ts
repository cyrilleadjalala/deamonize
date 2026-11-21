import type { ActivityApi, StudioClient } from './ports';
import { S } from './strings';
import type { ActivityRow, ApiResult, ApprovalRow } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const DECISIONS: readonly string[] = ['auto', 'approved', 'denied', 'timeout', 'unavailable'];
const WRITE_RISKS: readonly string[] = ['write', 'delete'];

export function parseApprovals(body: unknown): ApprovalRow[] | undefined {
  if (!isObj(body) || !Array.isArray(body.pending)) return undefined;
  const rows: ApprovalRow[] = [];
  for (const item of body.pending) {
    if (!isObj(item) || typeof item.id !== 'string' || item.id === '' || typeof item.tool !== 'string') continue;
    const steps: ApprovalRow['writeSteps'] = [];
    if (Array.isArray(item.writeSteps)) {
      for (const s of item.writeSteps) {
        if (isObj(s) && typeof s.index === 'number' && typeof s.label === 'string' && typeof s.risk === 'string' && WRITE_RISKS.includes(s.risk)) {
          steps.push({ index: s.index, label: s.label, risk: s.risk as 'write' | 'delete' });
        }
      }
    }
    rows.push({
      id: item.id,
      tool: item.tool,
      application: typeof item.application === 'string' ? item.application : '',
      riskText: typeof item.riskText === 'string' ? item.riskText : '',
      ...(typeof item.summary === 'string' ? { summary: item.summary } : {}),
      arguments: item.arguments,
      writeSteps: steps,
      secondsLeft: typeof item.secondsLeft === 'number' && Number.isFinite(item.secondsLeft) ? Math.max(0, Math.floor(item.secondsLeft)) : 0,
      kind: typeof item.kind === 'string' ? item.kind : 'tool-call',
    });
  }
  return rows;
}

/** Keeps only what the Activity section shows. No argument, no outcome text. */
export function parseActivity(body: unknown): ActivityRow[] | undefined {
  if (!isObj(body) || !Array.isArray(body.entries)) return undefined;
  const rows: ActivityRow[] = [];
  for (const item of body.entries) {
    if (!isObj(item) || typeof item.at !== 'string' || typeof item.tool !== 'string' || typeof item.decision !== 'string' || !DECISIONS.includes(item.decision)) continue;
    rows.push({ at: item.at, tool: item.tool, decision: item.decision as ActivityRow['decision'], success: item.outcome === 'success' });
  }
  return rows;
}

/** Reads `GET /api/approvals` and `GET /api/activity` only; the two writes are the owner decisions of the Studio. */
export function createActivityApi(client: StudioClient): ActivityApi {
  const result = <T>(res: { status: number; body: unknown }, parse: (body: unknown) => T | undefined): ApiResult<T> => {
    if (res.status >= 200 && res.status < 300) {
      const data = parse(res.body);
      return data === undefined ? { ok: false, status: res.status, error: S.loadFailed } : { ok: true, status: res.status, data };
    }
    const error = isObj(res.body) && typeof res.body.error === 'string' && res.body.error !== '' ? res.body.error : S.loadFailed;
    const field = isObj(res.body) && typeof res.body.field === 'string' ? res.body.field : undefined;
    return { ok: false, status: res.status, error, ...(field === undefined ? {} : { field }) };
  };
  return {
    approvals: async () => result(await client.get('/api/approvals'), parseApprovals),
    decide: async (id, decision) =>
      result(await client.post('/api/approvals/decide', { id, decision }), (b) =>
        isObj(b) && typeof b.id === 'string' && typeof b.decision === 'string' ? { id: b.id, decision: b.decision } : undefined),
    activity: async (limit) => {
      const n = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 5;
      return result(await client.get(`/api/activity?limit=${n}`), parseActivity);
    },
    setAskBeforeChanges: async (scope, value) =>
      result(await client.post('/api/power/approval', { scope, askBeforeChanges: value }), (b) =>
        isObj(b) && (b.scope === 'global' || b.scope === 'project') && typeof b.askBeforeChanges === 'boolean'
          ? { scope: b.scope, askBeforeChanges: b.askBeforeChanges }
          : undefined),
  };
}
