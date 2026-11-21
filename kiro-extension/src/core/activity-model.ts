import type { ActivityRow, ApprovalRow, TreeNode } from './types';

/** G0 seam: the signature is final; the body belongs to group G-E2. Pending questions first, then the 5 newest entries. */
export function activityNodes(_input: { running: boolean; pending: ApprovalRow[]; recent: ActivityRow[]; now: number }): TreeNode[] {
  throw new Error('not implemented: G-E2');
}
