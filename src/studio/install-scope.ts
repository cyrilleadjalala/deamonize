/** Pure helpers of "Save and add to Kiro": which scope to install into, and which credential names to report. */
import type { InstallScope } from './contracts.js';

/**
 * `project` stays `project`. `global` stays `global` when the Kiro home folder exists now, else becomes `project`.
 * Any other value gives today's default: `global` when the home folder exists, else `project`.
 */
export function resolveInstallScope(finishScope: unknown, kiroHomeExistsNow: boolean): InstallScope {
  if (finishScope === 'project') return 'project';
  return kiroHomeExistsNow ? 'global' : 'project';
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const MAX_SECRET_NAMES = 100;

/** Strings that match `^[A-Z][A-Z0-9_]*$`, unique, sorted by code point, at most 100. Anything else is left out. */
export function normalizeSecretNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && SECRET_NAME.test(entry)) names.add(entry);
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_SECRET_NAMES);
}
