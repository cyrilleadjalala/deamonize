// @ts-check
/**
 * The seam for the feature screens of the first flow (`#/record`, `#/credentials`, ...).
 * `router.js` and `app.js` import this file once, so adding a screen means editing this file and the screen module only.
 *
 * - FEATURE_ROUTES: hash route names that `parseRoute` accepts, in addition to the built-in ones.
 * - FEATURE_VIEWS: route name -> `{ title, render }`, the same shape as the built-in `VIEWS` of `app.js`
 *   (`render(route)` returns an element or a promise of one).
 *
 * `router.js` reads FEATURE_ROUTES only when a route is parsed, never while loading, so a view module may import
 * `router.js` (for `href`) without a cycle problem.
 */

/** @type {string[]} */
export const FEATURE_ROUTES = [];

/** @type {Record<string, { title: string, render: (route: import('./router.js').Route) => HTMLElement | Promise<HTMLElement> }>} */
export const FEATURE_VIEWS = {};