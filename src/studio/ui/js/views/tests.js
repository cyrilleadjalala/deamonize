// @ts-check
import { h } from '../dom.js';
import { api, ApiError } from '../api.js';
import { announce, chip, emptyState, pill } from '../components.js';

/** @param {any} view */
function toolRows(view) {
  const ran = new Map((view.result?.tools ?? []).map((t) => [t.tool, t]));
  const extra = (view.generatedTools ?? []).filter((n) => !ran.has(n)).map((n) => ({ tool: n, notRun: true, passing: 0, failing: 0, skipped: 0, counterexamples: [] }));
  return [...ran.values(), ...extra].sort((a, b) => a.tool.localeCompare(b.tool));
}

/** @param {any} t */
function statusOf(t) {
  if (t.notRun) return 'notrun';
  if (t.failing > 0 || t.error) return 'fail';
  return t.passing > 0 ? 'pass' : 'notrun';
}

const STATUS_LABEL = { pass: 'Passing', fail: 'Failing', notrun: 'Not run' };

/** @param {any} t */
function toolCard(t) {
  const status = statusOf(t);
  const id = `pbt-${t.tool.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return h('article', { class: `card pbt-card ${status}`, dataset: { tool: t.tool, status }, 'aria-labelledby': id },
    h('header', { class: 'card-head' },
      h('h3', { class: 'card-title', id }, h('code', { text: t.tool })),
      pill(status, STATUS_LABEL[status])),
    h('p', { class: 'counts' },
      chip(`${t.passing} passing`, 'pass'), ' ', chip(`${t.failing} failing`, t.failing > 0 ? 'fail' : 'plain'), ' ', t.skipped ? chip(`${t.skipped} skipped`, 'plain') : null),
    t.error ? h('p', { class: 'error-text', role: 'note', text: t.error }) : null,
    ...t.counterexamples.map((c) =>
      h('details', { class: 'counterexample', open: true },
        h('summary', null, 'Shrunk counterexample: ', h('span', { text: c.property })),
        c.counterexample ? h('pre', { class: 'code-block', tabindex: '0' }, h('code', { text: c.counterexample })) : h('p', { class: 'muted', text: 'The runner gave no counterexample.' }))));
}

/** @param {any} view @param {boolean} sample */
function summary(view, sample) {
  const r = view.result;
  if (r === undefined) {
    return h('p', { class: 'muted', text: view.generatedTools?.length ? 'The suite is generated but has not run yet.' : 'No generated tests found. Run daemonize compile to generate them.' });
  }
  const when = r.ranAt ? new Date(r.ranAt).toLocaleString() : 'unknown time';
  return h('div', { class: 'pbt-summary' },
    pill(r.status === 'passed' ? 'pass' : r.status === 'failed' ? 'fail' : 'notrun', r.status === 'passed' ? 'All properties hold' : r.status === 'failed' ? 'A property failed' : 'The suite did not run'),
    h('span', { class: 'muted', text: ` ${r.totals.passing} passing \u00B7 ${r.totals.failing} failing \u00B7 ${r.totals.skipped} skipped \u00B7 ${(r.durationMs / 1000).toFixed(1)} s \u00B7 ${sample ? 'sample result' : when}` }),
    r.error ? h('p', { class: 'error-text', role: 'note', text: r.error }) : null);
}

/** @returns {Promise<HTMLElement>} */
export async function renderTests() {
  const [initial, overview] = await Promise.all([api.pbt(), api.overview().catch(() => ({ sample: false }))]);
  const sample = overview.sample === true;
  const root = h('div', { class: 'view view-tests' });
  root.appendChild(h('h1', { class: 'view-title', tabindex: '-1', text: 'Tests' }));
  root.appendChild(h('p', { class: 'view-lead', text: 'Property-based tests generated from each tool schema. They try many inputs and shrink any failure to a small counterexample.' }));

  const results = h('div', { class: 'pbt-results' });
  const status = h('p', { class: 'run-status', role: 'status', 'aria-live': 'polite', text: '' });
  const error = h('div', { class: 'run-error', role: 'alert' });
  const button = h('button', { type: 'button', class: 'btn btn-primary', id: 'run-tests', text: 'Run tests' });
  const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Running property tests', hidden: true }, h('span', { class: 'bar' }));

  const draw = (view) => {
    const rows = toolRows(view);
    results.replaceChildren(
      summary(view, sample),
      rows.length ? h('div', { class: 'card-grid' }, ...rows.map(toolCard)) : emptyState('No property tests', 'Compile a workflow set to generate them.'));
  };
  draw(initial);

  if (sample) {
    button.setAttribute('disabled', '');
    status.textContent = 'Sample mode: there is no suite to run. These are example results.';
  } else if (initial.running) {
    button.setAttribute('disabled', '');
    status.textContent = 'A run is already in progress. Reload in a moment.';
  }

  button.addEventListener('click', async () => {
    error.replaceChildren();
    button.setAttribute('disabled', '');
    button.textContent = 'Running\u2026';
    progress.hidden = false;
    results.setAttribute('aria-busy', 'true');
    status.textContent = 'Running the generated property tests. This can take a minute or two.';
    announce('Running property tests');
    try {
      const view = await api.runPbt();
      draw(view);
      const failing = view.result?.totals?.failing ?? 0;
      status.textContent = failing > 0 ? `Run finished: ${failing} failing.` : 'Run finished: all properties hold.';
    } catch (err) {
      status.textContent = '';
      const message = err instanceof ApiError ? err.message : 'The run failed.';
      error.replaceChildren(h('p', { class: 'state-title', text: 'The run did not complete' }), h('p', { text: message }));
    } finally {
      progress.hidden = true;
      results.removeAttribute('aria-busy');
      button.removeAttribute('disabled');
      button.textContent = 'Run tests';
      announce(status.textContent || 'Run did not complete');
    }
  });

  root.appendChild(h('div', { class: 'run-bar' }, button, status));
  root.appendChild(progress);
  root.appendChild(error);
  root.appendChild(results);
  return root;
}
