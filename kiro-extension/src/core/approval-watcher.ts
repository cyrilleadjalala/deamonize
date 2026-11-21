import type { ActivityApi } from './ports';
import type { ApprovalRow } from './types';

export interface ApprovalWatcherDeps {
  api: () => ActivityApi | undefined;
  notify(row: ApprovalRow): void;
  clear(id: string): void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  /** Default 2000. */
  everyMs?: number;
}
export interface ApprovalWatcher {
  start(): void;
  stop(): void;
  readonly pending: ApprovalRow[];
}

const DEFAULT_EVERY_MS = 2000;
/** After failed polls the wait doubles, up to this many times the normal interval. */
const MAX_BACKOFF_FACTOR = 5;

/** Polls the questions every 2 s. A new id is announced once; an id that left the list is cleared. One poll in flight at a time. */
export function createApprovalWatcher(deps: ApprovalWatcherDeps): ApprovalWatcher {
  const every = deps.everyMs ?? DEFAULT_EVERY_MS;
  let running = false;
  let generation = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ApprovalRow[] = [];
  const known = new Set<string>();

  const schedule = (gen: number): void => {
    const wait = Math.min(every * 2 ** failures, every * MAX_BACKOFF_FACTOR);
    timer = deps.setTimeout(() => {
      timer = undefined;
      void tick(gen);
    }, wait);
  };

  const apply = (rows: ApprovalRow[]): void => {
    const ids = new Set(rows.map((r) => r.id));
    for (const id of [...known]) {
      if (!ids.has(id)) {
        known.delete(id);
        deps.clear(id);
      }
    }
    for (const row of rows) {
      if (!known.has(row.id)) {
        known.add(row.id);
        deps.notify(row);
      }
    }
    pending = rows;
  };

  const tick = async (gen: number): Promise<void> => {
    if (!running || gen !== generation) return;
    let ok = false;
    try {
      const api = deps.api();
      if (api === undefined) {
        apply([]);
        ok = true;
      } else {
        const result = await api.approvals();
        if (gen !== generation) return;
        if (result.ok) {
          apply(result.data);
          ok = true;
        }
      }
    } catch {
      ok = false;
    }
    if (!running || gen !== generation) return;
    failures = ok ? 0 : failures + 1;
    schedule(gen);
  };

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      generation += 1;
      void tick(generation);
    },
    stop() {
      running = false;
      generation += 1;
      if (timer !== undefined) deps.clearTimeout(timer);
      timer = undefined;
      for (const id of [...known]) deps.clear(id);
      known.clear();
      pending = [];
    },
    get pending() {
      return pending;
    },
  };
}
