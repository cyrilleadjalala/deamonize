import { isLoopbackOrigin, isStudioToken } from './origin';
import type { StudioRoute, StudioTarget } from './ports';

export type { StudioRoute, StudioTarget };

const HASH: Record<StudioRoute, string> = { playground: '#/playground', credentials: '#/credentials', overview: '', workflows: '#/workflows' };
/** A tool name the Studio accepts in ?tool=. */
export const TARGET_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ID = 200;

/** The fragment of a valid target, or undefined (the target is then ignored). */
function targetHash(target: StudioTarget | undefined): string | undefined {
  if (target === undefined || target === null) return undefined;
  if (target.kind === 'tool') {
    return typeof target.name === 'string' && TARGET_NAME_RE.test(target.name) ? `#/playground?tool=${encodeURIComponent(target.name)}` : undefined;
  }
  if (target.kind === 'workflow') {
    if (typeof target.id !== 'string' || target.id.length === 0 || target.id.length > MAX_ID) return undefined;
    try { return `#/workflows/${encodeURIComponent(target.id)}`; } catch { return undefined; }
  }
  return undefined;
}

/** `<origin>/?token=<token>#/<route>`. A valid 	arget replaces the fragment. The Studio answers 302 to the same path without the token and sets its cookie. */
export function buildBrowserUrl(h: { origin: string; token: string }, route?: StudioRoute, target?: StudioTarget): string {
  if (!isLoopbackOrigin(h.origin)) throw new Error('invalid origin');
  if (!isStudioToken(h.token)) throw new Error('invalid token');
  const url = new URL('/', h.origin);
  url.searchParams.set('token', h.token);
  url.hash = targetHash(target) ?? (route === undefined ? '' : HASH[route] ?? '');
  return url.toString();
}
