/**
 * Firewall wrapper of a generated server: the approval gate, the audit entry and the trace of each tool call.
 * Host only. Standalone runtime module: imports only `node:*` and its siblings.
 *
 * G0 seam: types, constants and signatures are final; the function bodies belong to group G-B.
 */
import type { WriteStepMeta } from './approval-queue.js';

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

/** `env` default process.env. `decorate` is `withMode` of the generated server. */
export function createFirewall(_config: FirewallConfig, _decorate: (result: object) => object, _env?: NodeJS.ProcessEnv): Firewall {
  throw new Error('not implemented: G-B');
}

export const APPROVAL_MESSAGES: { approval_denied: string; approval_timeout: string; approval_unavailable: string } = {
  approval_denied: 'You said no, so nothing was changed.',
  approval_timeout: 'Nobody answered in time, so nothing was changed.',
  approval_unavailable: 'Daemonize could not ask you. Open the Daemonize sidebar in Kiro, then try again.',
};
