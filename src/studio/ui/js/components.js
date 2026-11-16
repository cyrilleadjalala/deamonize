// @ts-check
/** Small shared pieces: badges, chips, copy button, state boxes. All built with the safe builders. */
import { h, clear } from './dom.js';
import { levelInfo, riskInfo } from './levels.js';

/**
 * A replay level badge. The shape, the word and the colour all carry the level.
 * @param {string} level
 * @param {{ small?: boolean, primary?: boolean }} [opts]
 */
export function levelBadge(level, opts = {}) {
  const info = levelInfo(level);
  return h(
    'span',
    { class: `badge level${opts.small ? ' small' : ''}`, dataset: { level, primary: opts.primary ? 'true' : undefined } },
    h('span', { class: 'glyph', 'aria-hidden': 'true', text: info.glyph }),
    info.label
  );
}

/** @param {string} risk */
export function riskBadge(risk) {
  const info = riskInfo(risk);
  return h('span', { class: 'badge risk', dataset: { risk } }, h('span', { class: 'glyph', 'aria-hidden': 'true', text: info.glyph }), info.label);
}

/**
 * @param {string} text
 * @param {string} [kind]
 */
export function chip(text, kind = 'plain') {
  return h('span', { class: `chip ${kind}`, text });
}

/** A `{{variable}}` chip. */
export function varChip(name) {
  return h('span', { class: 'chip variable', dataset: { variable: name }, text: `{{${name}}}` });
}

/** @param {string} kind @param {string} label */
export function pill(kind, label) {
  return h('span', { class: `pill ${kind}`, dataset: { status: kind } }, h('span', { class: 'dot', 'aria-hidden': 'true' }), label);
}

/**
 * Copies a text. Uses the clipboard API, with a textarea fallback for pages without it.
 * @param {string} value
 * @param {string} label accessible name, e.g. "Copy tool name search_customers"
 * @param {{ text?: string }} [opts]
 */
export function copyButton(value, label, opts = {}) {
  const idle = opts.text ?? 'Copy';
  const button = h('button', { type: 'button', class: 'btn btn-small btn-quiet copy', 'aria-label': label, text: idle });
  button.addEventListener('click', async () => {
    const ok = await copyText(value);
    button.textContent = ok ? 'Copied' : 'Copy failed';
    button.setAttribute('data-copied', ok ? 'true' : 'false');
    announce(ok ? `Copied ${value.length > 40 ? 'text' : value}` : 'Copy failed');
    window.setTimeout(() => {
      button.textContent = idle;
      button.removeAttribute('data-copied');
    }, 1600);
  });
  return button;
}

/** @param {string} value */
export async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the textarea
  }
  const area = h('textarea', { class: 'sr-only', 'aria-hidden': 'true', tabindex: '-1', readonly: true });
  /** @type {HTMLTextAreaElement} */ (area).value = value;
  document.body.appendChild(area);
  /** @type {HTMLTextAreaElement} */ (area).select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Say something to screen readers. */
export function announce(message) {
  const live = document.getElementById('live');
  if (live === null) return;
  live.textContent = '';
  window.setTimeout(() => {
    live.textContent = message;
  }, 30);
}

/**
 * A tool name in code font with its copy button.
 * @param {string} name
 */
export function toolName(name) {
  return h('span', { class: 'tool-name' }, h('code', { text: name }), copyButton(name, `Copy tool name ${name}`));
}

/** @param {string} message */
export function loadingState(message = 'Loading\u2026') {
  return h('p', { class: 'state loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), message);
}

/** @param {string} title @param {string} [detail] */
export function emptyState(title, detail) {
  return h('div', { class: 'state empty' }, h('p', { class: 'state-title', text: title }), detail ? h('p', { class: 'muted', text: detail }) : null);
}

/** @param {string} message @param {(() => void) | undefined} [retry] */
export function errorState(message, retry) {
  return h(
    'div',
    { class: 'state error', role: 'alert' },
    h('p', { class: 'state-title', text: 'Something went wrong' }),
    h('p', { text: message }),
    retry ? h('button', { type: 'button', class: 'btn', onclick: retry, text: 'Try again' }) : null
  );
}

/**
 * A titled panel (section with a heading wired by aria-labelledby).
 * @param {string} id
 * @param {string} title
 * @param {...any} content
 */
export function panel(id, title, ...content) {
  return h('section', { class: 'panel', 'aria-labelledby': id }, h('h3', { id, class: 'panel-title', text: title }), ...content);
}

/** Replace the content of a node. */
export function setContent(node, ...children) {
  clear(node);
  for (const child of children) if (child) node.appendChild(child);
}

/** The legend explaining the levels. */
export function levelLegend() {
  const items = ['http', 'accessibility', 'vision', 'coordinates', 'terminal'].map((level) =>
    h('li', null, levelBadge(level, { small: true }), h('span', { class: 'muted', text: levelInfo(level).description }))
  );
  return h(
    'details',
    { class: 'legend', open: true },
    h('summary', { text: 'Replay level legend' }),
    h('p', { class: 'muted', text: 'Each step is replayed at the first level that works. Lower levels are fallbacks.' }),
    h('ul', { class: 'legend-list' }, ...items)
  );
}
