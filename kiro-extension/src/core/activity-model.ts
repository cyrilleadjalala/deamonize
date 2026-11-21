import { S } from './strings';
import type { ActivityRow, ApprovalRow, TreeNode } from './types';

const MAX_RECENT = 5;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DECISION_LABEL: Record<ActivityRow['decision'], string> = {
  approved: S.decisionApproved,
  denied: S.decisionDenied,
  timeout: S.decisionTimeout,
  auto: S.decisionAuto,
  unavailable: S.decisionUnavailable,
};

/** A relative phrase. Never throws; a date that cannot be read counts as just now. */
export function relativeTime(at: string, now: number): string {
  const then = Date.parse(at);
  const diff = Number.isFinite(then) ? now - then : 0;
  if (diff < MINUTE) return S.timeJustNow;
  if (diff < HOUR) return S.timeMinutesAgo(String(Math.floor(diff / MINUTE)));
  if (diff < DAY) return S.timeHoursAgo(String(Math.floor(diff / HOUR)));
  return S.timeDaysAgo(String(Math.floor(diff / DAY)));
}

/** The text of a question: the tool, the application and the risk. Never an argument value. */
export function approvalMessage(row: ApprovalRow): string {
  const extra = [row.application, row.riskText].filter((t) => t !== '').join(' · ');
  return extra === '' ? S.approvalAsk(row.tool) : `${S.approvalAsk(row.tool)} ${extra}`;
}

/** Pending questions first, then the 5 newest entries. Facts only: no argument value reaches a node. */
export function activityNodes(input: { running: boolean; pending: ApprovalRow[]; recent: ActivityRow[]; now: number }): TreeNode[] {
  if (!input.running) return [{ id: 'info:activity-start', label: S.activityStart, icon: 'info' }];
  const nodes: TreeNode[] = input.pending.map((row): TreeNode => ({
    id: `approval:${row.id}`,
    label: row.tool,
    description: `${S.approvalWaiting} · ${S.approvalSecondsLeft(String(row.secondsLeft))}`,
    tooltip: approvalMessage(row),
    icon: 'warning',
    contextValue: 'approval',
  }));
  const newest = input.recent
    .map((row, index) => ({ row, index, time: Date.parse(row.at) }))
    .sort((a, b) => (Number.isFinite(b.time) ? b.time : -Infinity) - (Number.isFinite(a.time) ? a.time : -Infinity) || a.index - b.index)
    .slice(0, MAX_RECENT);
  if (newest.length === 0) {
    nodes.push({ id: 'info:activity-nothing', label: S.activityNothing, icon: 'info' });
    return nodes;
  }
  newest.forEach(({ row }, i) => {
    nodes.push({
      id: `activity:${i}:${row.at}`,
      label: row.tool,
      description: `${DECISION_LABEL[row.decision]} · ${row.success ? S.outcomeWorked : S.outcomeFailed} · ${relativeTime(row.at, input.now)}`,
      icon: row.success ? 'check' : 'warning',
    });
  });
  return nodes;
}
