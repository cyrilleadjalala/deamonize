/**
 * The approvals service of the Studio: heartbeat of `approver.json`, the list of pending questions and the decision.
 * The queue protocol itself (records, mac, first decision wins) lives in `replay/runtime/approval-queue.ts`.
 */
import {
  HEARTBEAT_EVERY_MS,
  listPending,
  openApprovalStore,
  removeHeartbeat,
  sweep,
  writeDecision,
  writeHeartbeat,
  type ApprovalRequestRecord,
  type ApprovalStore,
} from '../replay/runtime/approval-queue.js';
import type { AppData, ApprovalsService, ApprovalView, DecideOutcome } from './contracts.js';
import { RISK_TEXT } from './messages/approvals.js';

export interface ApprovalsServiceDeps {
  appData: AppData;
  now?: () => number;
}

/** The old files are removed about once a minute. */
const SWEEP_EVERY_MS = 60_000;

export function toApprovalView(record: ApprovalRequestRecord, now: number): ApprovalView {
  const created = Date.parse(record.createdAt);
  const expires = created + record.timeoutMs;
  return {
    id: record.id,
    tool: record.tool,
    application: record.application,
    risk: record.risk,
    riskText: RISK_TEXT[record.risk],
    source: record.source,
    kind: record.kind,
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    arguments: record.arguments,
    writeSteps: record.writeSteps.map((s) => ({ index: s.index, label: s.label, risk: s.risk })),
    createdAt: record.createdAt,
    expiresAt: new Date(expires).toISOString(),
    secondsLeft: Math.max(0, Math.ceil((expires - now) / 1000)),
  };
}

export function createApprovalsService(deps: ApprovalsServiceDeps): ApprovalsService {
  const clock = deps.now ?? Date.now;
  let store: ApprovalStore | undefined;
  let beat: NodeJS.Timeout | undefined;
  let sweeper: NodeJS.Timeout | undefined;
  let started = false;
  let closed = false;

  const stopTimers = (): void => {
    if (beat !== undefined) clearInterval(beat);
    if (sweeper !== undefined) clearInterval(sweeper);
    beat = undefined;
    sweeper = undefined;
  };

  return {
    async start(): Promise<void> {
      if (started || closed) return;
      started = true;
      try {
        const check = await deps.appData.ensure();
        if (!check.ok) return;
        const opened = await openApprovalStore(check.dir);
        if (opened === undefined) return;
        store = opened;
        await writeHeartbeat(opened, clock()).catch(() => undefined);
        beat = setInterval(() => void writeHeartbeat(opened, clock()).catch(() => undefined), HEARTBEAT_EVERY_MS);
        beat.unref();
        await sweep(opened, clock()).catch(() => undefined);
        sweeper = setInterval(() => void sweep(opened, clock()).catch(() => undefined), SWEEP_EVERY_MS);
        sweeper.unref();
      } catch {
        // Without a heartbeat the generated servers answer "unavailable" (fail closed)
        store = undefined;
        stopTimers();
      }
    },

    async list(): Promise<ApprovalView[]> {
      if (store === undefined) return [];
      try {
        const now = clock();
        const pending = await listPending(store, now);
        return pending.map((r) => toApprovalView(r, now)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      } catch {
        return [];
      }
    },

    async decide(id: string, decision: 'approved' | 'denied'): Promise<DecideOutcome> {
      if (store === undefined) return { ok: false, reason: 'ended' };
      try {
        const now = clock();
        const request = (await listPending(store, now)).find((r) => r.id === id);
        if (request === undefined) return { ok: false, reason: 'ended' };
        const written = await writeDecision(store, request, decision, 'studio', now);
        return written === 'written' ? { ok: true, decision } : { ok: false, reason: 'ended' };
      } catch {
        return { ok: false, reason: 'ended' };
      }
    },

    async close(): Promise<void> {
      closed = true;
      stopTimers();
      const current = store;
      store = undefined;
      if (current !== undefined) await removeHeartbeat(current).catch(() => undefined);
    },
  };
}
