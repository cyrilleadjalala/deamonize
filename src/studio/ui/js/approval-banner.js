// @ts-check
/**
 * The approval banner: the questions waiting for an answer. It polls `GET /api/approvals` every 2 seconds while it is
 * mounted, draws each request once (a poll never rebuilds a request, so the focus stays where the user put it), counts
 * the seconds down, and sends the answer with `POST /api/approvals/decide`. Values come from the server already
 * redacted and are written as text only.
 */
import { h } from './dom.js';
import { api, isDemo, isStatic } from './api.js';
import { announce } from './components.js';
import { COPY_ACTIVITY as T, announceApproved, announceDenied, announceEnded, announceNewRequest, announceResult, riskText } from './copy-activity.js';

export const POLL_MS = 2000;
const RESULT_TRIES = 4;
const RESULT_WAIT_MS = 1000;

/** @param {unknown} value @returns {string} */
function valueText(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The arguments as a list "name: value" (text nodes only).
 * @param {unknown} args
 * @returns {HTMLElement}
 */
export function argumentsList(args) {
  const entries = args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.entries(/** @type {Record<string, unknown>} */ (args)) : [];
  if (entries.length === 0) return h('p', { class: 'muted', text: T.noArguments });
  return h('dl', { class: 'activity-args' }, ...entries.flatMap(([name, value]) => [h('dt', { text: name }), h('dd', null, h('code', { text: valueText(value) }))]));
}

/**
 * Polls the pending questions while mounted and draws them in `container`. Returns the function that stops it.
 * @param {HTMLElement} container
 * @returns {() => void}
 */
export function mountApprovalBanner(container) {
  const root = h('div', { class: 'approval-banner', 'aria-label': T.bannerLabel, role: 'group' });
  const list = h('div', { class: 'approval-list' });
  const results = h('div', { class: 'approval-results', role: 'status' });
  root.append(list, results);
  container.append(root);

  /** @type {Map<string, { section: HTMLElement, seconds: HTMLElement, tool: string, left: number, at: number, error: HTMLElement, buttons: HTMLButtonElement[] }>} */
  const shown = new Map();
  let stopped = false;
  let timer = 0;
  let ticker = 0;
  let readOnly = false;
  let sawConnected = false;

  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearInterval(ticker);
    window.removeEventListener('hashchange', stop);
  };
  window.addEventListener('hashchange', stop);

  /** After an answer: tell the user how the call ended when its entry arrives. @param {string} tool @param {number} since */
  async function showResult(tool, since) {
    const line = h('p', { class: 'muted', text: `${tool}: ${T.waitingForResult}` });
    results.append(line);
    for (let i = 0; i < RESULT_TRIES && !stopped; i++) {
      await new Promise((r) => window.setTimeout(r, RESULT_WAIT_MS));
      if (stopped) return;
      try {
        const { entries } = await api.activity({ limit: 10, tool });
        const entry = (Array.isArray(entries) ? entries : []).find((e) => Date.parse(e.at) >= since - 1000);
        if (entry !== undefined) {
          const worked = entry.outcome === 'success';
          line.textContent = `${tool}: ${worked ? T.resultWorked : T.resultFailed}`;
          announce(announceResult(tool, worked));
          return;
        }
      } catch {
        // The result is a courtesy: the Activity view has the entry
      }
    }
    line.remove();
  }

  /** @param {string} id @param {'approved' | 'denied'} decision */
  async function decide(id, decision) {
    const item = shown.get(id);
    if (item === undefined) return;
    item.error.textContent = '';
    for (const b of item.buttons) b.disabled = true;
    const since = Date.now();
    let res;
    try {
      res = await api.approvalDecide(id, decision);
    } catch {
      res = { status: 0, body: null };
    }
    if (res.status === 200) {
      announce(decision === 'approved' ? announceApproved(item.tool) : announceDenied(item.tool));
      remove(id);
      if (decision === 'approved') void showResult(item.tool, since);
      return;
    }
    if (res.status === 404) {
      announce(announceEnded(item.tool));
      remove(id);
      return;
    }
    for (const b of item.buttons) b.disabled = false;
    item.error.textContent = res.status === 409 && typeof res.body?.error === 'string' ? res.body.error : T.decideFailed;
  }

  /** Remove a request; the focus goes to the banner group only when the removed request held it. @param {string} id */
  function remove(id) {
    const item = shown.get(id);
    if (item === undefined) return;
    const hadFocus = item.section.contains(document.activeElement);
    item.section.remove();
    shown.delete(id);
    if (hadFocus) {
      root.setAttribute('tabindex', '-1');
      root.focus();
    }
  }

  /** @param {any} view */
  function build(view) {
    const id = String(view.id);
    const tool = String(view.tool);
    const seconds = h('span', { class: 'approval-seconds', 'aria-live': 'off', text: String(Math.max(0, Math.round(Number(view.secondsLeft) || 0))) });
    const error = h('p', { class: 'error-text', role: 'alert' });
    const steps = Array.isArray(view.writeSteps) ? view.writeSteps : [];
    const approve = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-primary', 'aria-label': `${T.approve}: ${tool}`, text: T.approve, onclick: () => void decide(id, 'approved') }));
    const deny = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn', 'aria-label': `${T.deny}: ${tool}`, text: T.deny, onclick: () => void decide(id, 'denied') }));
    const buttons = readOnly ? [] : [approve, deny];
    const headingId = `approval-title-${id}`;
    const section = h('section', { class: 'approval-request', role: 'alert', 'aria-labelledby': headingId, dataset: { approvalId: id } },
      h('h2', { class: 'approval-title', id: headingId, text: T.bannerTitle }),
      h('p', null, h('strong', { text: `${T.toolLabel}: ` }), h('code', { text: tool })),
      typeof view.application === 'string' ? h('p', null, h('strong', { text: `${T.applicationLabel}: ` }), h('span', { text: view.application })) : null,
      h('p', { class: 'approval-risk' }, h('span', { class: 'chip fail', text: typeof view.riskText === 'string' && view.riskText !== '' ? view.riskText : riskText(String(view.risk)) })),
      h('h3', { class: 'approval-sub', text: T.argumentsLabel }),
      argumentsList(view.arguments),
      steps.length > 0 ? h('h3', { class: 'approval-sub', text: T.writeStepsLabel }) : null,
      steps.length > 0 ? h('ul', { class: 'plain-list' }, ...steps.map((/** @type {any} */ s) => h('li', { text: `${Number(s.index) + 1}. ${String(s.label)}` }))) : null,
      h('p', { class: 'muted' }, `${T.secondsLeft}: `, seconds),
      readOnly ? h('p', { class: 'notice', text: T.sampleNote }) : h('div', { class: 'run-bar' }, approve, deny),
      error);
    list.append(section);
    shown.set(id, { section, seconds, tool, left: Number(view.secondsLeft) || 0, at: Date.now(), error, buttons });
    announce(announceNewRequest(tool));
  }

  /** @param {any[]} pending */
  function sync(pending) {
    const ids = new Set(pending.map((p) => String(p.id)));
    for (const [id, item] of [...shown]) {
      if (!ids.has(id)) {
        // Ended without our answer (timeout, withdrawn, answered elsewhere)
        announce(announceEnded(item.tool));
        remove(id);
      }
    }
    for (const view of pending) {
      const id = String(view.id);
      const item = shown.get(id);
      if (item === undefined) build(view);
      else {
        item.left = Number(view.secondsLeft) || 0;
        item.at = Date.now();
      }
    }
  }

  const tick = () => {
    for (const item of shown.values()) {
      const left = Math.max(0, item.left - Math.floor((Date.now() - item.at) / 1000));
      item.seconds.textContent = String(left);
    }
  };

  async function poll() {
    if (container.isConnected) sawConnected = true;
    // The view was replaced: stop (a host that was never attached yet is given time)
    if (stopped || (sawConnected && !container.isConnected)) {
      stop();
      return;
    }
    try {
      const body = await api.approvals();
      if (!stopped) sync(Array.isArray(body?.pending) ? body.pending : []);
    } catch {
      // Keep what is shown; the next poll tries again
    }
    if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS);
  }

  // The demo and the sample Studio show the question but cannot answer it
  const start = async () => {
    if (isStatic) readOnly = true;
    else {
      try {
        readOnly = isDemo(await api.overview());
      } catch {
        readOnly = false;
      }
    }
    if (stopped) return;
    ticker = window.setInterval(tick, 1000);
    void poll();
  };
  void start();
  return stop;
}
