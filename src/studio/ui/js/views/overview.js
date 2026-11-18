// @ts-check
import { h, setWidth } from '../dom.js';
import { api, isDemo } from '../api.js';
import { chip, levelBadge, pill, emptyState } from '../components.js';
import { levelInfo } from '../levels.js';
import { href } from '../router.js';
import { COPY } from '../copy.js';
import { welcomePanel } from './welcome.js';
import { newActionSection } from './new-action.js';
import { recompileControl } from './recompile.js';
import { connectCard } from './connect.js';

const LEVEL_ORDER = ['http', 'accessibility', 'vision', 'coordinates', 'terminal', 'none'];

/** @param {any} target */
function stackedBar(target) {
  const counts = target.stepsByLevel ?? {};
  const total = LEVEL_ORDER.reduce((n, l) => n + (counts[l] ?? 0), 0);
  const parts = LEVEL_ORDER.filter((l) => (counts[l] ?? 0) > 0);
  const summary = parts.map((l) => `${counts[l]} ${levelInfo(l).label}`).join(', ');
  const bar = h(
    'div',
    { class: 'stackbar', role: 'img', 'aria-label': total === 0 ? 'No steps' : `Primary replay level of ${total} steps: ${summary}` },
    ...parts.map((l) => setWidth(h('span', { class: 'seg', dataset: { level: l }, title: `${levelInfo(l).label}: ${counts[l]}` }), (counts[l] / total) * 100))
  );
  const legend = h(
    'ul',
    { class: 'bar-legend' },
    ...parts.map((l) => h('li', null, levelBadge(l, { small: true }), h('span', { class: 'count', text: String(counts[l]) })))
  );
  return h('div', { class: 'level-mix' }, h('h4', { class: 'mini-title', text: 'Replay level mix (first level that works)' }), total === 0 ? emptyState('No steps recorded') : bar, legend);
}

/** @param {boolean} on @param {string} label */
function flag(on, label) {
  return h(
    'li',
    { class: `flag ${on ? 'on' : 'off'}`, dataset: { flag: label.toLowerCase().split(' ')[0], on: String(on) } },
    h('span', { class: 'flag-mark', 'aria-hidden': 'true', text: on ? '\u2713' : '\u2013' }),
    h('span', null, label, h('span', { class: 'sr-only', text: on ? ': supported' : ': not available' }))
  );
}

/** @param {any} m the `modes` of a target */
function modeFlags(m) {
  return h('ul', { class: 'flags' }, flag(true, 'Strict'), flag(Boolean(m.healSupport), 'Heal'), flag(Boolean(m.http), 'HTTP'), flag(Boolean(m.compiled), 'Compiled server'));
}

/**
 * After a build ends in `done`: shows the HTTP and Heal flags of the new output and sets the two checkboxes again.
 * @param {HTMLElement} root @param {HTMLElement & { applyTarget?: (target: any) => void }} control
 */
async function refreshModes(root, control) {
  const fresh = await api.overviewFresh();
  const targets = fresh.targets ?? [];
  control.applyTarget?.(targets[0]);
  for (const card of root.querySelectorAll('.target-card')) {
    const match = targets.find((t) => t.name === card.getAttribute('data-target') && t.type === card.getAttribute('data-type'));
    const flags = card.querySelector('.modes ul.flags');
    if (match !== undefined && flags !== null) flags.replaceWith(modeFlags(match.modes ?? {}));
  }
}

/** @param {any} target @param {any[]} workflows @param {number} index */
function targetCard(target, workflows, index) {
  const mine = workflows.filter((w) => w.target.name === target.name && w.target.type === target.type);
  const tools = mine.filter((w) => w.toolName).length;
  const m = target.modes ?? {};
  const typeLabel = target.type === 'web' ? 'Web app' : 'Terminal app';
  const icon = target.type === 'web' ? '\u25A3' : '\u25AE';
  const headingId = `target-${target.type}-${index}`;
  return h(
    'article',
    { class: 'card target-card', dataset: { target: target.name, type: target.type }, 'aria-labelledby': headingId },
    h(
      'header',
      { class: 'card-head' },
      h('div', null,
        h('h3', { class: 'card-title', id: headingId }, h('span', { class: 'type-icon', 'aria-hidden': 'true', text: icon }), target.name || 'Unnamed target'),
        target.start ? h('p', { class: 'muted start' }, h('code', { text: target.start })) : null
      ),
      h('span', { class: 'badge type', text: typeLabel })
    ),
    h(
      'dl',
      { class: 'stats' },
      h('div', null, h('dt', { text: 'Workflows' }), h('dd', null, h('a', { href: href('workflows'), text: String(target.workflows) }))),
      h('div', null, h('dt', { text: 'Tools' }), h('dd', { text: m.compiled || tools > 0 ? String(tools) : '\u2013' })),
      h('div', null, h('dt', { text: 'Steps' }), h('dd', { text: String(target.steps) })),
      h('div', null, h('dt', { text: 'Variables' }), h('dd', { text: String(target.variables) }))
    ),
    stackedBar(target),
    h(
      'div',
      { class: 'modes' },
      h('h4', { class: 'mini-title', text: 'Replay modes' }),
      modeFlags(m)
    ),
    h(
      'p',
      { class: 'muted sandbox' },
      `Sandbox network: `, h('strong', { text: target.sandbox?.network ?? 'bridge' }),
      target.sandbox?.packages?.length ? ` \u00B7 packages: ${target.sandbox.packages.join(', ')}` : ''
    )
  );
}

/** @param {any} pbt @param {any[]} targets */
function healthStrip(pbt, targets) {
  const result = pbt?.result;
  const status = result === undefined ? 'notrun' : result.status === 'passed' ? 'pass' : 'fail';
  const pbtText =
    result === undefined
      ? pbt === null
        ? 'Unknown'
        : 'Not run yet'
      : result.status === 'error'
        ? 'Could not run'
        : `${result.totals.passing} passing, ${result.totals.failing} failing`;
  const heal = targets.filter((t) => t.modes?.healSupport).length;
  const secrets = [...new Set(targets.flatMap((t) => t.secrets ?? []))].sort();
  const tile = (id, title, body, extra) =>
    h('div', { class: 'tile', role: 'group', 'aria-labelledby': id }, h('h3', { class: 'tile-title', id, text: title }), body, extra ?? null);
  return h(
    'section',
    { class: 'health', 'aria-label': 'Health' },
    tile(
      'health-pbt',
      'Property tests',
      h('p', { class: 'tile-value' }, pill(status, status === 'pass' ? 'Passing' : status === 'fail' ? 'Failing' : 'Not run')),
      h('p', { class: 'muted' }, pbtText, ' ', h('a', { href: href('tests'), text: 'Details' }))
    ),
    tile(
      'health-drift',
      'Drift detection',
      h('p', { class: 'tile-value' }, pill('pass', 'On')),
      h('p', { class: 'muted', text: 'Strict replay reports drifted when the app no longer matches what was recorded.' })
    ),
    tile(
      'health-heal',
      'Self-healing',
      h('p', { class: 'tile-value' }, pill(heal > 0 ? 'pass' : 'notrun', heal > 0 ? 'Available' : 'Not compiled')),
      h('p', { class: 'muted', text: `${heal} of ${targets.length} target${targets.length === 1 ? '' : 's'} ship heal support.` })
    ),
    tile(
      'health-secrets',
      'Secrets required',
      secrets.length === 0
        ? h('p', { class: 'tile-value' }, pill('pass', 'None'))
        : h('p', { class: 'chips' }, ...secrets.map((n) => chip(n, 'secret'))),
      h('p', { class: 'muted', text: 'Names only. Values come from the environment at run time.' })
    )
  );
}

/** @returns {Promise<HTMLElement>} */
export async function renderOverview() {
  const [overview, wf, pbt] = await Promise.all([api.overview(), api.workflows(), api.pbt().catch(() => null)]);
  const targets = overview.targets ?? [];
  const live = !isDemo(overview);
  const root = h('div', { class: 'view view-overview' });
  root.appendChild(h('h1', { class: 'view-title', tabindex: '-1', text: 'Overview' }));
  root.appendChild(h('p', { class: 'view-lead', text: 'What Daemonize learned from your recordings, and how safely it can replay it.' }));
  if (live && overview.recordingActive === true) {
    root.appendChild(h('p', { class: 'notice', role: 'note', id: 'recording-active' }, `${COPY.recordingInProgress} `, h('a', { href: href('record'), text: COPY.seeRecording })));
  }
  const noActions = (wf.workflows ?? []).length === 0;
  if (noActions && live) {
    root.appendChild(welcomePanel());
    root.appendChild(h('p', { class: 'muted' }, h('a', { href: href('credentials'), text: COPY.credentialsLink })));
    return root;
  }
  if (live) {
    const control = recompileControl({ target: targets[0], onDone: () => refreshModes(root, control) });
    // New action, credentials and the build controls (hidden in the static demo and in sample mode)
    root.appendChild(
      h('div', { class: 'overview-actions run-bar' },
        newActionSection(),
        h('a', { class: 'btn', href: href('credentials'), text: COPY.credentialsLink }),
        control)
    );
    if (overview.outputCompiled === true) root.appendChild(connectCard());
  }
  if (targets.length === 0) {
    root.appendChild(emptyState('No targets yet', 'Add an action to get started.'));
    return root;
  }
  root.appendChild(healthStrip(pbt, targets));
  root.appendChild(h('h2', { class: 'section-title', text: targets.length === 1 ? 'Target' : 'Targets' }));
  root.appendChild(h('div', { class: 'card-grid' }, ...targets.map((t, i) => targetCard(t, wf.workflows ?? [], i))));
  return root;
}
