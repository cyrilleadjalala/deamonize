/**
 * Markers of the lines that the firewall change adds to the generated `mcp-server.ts` and `replay.ts`.
 * Every added line ends with `FW_MARK`, so the regression test can remove exactly those lines and compare the rest
 * of an old snapshot byte for byte. Lines are only added, never edited.
 */
import type { FirewallConfig } from '../replay/runtime/firewall.js';

export const FW_MARK = '//#fw';

/** The table embedded in the generated `mcp-server.ts` (the `FIREWALL` constant). */
export type FirewallMeta = FirewallConfig;

/** True for a generated line added by this change. */
export const isMarkedLine = (line: string): boolean => line.trimEnd().endsWith(FW_MARK);

/**
 * The patterns of the marked lines, one per named difference of the regression table. A line that ends with
 * `FW_MARK` and matches the pattern of its entry is removed by that entry only.
 */
export const FW_LINE_PATTERNS = {
  /** mcp-server.ts */
  firewallImport: /^import \{[^}]*\bcreateFirewall\b[^}]*\} from ["']\.\/firewall\.js["'];/,
  firewallTable: /^const FIREWALL =/,
  firewallObject: /^const firewall =/,
  approvalGate: /^async function approvalGate\b/,
  registerTool: /^const registerTool =/,
  toolWrapper: /^\(server as any\)\.tool =/,
  /** replay.ts */
  traceImport: /^import \{[^}]*\} from ["']\.\/trace\.js["'];/,
  traceStep: /^\s*traceStep\(index\);/,
  enterTraceScope: /^\s*enterTraceScope\(\);/,
  traceResult: /^\s*Object\.assign\(result, \{ trace:/,
} as const;

/** Appends the marker to a line of generated code. */
export const marked = (line: string): string => `${line} ${FW_MARK}`;
