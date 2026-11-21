/**
 * Fictitious activity for the sample Studio, the static demo and the tests: audit entries, one pending approval and a
 * replay trace. Nothing here is real, and no value is a credential (a typed secret shows as `***`).
 */
import type { AuditEntry } from '../replay/runtime/audit-log.js';
import { NOT_REPEATED_NOTE, type TraceStep } from '../replay/runtime/trace.js';
import type { ApprovalView } from './contracts.js';

const APPLICATION = 'https://billing.example.com';

/** An `http` step, an `accessibility` step, a `skipped` step, a `drifted` step, a failed write step and one `not_run`. */
export function sampleTrace(): TraceStep[] {
  return [
    { index: 0, label: 'Open the sign-in page', level: 'http', durationMs: 120, status: 'ok' },
    { index: 1, label: 'Click Sign in', level: 'accessibility', durationMs: 640, status: 'ok' },
    { index: 2, label: 'Type the optional note', level: 'skipped', durationMs: 0, status: 'skipped' },
    { index: 3, label: 'Open the invoice list', level: 'accessibility', durationMs: 910, status: 'drifted', note: 'The page looks different from the recording' },
    { index: 4, label: 'Click Create invoice', level: 'accessibility', durationMs: 1500, status: 'failed', note: NOT_REPEATED_NOTE },
    { index: 5, label: 'Read the invoice number', level: 'not_run', durationMs: 0, status: 'not_run' },
  ];
}

/** One entry for each of the five decisions, one of them with `steps`. Newest first. */
export function sampleAuditEntries(): AuditEntry[] {
  const base = { v: 1 as const, application: APPLICATION, source: 'kiro' as const };
  return [
    {
      ...base,
      at: '2026-01-15T10:05:00.000Z',
      tool: 'create_invoice',
      risk: 'write',
      arguments: { customer: 'Ada Lovelace', amount: 120, password: '***' },
      decision: 'approved',
      outcome: 'success',
      durationMs: 4210,
      steps: sampleTrace().slice(0, 2),
    },
    {
      ...base,
      at: '2026-01-15T10:03:00.000Z',
      tool: 'delete_invoice',
      risk: 'delete',
      arguments: { invoice: 'INV-1002' },
      decision: 'denied',
      outcome: 'approval_denied',
      durationMs: 6000,
    },
    {
      ...base,
      at: '2026-01-15T10:01:00.000Z',
      tool: 'create_invoice',
      risk: 'write',
      arguments: { customer: 'Grace Hopper', amount: 80 },
      decision: 'timeout',
      outcome: 'approval_timeout',
      durationMs: 90000,
    },
    {
      ...base,
      at: '2026-01-15T09:58:00.000Z',
      tool: 'update_invoice',
      risk: 'write',
      arguments: { invoice: 'INV-1001', amount: 95 },
      decision: 'unavailable',
      outcome: 'approval_unavailable',
      durationMs: 12,
    },
    {
      ...base,
      at: '2026-01-15T09:55:00.000Z',
      tool: 'list_invoices',
      risk: 'read',
      arguments: { status: 'open' },
      decision: 'auto',
      outcome: 'success',
      durationMs: 1800,
    },
  ];
}

/** One pending request with 90 seconds left. */
export function sampleApprovals(now: number = Date.parse('2026-01-15T10:06:00.000Z')): ApprovalView[] {
  return [
    {
      id: '0123456789abcdef0123456789abcdef',
      tool: 'create_invoice',
      application: APPLICATION,
      risk: 'write',
      riskText: 'Changes data',
      source: 'kiro',
      kind: 'tool-call',
      arguments: { customer: 'Ada Lovelace', amount: 120, password: '***' },
      writeSteps: [{ index: 4, label: 'Click Create invoice', risk: 'write' }],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 90_000).toISOString(),
      secondsLeft: 90,
    },
  ];
}
