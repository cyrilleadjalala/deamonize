import type { RecordingPoller } from './ports';
import type { ApiResult, RecordingStatus } from './types';

export type { RecordingPoller };

export interface PollerDeps {
  fetchStatus(): Promise<ApiResult<RecordingStatus>>;
  onStatus(s: RecordingStatus): void;
  /** State done, error or idle. */
  onFinished(s: RecordingStatus): void;
  /** Three failed fetches in a row. */
  onGaveUp(): void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  /** Default 1000. */
  intervalMs?: number;
}

const ACTIVE = new Set(['recording', 'saving', 'compiling']);
const MAX_FAILURES = 3;

/** One polling loop with an in-flight guard. `start()` while running does nothing. */
export function createRecordingPoller(deps: PollerDeps): RecordingPoller {
  let running = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const interval = deps.intervalMs ?? 1000;

  const schedule = (gen: number): void => {
    timer = deps.setTimeout(() => {
      timer = undefined;
      void tick(gen);
    }, interval);
  };

  const tick = async (gen: number): Promise<void> => {
    let result: ApiResult<RecordingStatus> | undefined;
    try {
      result = await deps.fetchStatus();
    } catch {
      result = undefined;
    }
    if (gen !== generation || !running) return;
    if (result === undefined || !result.ok) {
      failures += 1;
      if (failures >= MAX_FAILURES) {
        running = false;
        deps.onGaveUp();
        return;
      }
      schedule(gen);
      return;
    }
    failures = 0;
    deps.onStatus(result.data);
    if (!ACTIVE.has(result.data.state)) {
      running = false;
      deps.onFinished(result.data);
      return;
    }
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
    },
    get running() {
      return running;
    },
  };
}
