/**
 * Firewall wrapper of a generated server: the approval gate, the audit entry and the trace of each tool call.
 * Host only. Standalone runtime module: imports only `node:*` and its siblings.
 *
 * Fail closed: a call that needs a question and gets anything but a valid `approved` runs no step.
 */
import { requestApproval, parseApprovalTimeout } from './approval-queue.js';
import type { WriteStepMeta } from './approval-queue.js';
import { appendAudit, collectSensitiveValues, redactArguments, scrubText, AUDIT_TEXT_MAX } from './audit-log.js';
import type { AuditDecision, AuditEntry } from './audit-log.js';
import { buildTrace, sanitizeTrace, traceScope } from './trace.js';
import type { TraceMarks, TraceStep } from './trace.js';
import { withResolvedSecrets } from './vault-reader.js';

export interface FirewallToolMeta {
  risk: 'read' | 'write' | 'delete';
  writeSteps: WriteStepMeta[];
  /** Variable names that hold a typed secret. */
  sensitiveArgs: string[];
  /** Names of the DAEMONIZE_SECRET_* variables the tool needs (the values are scrubbed from audit and trace). */
  secretVariables: string[];
  steps: Array<{ label?: string; actionType: string; risk?: 'read' | 'write' | 'delete' }>;
}
export interface FirewallConfig {
  application: string;
  targetType: 'web' | 'tui';
  tools: Record<string, FirewallToolMeta>;
}
export type ToolHandler = (
  args: Record<string, unknown>,
  extra?: { signal?: AbortSignal }
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
export interface Firewall {
  wrap(tool: string, handler: ToolHandler, validate: (payload: unknown) => unknown): ToolHandler;
}

export const APPROVAL_MESSAGES: { approval_denied: string; approval_timeout: string; approval_unavailable: string } = {
  approval_denied: 'You said no, so nothing was changed.',
  approval_timeout: 'Nobody answered in time, so nothing was changed.',
  approval_unavailable: 'Daemonize could not ask you. Open the Daemonize sidebar in Kiro, then try again.',
};

type ToolResult = Awaited<ReturnType<ToolHandler>>;
type RefusalCode = 'approval_denied' | 'approval_timeout' | 'approval_unavailable';

const SHORT_CODE = /^[A-Za-z0-9_.:-]{1,60}$/;
const FALLBACK_META: FirewallToolMeta = { risk: 'write', writeSteps: [], sensitiveArgs: [], secretVariables: [], steps: [] };

/** `env` default process.env. `decorate` is `withMode` of the generated server. */
export function createFirewall(config: FirewallConfig, decorate: (result: object) => object, env: NodeJS.ProcessEnv = process.env): Firewall {
  const wrap = (tool: string, handler: ToolHandler, validate: (payload: unknown) => unknown): ToolHandler => {
    return async (args, extra) => {
      const started = Date.now();
      // Read once per call.
      const askOn = env.DAEMONIZE_ASK_BEFORE_CHANGES === 'true';
      const source: 'kiro' | 'studio' = env.DAEMONIZE_CALL_SOURCE === 'studio' ? 'studio' : 'kiro';
      const traceOn = env.DAEMONIZE_TRACE === '1';
      const dataDir = typeof env.DAEMONIZE_DATA_DIR === 'string' && env.DAEMONIZE_DATA_DIR !== '' ? env.DAEMONIZE_DATA_DIR : undefined;
      const timeoutMs = parseApprovalTimeout(env.DAEMONIZE_APPROVAL_TIMEOUT_MS);
      const meta = config.tools[tool] ?? FALLBACK_META;
      const needsObservation = traceOn || dataDir !== undefined;

      const { _timeoutMs: _reserved, ...payload } = (args ?? {}) as Record<string, unknown>;
      void _reserved;

      let secrets: string[] | undefined;
      const secretValues = async (): Promise<string[]> => {
        if (secrets !== undefined) return secrets;
        let values: string[] = [];
        try {
          if (meta.secretVariables.length > 0) {
            const resolved = await withResolvedSecrets(env, meta.secretVariables);
            values = meta.secretVariables.map((name) => resolved[name]).filter((v): v is string => typeof v === 'string' && v.length >= 3);
          }
        } catch {
          values = [];
        }
        // The values typed into secret fields must not come back through an error text or a label either.
        values = [...values, ...collectSensitiveValues(payload, meta.sensitiveArgs)];
        secrets = values;
        return values;
      };

      let invalid = false;
      try {
        invalid = validate(payload) !== null;
      } catch {
        invalid = true;
      }

      let decision: AuditDecision = 'auto';
      let refusal: RefusalCode | undefined;
      let cancelled = false;
      const needsQuestion = !invalid && askOn && meta.risk !== 'read' && source === 'kiro';

      if (needsQuestion) {
        try {
          const redacted = redactArguments(payload, meta.sensitiveArgs, await secretValues());
          const outcome = await requestApproval({
            dataDir,
            source: 'kiro',
            kind: 'tool-call',
            tool,
            application: config.application,
            risk: meta.risk === 'delete' ? 'delete' : 'write',
            arguments: redacted,
            writeSteps: meta.writeSteps,
            timeoutMs,
            signal: extra?.signal,
          });
          if (outcome.decision === 'approved') decision = 'approved';
          else if (outcome.decision === 'timeout') {
            decision = 'timeout';
            refusal = 'approval_timeout';
          } else if (outcome.decision === 'unavailable') {
            decision = 'unavailable';
            refusal = 'approval_unavailable';
          } else {
            decision = 'denied';
            refusal = 'approval_denied';
            cancelled = outcome.decision === 'withdrawn';
          }
        } catch {
          decision = 'unavailable';
          refusal = 'approval_unavailable';
        }
      }

      let result: ToolResult;
      let marks: TraceMarks | undefined;
      let thrown: unknown;
      let didThrow = false;
      if (refusal !== undefined) {
        result = {
          content: [{ type: 'text', text: JSON.stringify(decorate({ success: false, error: refusal, message: APPROVAL_MESSAGES[refusal] })) }],
          isError: true,
        };
      } else if (needsObservation && !invalid) {
        try {
          const scoped = await traceScope(() => handler(args, extra));
          result = scoped.value;
          marks = scoped.marks;
        } catch (e) {
          didThrow = true;
          thrown = e;
          result = { content: [], isError: true };
        }
      } else {
        try {
          result = await handler(args, extra);
        } catch (e) {
          didThrow = true;
          thrown = e;
          result = { content: [], isError: true };
        }
      }

      // From here on nothing may change the answer of the call (except removing or adding `trace`).
      let answer = result;
      let steps: TraceStep[] | undefined;
      let truncated = false;
      let outcomeText = refusal !== undefined ? (cancelled ? 'cancelled' : refusal) : invalid ? 'validation' : result.isError === true ? 'error' : 'success';
      try {
        const first = result.content?.[0];
        const parsed: unknown = first !== undefined && first.type === 'text' ? safeParse(first.text) : undefined;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const body = parsed as Record<string, unknown>;
          const hadTrace = 'trace' in body || 'traceTruncated' in body;
          if (!invalid && refusal === undefined && dataDir !== undefined) outcomeText = outcomeOf(body, await secretValues(), outcomeText);
          if (needsObservation) {
            const own = sanitizeTrace(body.trace);
            if (own !== undefined && own.length > 0) {
              steps = own;
              truncated = body.traceTruncated === true;
            } else {
              const built = buildTrace({
                steps: meta.steps,
                marks: marks ?? { startedAt: started, marks: [] },
                result: body,
                targetType: config.targetType,
                refused: refusal !== undefined || invalid,
                secrets: await secretValues(),
              });
              steps = built.steps;
              truncated = built.truncated;
            }
          }
          if (hadTrace || traceOn) {
            const { trace: _t, traceTruncated: _tt, ...rest } = body;
            void _t;
            void _tt;
            const next: Record<string, unknown> = { ...rest };
            if (traceOn && steps !== undefined) {
              next.trace = steps;
              if (truncated) next.traceTruncated = true;
            }
            answer = { ...result, content: [{ ...first, text: JSON.stringify(next) }, ...result.content.slice(1)] };
          }
        }
      } catch {
        answer = result;
      }

      if (dataDir !== undefined) {
        try {
          const entry: AuditEntry = {
            v: 1,
            at: new Date(started).toISOString(),
            tool,
            application: config.application,
            risk: meta.risk,
            source,
            arguments: redactArguments(payload, meta.sensitiveArgs, await secretValues()),
            decision,
            outcome: scrubText(outcomeText, await secretValues(), AUDIT_TEXT_MAX),
            durationMs: Math.max(0, Date.now() - started),
          };
          if (steps !== undefined && steps.length > 0) {
            entry.steps = steps;
            if (truncated) entry.stepsTruncated = true;
          }
          await appendAudit(dataDir, entry);
        } catch {
          process.stderr.write('daemonize: an audit entry could not be written and was dropped\n');
        }
      }

      if (didThrow) throw thrown;
      return answer;
    };
  };
  return { wrap };
}

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const outcomeOf = (body: Record<string, unknown>, secrets: readonly string[], fallback: string): string => {
  if (body.success === true) return 'success';
  const error = body.error;
  if (typeof error === 'string') return SHORT_CODE.test(error) ? error : scrubText(error, secrets, AUDIT_TEXT_MAX);
  return body.success === false ? 'error' : fallback;
};
