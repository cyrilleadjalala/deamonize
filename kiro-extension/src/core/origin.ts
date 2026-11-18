/** Origin and token checks for the Studio handshake. Pure. */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True for `http://127.0.0.1:<port>`, `http://localhost:<port>` and `http://[::1]:<port>` (optional trailing slash only). */
export function isLoopbackOrigin(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  if (!/^\d+$/.test(url.port)) return false;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (url.pathname !== '/') return false;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
  return text === url.origin || text === `${url.origin}/`;
}

/** The token alphabet of the Studio (base64url), 16 to 128 characters. */
export function isStudioToken(text: unknown): boolean {
  return typeof text === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(text);
}
