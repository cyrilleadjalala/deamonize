import type { ActivityApi } from './ports';
import type { ApprovalRow } from './types';

/** G0 seam: the signature is final; the body belongs to group G-E2. */
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

export function createApprovalWatcher(_deps: ApprovalWatcherDeps): ApprovalWatcher {
  throw new Error('not implemented: G-E2');
}
