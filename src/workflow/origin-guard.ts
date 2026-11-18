import type { WorkflowSet } from '../types.js';

export type OriginCheck = { ok: true } | { ok: false; heldOrigin: string; message: string };

function parseOrigin(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Plain text, no file path. */
export function foreignOriginMessage(heldOrigin: string): string {
  return `This folder already holds actions for ${heldOrigin}. Another application needs another folder.`;
}

/** Names both Origins, no file path. */
export function saveOriginMessage(heldOrigin: string, newOrigin: string): string {
  return `This file already holds actions for ${heldOrigin}, and the new recording is for ${newOrigin}. Another application needs another file.`;
}

/**
 * Refuses only when the file holds at least one workflow, it is a web target whose startUrl parses,
 * `url` parses, and the two origins differ. A default port equals the same address without a port.
 */
export function checkSameOrigin(
  existing: Pick<WorkflowSet, 'startUrl' | 'targetType' | 'workflows'> | undefined,
  url: string,
): OriginCheck {
  if (existing === undefined || existing.targetType !== 'web') return { ok: true };
  if ((existing.workflows ?? []).length === 0) return { ok: true };
  const held = parseOrigin(existing.startUrl);
  const wanted = parseOrigin(url);
  if (held === undefined || wanted === undefined || held === wanted) return { ok: true };
  return { ok: false, heldOrigin: held, message: foreignOriginMessage(held) };
}
