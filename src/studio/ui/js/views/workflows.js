// @ts-check
import { h } from '../dom.js';
import { api } from '../api.js';
import { chip, emptyState, levelBadge, levelLegend, panel, riskBadge, toolName, varChip } from '../components.js';
import { WEB_LEVELS } from '../levels.js';
import { href } from '../router.js';

/** The distinct primary levels of a workflow, in replay order. */
function primaryLevels(wf) {
  const seen = new Set(wf.steps.map((s) => s.primaryLevel));
  return ['http', 'accessibility', 'vision', 'coordinates', 'terminal', 'none'].filter((l) => seen.has(l));
}

/** @param {any[]} workflows @param {string | undefined} activeId @param {string} filter */
function listItems(workflows, activeId, filter) {
  const needle = filter.trim().toLowerCase();
  const shown = workflows.filter((w) => needle === '' || `${w.label} ${w.toolName ?? ''}`.toLowerCase().includes(needle));
  if (shown.length === 0) return [h('li', { class: 'list-empty muted', text: 'No workflow matches.' })];
  return shown.map((w) =>
    h(
      'li',
      null,
      h(
        'a',
        { class: 'wf-link', href: href('workflows', w.id), 'aria-current': w.id === activeId ? 'page' : undefined, dataset: { workflow: w.id } },
        h('span', { class: 'wf-name', text: w.label || w.toolName || w.id }),
        w.toolName ? h('code', { class: 'wf-tool', text: w.toolName }) : null,
        h('span', { class: 'wf-badges' }, riskBadge(w.risk.highest), ...primaryLevels(w).map((l) => levelBadge(l, { small: true })))
      )
    )
  );
}

/** @param {any} step @param {any} wf */
function stepItem(step, wf) {
  const target = step.target;
  const otherLevels = step.primaryLevel === 'terminal' ? [] : WEB_LEVELS.filter((l) => step.levels[l] && l !== step.primaryLevel);
  const name = step.label || `${step.action} ${step.index + 1}`;
  const meta = [];
  if (target) {
    meta.push(chip(`role: ${target.role}`, 'role'));
    if (target.name) meta.push(chip(`name: ${target.name}`, 'name'));
    if (target.parentKind) meta.push(chip(`in ${target.parentKind} \u201C${target.parentName ?? ''}\u201D`, 'parent'));
  }
  if (step.variable) meta.push(h('span', { class: 'chip-group' }, h('span', { class: 'muted', text: 'types ' }), varChip(step.variable)));
  if (step.usesSecret) meta.push(chip('\u{1F512} secret value (hidden)', 'secret'));
  if (step.rowBinding) {
    const r = step.rowBinding;
    meta.push(
      h('span', { class: 'chip-group', dataset: { rowBinding: 'true' } },
        h('span', { class: 'muted', text: `row binding${r.kind ? ` (${r.kind})` : ''}${r.keyColumn ? ` by ${r.keyColumn}` : ''} ` }),
        r.variable ? varChip(r.variable) : null)
    );
  }
  const details = [];
  if (step.http) {
    const x = step.http;
    details.push(
      h('p', { class: 'step-line http-line' },
        h('code', { text: `${x.method} ${x.path}` }),
        x.queryKeys?.length ? h('span', { class: 'muted', text: ` ?${x.queryKeys.join('&')}` }) : null,
        x.auth ? h('span', { class: 'muted', text: ` \u00B7 auth ${x.auth}` }) : null,
        x.expectStatus ? h('span', { class: 'muted', text: ` \u00B7 expects ${x.expectStatus}` }) : null,
        x.bodyFormat ? h('span', { class: 'muted', text: ` \u00B7 body ${x.bodyFormat}` }) : null)
    );
  }
  if (step.waitFor) {
    const w = step.waitFor;
    details.push(
      h('p', { class: 'step-line wait-line' }, h('span', { class: 'label', text: 'Waits' }), ' for ', w.kind, ' ', h('code', { text: w.expression }),
        h('span', { class: 'muted', text: ` (${w.mode}${w.when ? `, ${w.when}` : ''}, up to ${w.timeoutMs} ms)` }))
    );
  }
  if (step.timeoutMs) details.push(h('p', { class: 'step-line' }, h('span', { class: 'label', text: 'Timeout' }), ` ${step.timeoutMs} ms`));
  const thumb = step.thumbnailUrl
    ? h('figure', { class: 'thumb' },
        h('img', { src: step.thumbnailUrl, alt: `Screenshot recorded at step ${step.index + 1}: ${name}`, loading: 'lazy', width: '160', height: '90' }),
        h('figcaption', { class: 'muted', text: 'Recorded anchor' }))
    : null;
  return h(
    'li',
    { class: 'step', dataset: { step: step.index, level: step.primaryLevel, risk: step.risk } },
    h('span', { class: 'step-dot', 'aria-hidden': 'true', text: String(step.index + 1) }),
    h(
      'div',
      { class: 'step-body' },
      h(
        'div',
        { class: 'step-head' },
        h('h4', { class: 'step-title' }, h('span', { class: 'sr-only', text: `Step ${step.index + 1}: ` }), h('span', { class: 'action', text: step.action }), ' ', name),
        h('span', { class: 'step-badges' },
          levelBadge(step.primaryLevel, { primary: true }),
          step.risk !== 'read' ? riskBadge(step.risk) : null,
          step.allowHeal ? chip('heal allowed', 'heal') : null)
      ),
      step.intent ? h('p', { class: 'intent', text: `\u201C${step.intent}\u201D` }) : null,
      meta.length ? h('div', { class: 'chips' }, ...meta) : null,
      ...details,
      otherLevels.length
        ? h('p', { class: 'step-line fallbacks muted' }, 'Fallbacks: ', ...otherLevels.flatMap((l) => [levelBadge(l, { small: true }), ' ']))
        : null,
      thumb
    )
  );
}

/** @param {any} wf */
function detail(wf) {
  const vars = wf.variables.length
    ? h(
        'table',
        { class: 'table compact' },
        h('caption', { class: 'sr-only', text: 'Variables' }),
        h('thead', null, h('tr', null, ...['Name', 'Type', 'Description', 'Required'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', null,
          ...wf.variables.map((v) =>
            h('tr', null, h('td', null, varChip(v.name)), h('td', null, h('code', { text: v.type })), h('td', { text: v.description ?? '\u2013' }), h('td', { text: v.optional ? 'optional' : 'required' }))
          ))
      )
    : h('p', { class: 'muted', text: 'This workflow takes no input.' });
  const secrets = wf.secrets.length
    ? h('ul', { class: 'plain-list' }, ...wf.secrets.map((x) => h('li', null, chip(x.name, 'secret'), x.kind ? h('span', { class: 'muted', text: ` ${x.kind}` }) : null)))
    : h('p', { class: 'muted', text: 'No secret needed.' });
  const facts = h(
    'dl',
    { class: 'facts' },
    h('div', null, h('dt', { text: 'Target' }), h('dd', { text: `${wf.target.name} (${wf.target.type === 'web' ? 'web' : 'terminal'})` })),
    h('div', null, h('dt', { text: 'Steps' }), h('dd', { text: String(wf.stepCount) })),
    wf.timeoutMs ? h('div', null, h('dt', { text: 'Timeout' }), h('dd', { text: `${wf.timeoutMs} ms` })) : null,
    h('div', null, h('dt', { text: 'Result zone' }), h('dd', { text: wf.hasResultZone ? 'defined' : 'none' })),
    wf.finalScreenId ? h('div', null, h('dt', { text: 'Final screen' }), h('dd', null, h('code', { text: wf.finalScreenId }))) : null
  );
  return h(
    'article',
    { class: 'wf-detail', 'aria-labelledby': 'wf-title' },
    h(
      'header',
      { class: 'wf-head' },
      h('h2', { id: 'wf-title', class: 'view-title', tabindex: '-1', text: wf.label || wf.id }),
      h('div', { class: 'wf-meta' },
        wf.toolName ? toolName(wf.toolName) : h('span', { class: 'muted', text: 'Not compiled yet: no tool name.' }),
        riskBadge(wf.risk.highest),
        h('a', { class: 'btn btn-small', href: href('graph', undefined, { wf: wf.id }), text: 'Show in graph' }),
        h('a', { class: 'btn btn-small', href: href('schemas', wf.id), text: 'Schemas' })),
      wf.description ? h('p', { class: 'view-lead', text: wf.description }) : null
    ),
    levelLegend(),
    h('div', { class: 'detail-grid' },
      h('section', { class: 'timeline-wrap', 'aria-labelledby': 'steps-title' },
        h('h3', { class: 'panel-title', id: 'steps-title', text: `Steps (${wf.stepCount})` }),
        h('ol', { class: 'timeline' }, ...wf.steps.map((s) => stepItem(s, wf))),
        wf.stepCount > wf.steps.length ? h('p', { class: 'muted', text: `Showing the first ${wf.steps.length} of ${wf.stepCount} steps.` }) : null),
      h('div', { class: 'side' },
        panel('p-facts', 'About', facts),
        panel('p-vars', 'Variables', vars),
        panel('p-secrets', 'Secrets needed', secrets, h('p', { class: 'muted small', text: 'Names only. Set them as environment variables when the tool runs.' })))
    )
  );
}

/** @param {{ parts: string[] }} route */
export async function renderWorkflows(route) {
  const { workflows, truncated } = await api.workflows();
  const activeId = route.parts[0];
  const active = workflows.find((w) => w.id === activeId);
  const root = h('div', { class: 'view view-workflows' });
  if (workflows.length === 0) {
    root.appendChild(h('h1', { class: 'view-title', tabindex: '-1', text: 'Workflows' }));
    root.appendChild(emptyState('No workflows in this file', 'Record one with daemonize record, then compile.'));
    return root;
  }
  const list = h('ul', { class: 'wf-list' }, ...listItems(workflows, active?.id, ''));
  const filter = h('input', { type: 'search', id: 'wf-filter', class: 'input', placeholder: 'Filter by name or tool', autocomplete: 'off' });
  filter.addEventListener('input', () => {
    list.replaceChildren(...listItems(workflows, active?.id, /** @type {HTMLInputElement} */ (filter).value));
  });
  // Arrow keys walk the list; Enter on a link opens it (native)
  list.addEventListener('keydown', (ev) => {
    const key = /** @type {KeyboardEvent} */ (ev).key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
    const links = [...list.querySelectorAll('a')];
    const at = links.indexOf(/** @type {HTMLAnchorElement} */ (document.activeElement));
    const next = links[Math.max(0, Math.min(links.length - 1, at + (key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      ev.preventDefault();
      next.focus();
    }
  });
  const aside = h('nav', { class: 'wf-nav', 'aria-label': 'Workflows' },
    h('label', { class: 'field-label', for: 'wf-filter', text: 'Filter workflows' }),
    filter,
    list,
    truncated ? h('p', { class: 'muted small', text: 'Only the first workflows are listed.' }) : null);
  root.appendChild(h('h1', { class: 'view-title', tabindex: active ? undefined : '-1', text: 'Workflows' }));
  const main = h('div', { class: 'wf-main' },
    active
      ? detail(active)
      : h('div', { class: 'state empty' },
          h('p', { class: 'state-title', text: 'Pick a workflow' }),
          h('p', { class: 'muted', text: 'Each one becomes a tool. Open it to see its steps, the replay level of each step, and what it needs.' }),
          levelLegend()));
  root.appendChild(h('div', { class: 'split' }, aside, main));
  return root;
}
