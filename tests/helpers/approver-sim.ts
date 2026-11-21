/**
 * Approver simulator: stands in for the Studio. It keeps the heartbeat fresh, watches a queue folder and writes the
 * decisions through the real queue API, with a test-chosen delay and decision.
 */
import {
  HEARTBEAT_EVERY_MS,
  listPending,
  openApprovalStore,
  removeHeartbeat,
  writeDecision,
  writeHeartbeat,
} from '../../src/replay/runtime/approval-queue.js';
import type { ApprovalDecisionValue, ApprovalRequestRecord, ApprovalStore } from '../../src/replay/runtime/approval-queue.js';

export interface ApproverSimOptions {
  /** The App_Data_Dir (the queue is `<dataDir>/approvals`). */
  dataDir: string;
  /** What to answer; `ignore` leaves the request pending. A function decides per request. */
  decision: ApprovalDecisionValue | 'ignore' | ((req: ApprovalRequestRecord) => ApprovalDecisionValue | 'ignore');
  /** Milliseconds between seeing a request and writing the decision. Default 0. */
  delayMs?: number;
  /** false = no heartbeat at all (nobody is there). Default true. */
  heartbeat?: boolean;
  /** Milliseconds between two scans. Default 20. */
  scanMs?: number;
}

export interface ApproverSim {
  store: ApprovalStore;
  /** Every request seen, in order. */
  seen: ApprovalRequestRecord[];
  stop(): Promise<void>;
}

export async function startApproverSim(options: ApproverSimOptions): Promise<ApproverSim> {
  const store = await openApprovalStore(options.dataDir);
  if (store === undefined) throw new Error('approver-sim: the approval folder is not usable');
  const seen: ApprovalRequestRecord[] = [];
  const handled = new Set<string>();
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  const withHeartbeat = options.heartbeat !== false;

  const beat = (): void => {
    if (withHeartbeat && !stopped) void writeHeartbeat(store).catch(() => undefined);
  };
  // The first heartbeat is on disk before the simulator is returned, so the next request finds an approver.
  if (withHeartbeat) await writeHeartbeat(store);
  const beatTimer = setInterval(beat, Math.min(HEARTBEAT_EVERY_MS, 500));

  const scan = async (): Promise<void> => {
    if (stopped) return;
    for (const req of await listPending(store)) {
      if (handled.has(req.id)) continue;
      handled.add(req.id);
      seen.push(req);
      const choice = typeof options.decision === 'function' ? options.decision(req) : options.decision;
      if (choice === 'ignore') continue;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!stopped) void writeDecision(store, req, choice, 'studio').catch(() => undefined);
      }, options.delayMs ?? 0);
      timers.add(timer);
    }
  };
  const scanTimer = setInterval(() => void scan().catch(() => undefined), options.scanMs ?? 20);

  return {
    store,
    seen,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(beatTimer);
      clearInterval(scanTimer);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      await removeHeartbeat(store);
    },
  };
}
