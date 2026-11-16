// @ts-check
/** Hash routing without a framework: `#/workflows/<id>?x=y`. */

/**
 * @typedef {{ name: string, parts: string[], query: URLSearchParams, raw: string }} Route
 */

const KNOWN = ['overview', 'workflows', 'graph', 'schemas', 'tests', 'playground'];

/** @param {string} [hash] */
export function parseRoute(hash = window.location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const first = segments[0] ?? 'overview';
  return /** @type {Route} */ ({
    name: KNOWN.includes(first) ? first : 'not-found',
    parts: segments.slice(1),
    query: new URLSearchParams(queryPart),
    raw,
  });
}

/** Build a hash link: `href('workflows', id)`. */
export function href(name, id, query) {
  const base = name === 'overview' ? '#/' : `#/${name}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
  if (query === undefined) return base;
  const q = new URLSearchParams(query).toString();
  return q === '' ? base : `${base}?${q}`;
}

/** @param {(route: Route) => void} onRoute */
export function startRouter(onRoute) {
  const run = () => onRoute(parseRoute());
  window.addEventListener('hashchange', run);
  run();
}
