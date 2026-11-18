import { isLoopbackOrigin, isStudioToken } from './origin';
import type { StudioRoute } from './ports';

export type { StudioRoute };

const HASH: Record<StudioRoute, string> = { playground: '#/playground', credentials: '#/credentials', overview: '' };

/** `<origin>/?token=<token>#/<route>`. The Studio answers 302 to the same path without the token and sets its cookie. */
export function buildBrowserUrl(h: { origin: string; token: string }, route?: StudioRoute): string {
  if (!isLoopbackOrigin(h.origin)) throw new Error('invalid origin');
  if (!isStudioToken(h.token)) throw new Error('invalid token');
  const url = new URL('/', h.origin);
  url.searchParams.set('token', h.token);
  url.hash = route === undefined ? '' : HASH[route] ?? '';
  return url.toString();
}
