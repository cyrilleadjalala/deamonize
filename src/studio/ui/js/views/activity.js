// @ts-check
/**
 * The Activity view (`#/activity`): what agents did with your tools, newest first. Read only: there is no control that
 * edits or deletes an entry. The filters `tool` and `decision` live in the address (`#/activity?tool=...&decision=...`).
 */
import { h } from '../dom.js';
import { api, ApiError } from '../api.js';
import { pill, emptyState, errorState } from '../components.js';
import { href } from '../router.js';
import { mountApprovalBanner, argumentsList } from '../approval-banner.js';
import { renderSimpleTimeline } from '../timeline.js';
import { COPY_ACTIVITY as T, decisionText, durationText, outcomeText, riskText } from '../copy-activity.js';

const DECISIONS = ['auto', 'approved', 'denied', 'timeout', 'unavailable'];
const PAGE = 100;

/** @param {string} decision @returns {string} */
const decisionKind = (decision) => (decision === 'approved' || decision === 'auto' ? 'pass' : decision === 'denied' ? 'fail' : 'notrun');
/** @param {string} outcome @returns {string} */
const outcomeKind = (outcome) => (outcome === 'success' ? 'pass' : 'fail');

/** @param {string} at @returns {string} */
function timeText(at) {
  const t = Date.parse(at);
  return Number.isNaN(t) ? String(at) : new Date(t).toLocaleString();
}

/**
 * @param {string[]} tools
 * @param {{ tool: string, decision: string }} filters
 */
function filterBar(tools, filters) {
  const toolNames = filters.tool !== '' && !tools.includes(filters.tool) ? [...tools, filters.tool] : tools;
  const go = (/** @type {string} */ tool, /** @type {string} */ decision) => {
    /** @type {Record<string, string>} */
    const query = {};
    if (tool !== '') query.tool = tool;
    if (decision !== '') query.decision = decision;
    window.location.hash = href('activity', undefined, query);
  };
  const toolSelect = /** @type {HTMLSelectElement} */ (
    h('select', { class: 'input', id: 'activity-filter-tool', onchange: () => go(toolSelect.value, decisionSelect.value) },
      h('option', { value: '', text: T.filterAll }),
      ...toolNames.map((n) => h('option', { value: n, selected: n === filters.tool, text: n })))
  );
  const decisionSelect = /** @type {HTMLSelectElement} */ (
    h('select', { class: 'input', id: 'activity-filter-decision', onchange: () => go(toolSelect.value, decisionSelect.value) },
      h('option', { value: '', text: T.filterAll }),
      ...DECISIONS.map((d) => h('option', { value: d, selected: d === filters.decision, text: decisionText(d) })))
  );
  return h('form', { class: 'activity-filters', role: 'search', 'aria-label': T.filtersLabel, onsubmit: (/** @type {Event} */ e) => e.preventDefault() },
    h('label', { class: 'field-label inline', for: 'activity-filter-tool', text: T.filterTool }), toolSelect,
    h('label', { class: 'field-label inline', for: 'activity-filter-decision', text: T.filterDecision }), decisionSelect,
    filters.tool !== '' || filters.decision !== '' ? h('a', { class: 'btn btn-small btn-quiet', id: 'activity-clear', href: href('activity'), text: T.clearFilters }) : null);
}

/**
 * One entry: the visible row and the details row, opened by a button.
 * @param {any} entry
 * @param {number} index
 * @returns {HTMLElement[]}
 */
function entryRows(entry, index) {
  const detailsId = `activity-details-${index}`;
  const detailsRow = h('tr', { class: 'activity-details', id: detailsId, hidden: true });
  const toggle = /** @type {HTMLButtonElement} */ (
    h('button', { type: 'button', class: 'btn btn-small btn-quiet', 'aria-expanded': 'false', 'aria-controls': detailsId, 'aria-label': `${T.show}: ${entry.tool}, ${timeText(entry.at)}`, text: T.show,
      onclick: () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? T.hide : T.show;
        toggle.setAttribute('aria-label', `${open ? T.hide : T.show}: ${entry.tool}, ${timeText(entry.at)}`);
        if (open) detailsRow.removeAttribute('hidden');
        else detailsRow.setAttribute('hidden', '');
      } })
  );
  const steps = Array.isArray(entry.steps) ? entry.steps : [];
  detailsRow.append(h('td', { colspan: 7 },
    h('p', { class: 'muted' }, entry.source === 'studio' ? T.sourceStudio : T.sourceKiro, typeof entry.application === 'string' && entry.application !== '' ? ` \u00B7 ${T.applicationLabel}: ${entry.application}` : ''),
    h('h4', { class: 'approval-sub', text: T.argumentsTitle }),
    argumentsList(entry.arguments),
    steps.length > 0 ? h('h4', { class: 'approval-sub', text: T.stepsTitle }) : null,
    steps.length > 0 ? renderSimpleTimeline(steps) : null));
  const row = h('tr', { class: 'activity-row', dataset: { decision: entry.decision, tool: entry.tool } },
    h('td', { text: timeText(entry.at) }),
    h('td', null, h('code', { text: String(entry.tool) })),
    h('td', { text: riskText(String(entry.risk)) }),
    h('td', null, pill(decisionKind(entry.decision), decisionText(entry.decision))),
    h('td', null, pill(outcomeKind(entry.outcome), outcomeText(entry.outcome))),
    h('td', { text: durationText(entry.durationMs) }),
    h('td', null, toggle));
  return [row, detailsRow];
}

/**
 * @param {import('../router.js').Route} route
 * @returns {Promise<HTMLElement>}
 */
export async function renderActivity(route) {
  const filters = { tool: route.query.get('tool') ?? '', decision: route.query.get('decision') ?? '' };
  if (!DECISIONS.includes(filters.decision)) filters.decision = '';

  const root = h('div', { class: 'view view-activity' });
  root.append(h('h1', { class: 'view-title', tabindex: '-1', text: T.title }), h('p', { class: 'view-lead', text: T.lead }));
  const bannerHost = h('div', { class: 'approval-host' });
  root.append(bannerHost);
  // The banner starts once the view is in the page (it stops itself when its host leaves)
  window.setTimeout(() => mountApprovalBanner(bannerHost), 0);

  /** @type {any} */
  let data;
  try {
    data = await api.activity({ limit: PAGE, tool: filters.tool, decision: filters.decision });
  } catch (err) {
    root.append(errorState(err instanceof ApiError ? err.message : T.loadFailed));
    return root;
  }
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const tools = Array.isArray(data?.tools) ? data.tools.filter((/** @type {unknown} */ n) => typeof n === 'string') : [];
  const filtered = filters.tool !== '' || filters.decision !== '';

  if (entries.length === 0 && !filtered) {
    root.append(emptyState(T.empty));
    return root;
  }
  root.append(filterBar(tools, filters));
  if (entries.length === 0) {
    root.append(h('p', { class: 'notice', role: 'status', text: T.emptyFiltered }));
    return root;
  }
  const total = typeof data?.total === 'number' ? data.total : entries.length;
  root.append(
    h('p', { class: 'muted', role: 'status', text: `${T.showing} ${entries.length} ${T.of} ${total} ${T.calls}` }),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'table activity-table', 'aria-label': T.tableLabel },
        h('thead', null, h('tr', null, ...[T.colTime, T.colTool, T.colRisk, T.colDecision, T.colOutcome, T.colDuration, T.colDetails].map((c) => h('th', { scope: 'col', text: c })))),
        h('tbody', null, ...entries.flatMap((/** @type {any} */ e, /** @type {number} */ i) => entryRows(e, i))))));
  return root;
}
