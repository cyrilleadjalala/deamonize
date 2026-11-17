/**
 * Correlation rule for screen navigations (SPA): a click that changes the route does not take a mount read of the
 * new screen as its recipe. Pure (no Playwright, no I/O), so it can be unit tested.
 */
import type { RecipeCandidate } from './select-recipe.js';

export interface NavigationInfo {
  from: string;
  to: string;
}

/** origin + pathname, trailing slash removed; undefined when the URL cannot be parsed. Query and hash are ignored. */
export function routeKey(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.origin === 'null') return undefined;
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

/** A click that is not a submit, after which the route of the page differs from the route before it. */
export function isScreenNavigation(input: { actionType: string; submit: boolean; nav?: NavigationInfo }): boolean {
  if (input.actionType !== 'click' || input.submit || input.nav === undefined) return false;
  const from = routeKey(input.nav.from);
  const to = routeKey(input.nav.to);
  if (from === undefined || to === undefined) return false;
  return from !== to;
}

function isRead(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD';
}

/**
 * For a screen navigation with no variable carried, remove every read (GET or HEAD) attempt: whatever it binds, it is a
 * mount request of the new screen, not the action. Writes are kept. Anything else is returned unchanged (same array contents).
 */
export function dropNavigationReads<T extends RecipeCandidate & { request: { method: string; url: string } }>(
  attempts: readonly T[],
  input: { screenNavigation: boolean; used: readonly string[] },
): { kept: T[]; dropped: T[] } {
  if (!input.screenNavigation || input.used.length > 0) return { kept: [...attempts], dropped: [] };
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const attempt of attempts) {
    (isRead(attempt.request.method) ? dropped : kept).push(attempt);
  }
  return { kept, dropped };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

/** "screen navigation: GET /api/merchants/audience is a mount request of the new screen, not an action". */
export function navigationReason(dropped: ReadonlyArray<{ request: { method: string; url: string } }>): string {
  const first = dropped[0];
  if (first === undefined) return 'screen navigation';
  const label = (r: { request: { method: string; url: string } }): string =>
    `${r.request.method.toUpperCase()} ${pathOf(r.request.url)}`;
  if (dropped.length === 1) {
    return `screen navigation: ${label(first)} is a mount request of the new screen, not an action`;
  }
  return `screen navigation: ${dropped.map(label).join(', ')} are mount requests of the new screen, not an action`;
}
