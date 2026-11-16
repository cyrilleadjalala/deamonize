// @ts-check
/**
 * Daemonize Studio: a dependency-free single-page app. Hash routes, one module per view, no build step.
 */
import { h, clear } from './js/dom.js';
import { api, ApiError, isStatic } from './js/api.js';
import { startRouter } from './js/router.js';
import { announce, errorState, loadingState } from './js/components.js';
import { renderOverview } from './js/views/overview.js';
import { renderWorkflows } from './js/views/workflows.js';
import { renderGraph } from './js/views/graph.js';
import { renderSchemas } from './js/views/schemas.js';
import { renderTests } from './js/views/tests.js';
import { renderPlayground } from './js/views/playground.js';

const VIEWS = {
  overview: { title: 'Overview', render: renderOverview },
  workflows: { title: 'Workflows', render: renderWorkflows },
  graph: { title: 'Graph', render: renderGraph },
  schemas: { title: 'Schemas', render: renderSchemas },
  tests: { title: 'Tests', render: renderTests },
  playground: { title: 'Playground', render: renderPlayground },
};

const main = /** @type {HTMLElement} */ (document.getElementById('main'));
let renderToken = 0;

function markNav(name) {
  for (const a of document.querySelectorAll('#main-nav-list a')) {
    if (a.getAttribute('data-route') === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function showBanner() {
  const banner = document.getElementById('sample-banner');
  if (banner === null) return;
  try {
    const overview = await api.overview();
    if (isStatic) {
      clear(banner);
      banner.append(
        h('strong', { text: 'Simulated demo: no real application is driven. ' }),
        'Everything here is fictitious: a pretend CRM and a sqlite3 session, served as static files. Install Daemonize and run daemonize studio to see your own workflows.'
      );
      banner.hidden = false;
    } else if (overview.sample === true) {
      clear(banner);
      banner.append(
        h('strong', { text: 'Sample data. ' }),
        'Everything here is fictitious: a pretend CRM and a sqlite3 session. Run daemonize studio without --sample to see your own workflows.'
      );
      banner.hidden = false;
    }
  } catch {
    // The view itself reports the problem
  }
}

/** @param {import('./js/router.js').Route} route */
async function show(route) {
  const token = ++renderToken;
  const view = VIEWS[route.name];
  markNav(route.name);
  if (view === undefined) {
    document.title = 'Not found \u00B7 Daemonize Studio';
    clear(main).append(h('div', { class: 'view' }, h('h1', { class: 'view-title', tabindex: '-1', text: 'Page not found' }), h('p', null, 'There is no such page. ', h('a', { href: '#/', text: 'Back to the overview' }), '.')));
    focusHeading();
    return;
  }
  document.title = `${view.title} \u00B7 Daemonize Studio`;
  clear(main).append(loadingState(`Loading ${view.title.toLowerCase()}\u2026`));
  main.setAttribute('aria-busy', 'true');
  let content;
  try {
    content = await view.render(route);
  } catch (err) {
    content = errorState(err instanceof ApiError ? err.message : `The ${view.title.toLowerCase()} view could not be drawn.`, () => show(route));
    if (!(err instanceof ApiError)) console.warn(err);
  }
  if (token !== renderToken) return; // a newer navigation won
  clear(main).append(content);
  main.removeAttribute('aria-busy');
  focusHeading();
  announce(`${view.title} loaded`);
}

/** Move keyboard focus to the page heading so screen readers start at the top of the new view. */
function focusHeading() {
  const heading = /** @type {HTMLElement | null} */ (main.querySelector('[tabindex="-1"]'));
  heading?.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

document.getElementById('skip-link')?.addEventListener('click', (ev) => {
  ev.preventDefault();
  main.focus();
});
document.getElementById('print-btn')?.addEventListener('click', () => window.print());

showBanner();
startRouter(show);
