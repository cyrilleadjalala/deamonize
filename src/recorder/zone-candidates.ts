import type { ZoneFingerprint } from '../types.js';
import { buildSelectors, type ElementInfo } from './selector-builder.js';
import { isPositionalSelector } from './minimal-selector.js';

/** Facts about the marked element, computed in the page. */
export interface ZoneFacts {
  minimal?: string;
  positional?: string;
  shape?: { tag: string; tableRows?: number; listItems?: number };
}

export const CANDIDATE_LIMIT = 5;
export const STABLE_SLOTS = 4;
export const SELECTOR_LENGTH_LIMIT = 300;

/** Ordered and deduplicated, unverified. Role and name, test id, id, name attribute, role alone, minimal, positional. */
export function zoneCandidateSelectors(info: ElementInfo, facts: ZoneFacts): string[] {
  const list = buildSelectors({ role: info.role, name: info.name, id: info.id, testId: info.testId, nameAttr: info.nameAttr });
  if (info.role) list.push(`role=${info.role}`);
  if (facts.minimal) list.push(facts.minimal);
  if (facts.positional) list.push(facts.positional);
  return [...new Set(list)];
}

/** Remove a candidate that holds a known value, then keep at most 4 stable ones and one positional one, each within 300 characters. */
export function limitCandidates(verified: string[], knownValues: readonly string[]): string[] {
  const values = knownValues.filter((v) => v.length >= 3);
  const stable: string[] = [];
  let positional: string | undefined;
  for (const candidate of verified) {
    if (!candidate || candidate.length > SELECTOR_LENGTH_LIMIT) continue;
    if (values.some((v) => candidate.includes(v))) continue;
    if (stable.includes(candidate) || candidate === positional) continue;
    if (isPositionalSelector(candidate)) {
      if (positional === undefined) positional = candidate;
    } else if (stable.length < STABLE_SLOTS) {
      stable.push(candidate);
    }
  }
  return positional === undefined ? stable : [...stable, positional];
}

/** Every entry is positional (or there is none). */
export function isFragile(selectors: readonly string[]): boolean {
  return selectors.every((s) => isPositionalSelector(s));
}

export function zoneFingerprint(facts: ZoneFacts, kind: string): ZoneFingerprint | undefined {
  const shape = facts.shape;
  if (!shape) return undefined;
  const fingerprint: ZoneFingerprint = { tag: shape.tag.toLowerCase(), kind };
  const count = kind === 'table' ? shape.tableRows : kind === 'list' ? shape.listItems : undefined;
  if (count !== undefined && Number.isInteger(count) && count >= 1) fingerprint.count = count;
  return fingerprint;
}