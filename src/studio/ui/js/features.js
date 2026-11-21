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
import { renderRecordStatus } from './views/record-status.js';
import { renderCredentials } from './views/credentials.js';
import { renderActivity } from './views/activity.js';
import { COPY } from './copy.js';
import { COPY_ACTIVITY } from './copy-activity.js';

/** @type {string[]} */
export const FEATURE_ROUTES = ['record', 'credentials', 'activity'];

/** @type {Record<string, { title: string, render: (route: import('./router.js').Route) => HTMLElement | Promise<HTMLElement> }>} */
export const FEATURE_VIEWS = {
  record: { title: COPY.recordTitle, render: renderRecordStatus },
  credentials: { title: COPY.credentialsTitle, render: renderCredentials },
  activity: { title: COPY_ACTIVITY.title, render: renderActivity },
};
/** The scope choice, auto-add and removal of the connect screen are hidden in the static demo and in sample mode. @param {any} overview */
export const connectFeaturesVisible = (overview) => overview?.sample !== true && globalThis.document?.querySelector('meta[name="daemonize-mode"]')?.getAttribute('content') !== 'static';
