// @ts-check
import { h } from '../dom.js';
import { api, ApiError } from '../api.js';
import { announce, pill } from '../components.js';
import { announceOnChange } from '../announcer.js';
import { COPY, announceText, statusText, stepCountText } from '../copy.js';
import { COPY_RECORD } from '../copy-record.js';
import { href } from '../router.js';
import { connectCard } from './connect.js';
import { demoScreen } from './demo.js';

export const POLL_MS = 1500;
const ACTIVE = new Set(['recording', 'saving', 'compiling']);

/** @param {string} state */
const pillKind = (state) => (state === 'done' ? 'pass' : state === 'error' ? 'fail' : 'notrun');

/**
 * The tool name of the newest action, to open the playground with it selected.
 * @returns {Promise<string | undefined>}
 */
async function newestToolName() {
  try {
    const { workflows } = await api.workflowsFresh();
    const named = (Array.isArray(workflows) ? workflows : []).filter((w) => typeof w.toolName === 'string' && w.toolName !== '');
    return named.length > 0 ? named[named.length - 1].toolName : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The names still missing after the tool was added to Kiro. An absent or malformed list is empty, and a failed install has none.
 * @param {any} s
 * @returns {string[]}
 */
export function missingSecretsOf(s) {
  if (s?.kiro?.added !== true) return [];
  const list = s.kiro.missingSecrets;
  return Array.isArray(list) ? list.filter((n) => typeof n === 'string' && n !== '') : [];
}
/**
 * The alert that lists the credentials still missing, with one link to the Credentials view.
 * @param {string[]} names
 */
function credentialsBlock(names) {
  return h('div', { class: 'record-credentials', id: 'kiro-missing-secrets', role: 'alert' },
    h('p', { class: 'state-title', text: COPY_RECORD.credentialsMissingTitle }),
    h('p', { text: COPY_RECORD.credentialsMissingLead }),
    h('ul', { class: 'plain-list' }, ...names.map((n) => h('li', null, h('code', { class: 'path', text: n })))),
    h('p', null, h('a', { class: 'btn', id: 'kiro-add-credentials', href: href('credentials'), text: COPY_RECORD.credentialsMissingLink })));
}
/**
 * After "Save and add to Kiro": scroll once, to the top of the result (when its message is shown) or of the Connect block.
 * lock: 'start' with the scroll margin of record.css keeps the header off the first line. No call when the target is missing.
 * @param {HTMLElement} outcome
 */
export function scrollToKiroResult(outcome) {
  const target = outcome.querySelector('#kiro-result') !== null ? outcome : outcome.querySelector('#connect-card');
  if (target === null) return;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
}
/** @returns {Promise<HTMLElement>} */
export async function renderRecordStatus() {
  const demo = await demoScreen(COPY.recordTitle);
  if (demo !== null) return demo;

  const root = h('div', { class: 'view view-record' });
  root.append(h('h1', { class: 'view-title', tabindex: '-1', text: COPY.recordTitle }), h('p', { class: 'view-lead', text: COPY.recordLead }));

  const lost = h('p', { class: 'notice', role: 'status', id: 'connection-lost', hidden: true, text: COPY.connectionLost });
  const announceLostOnce = { done: false };
  const stateHost = h('p', { class: 'record-state', id: 'record-state' });
  const countHost = h('p', { class: 'muted', id: 'record-steps' });
  const labelsHost = h('ul', { class: 'plain-list record-labels', 'aria-label': COPY.lastStepsLabel });
  const buildHost = h('p', { class: 'muted', id: 'record-build', role: 'status' });
  const noteHost = h('p', { class: 'muted', id: 'record-note' });
  const actions = h('div', { class: 'run-bar' });
  const outcome = h('div', { class: 'record-outcome', id: 'record-outcome' });
  const stopError = h('div', { class: 'run-error', role: 'alert' });
  const channel = `recording-${Math.random().toString(36).slice(2)}`;
  const compileChannel = `compile-${channel}`;

  const panelNode = h(
    'section',
    { class: 'panel', 'aria-labelledby': 'record-panel-title' },
    h('h2', { class: 'panel-title', id: 'record-panel-title', text: COPY.stateLabel }),
    stateHost, countHost, labelsHost, buildHost, noteHost, lost, actions, stopError
  );
  root.append(panelNode, outcome);

  let stopped = false;
  let timer = 0;
  let sawConnected = false;
  let finalShown = false;
  const halt = () => {
    stopped = true;
    window.clearTimeout(timer);
    window.removeEventListener('hashchange', onHash);
  };
  function onHash() {
    if (!window.location.hash.startsWith('#/record')) halt();
  }
  window.addEventListener('hashchange', onHash);

  const stopButton = /** @type {HTMLButtonElement} */ (
    h('button', {
      type: 'button',
      class: 'btn btn-primary',
      id: 'record-stop',
      text: COPY.stop,
      onclick: async () => {
        stopError.replaceChildren();
        stopButton.disabled = true;
        stopButton.textContent = COPY.stopping;
        try {
          const { status } = await api.recordStop();
          if (status !== 202) stopError.replaceChildren(h('p', { text: COPY.stopFailed }));
        } catch {
          stopError.replaceChildren(h('p', { text: COPY.stopFailed }));
        } finally {
          stopButton.disabled = false;
          stopButton.textContent = COPY.stop;
          window.clearTimeout(timer);
          void tick();
        }
      },
    })
  );

  /** @param {any} s */
  const draw = async (s) => {
    const state = typeof s?.state === 'string' ? s.state : 'idle';
    stateHost.replaceChildren(h('span', { class: 'field-label inline', text: `${COPY.stateLabel}: ` }), pill(pillKind(state), statusText('recording', state)));
    countHost.textContent = state === 'idle' ? COPY.nothingRunning : `${COPY.stepsLabel}: ${stepCountText(s?.steps)}`;
    const labels = Array.isArray(s?.labels) ? s.labels.slice(-3) : [];
    labelsHost.replaceChildren(...(labels.length > 0 ? labels.map((l) => h('li', { text: String(l) })) : state === 'idle' ? [] : [h('li', { class: 'muted', text: COPY.noSteps })]));
    noteHost.textContent = typeof s?.sessionNote === 'string' ? s.sessionNote : '';
    announceOnChange(channel, state, announceText('recording', state));
    actions.replaceChildren(...(state === 'recording' ? [stopButton] : []));

    if (state === 'compiling') {
      try {
        const c = await api.compileStatus();
        buildHost.textContent = statusText('compile', c.state, c.phase ?? null);
        announceOnChange(compileChannel, `${c.state}:${c.phase ?? ''}`, announceText('compile', c.state, c.phase ?? null));
      } catch {
        // The recording state is the main signal
      }
    } else {
      buildHost.textContent = '';
    }

    if (!finalShown && (state === 'done' || state === 'error' || state === 'idle')) {
      if (state === 'idle') {
        outcome.replaceChildren(h('p', null, h('a', { href: href('overview'), text: COPY.backToOverview })));
        finalShown = true;
      } else if (state === 'done') {
        finalShown = true;
        const missing = missingSecretsOf(s);
        const tool = await newestToolName();
        outcome.replaceChildren(
          h('p', { text: COPY.doneLead }),
          h('p', { class: 'run-bar' },
            h('a', { class: 'btn btn-primary', id: 'test-it', href: tool ? href('playground', undefined, { tool }) : href('playground'), text: COPY.testIt }),
            ' ',
            h('a', { class: 'btn', href: href('credentials'), text: COPY.addCredentials })),
          ...(missing.length > 0 ? [credentialsBlock(missing)] : []),
          connectCard()
        );
        // The end sheet of the panel in the page asked for a next step: take it, the user does not click twice
        if (s?.intent === 'test') {
          /** @type {HTMLElement | null} */ (outcome.querySelector('#test-it'))?.click();
        } else if (s?.intent === 'kiro') {
          // The tool was added to Kiro by the Studio itself: say so, or say why not and leave the connect card to try again
          if (typeof s?.kiro?.message === 'string') {
            outcome.prepend(h('p', { id: 'kiro-result', class: s.kiro.added ? 'muted' : 'error-text', role: s.kiro.added ? 'status' : 'alert', text: s.kiro.message }));
          }
          scrollToKiroResult(outcome);
        }
      } else {
        finalShown = true;
        outcome.replaceChildren(
          h('div', { class: 'state error', role: 'alert' },
            h('p', { class: 'state-title', text: COPY.errorTitle }),
            h('p', { text: typeof s?.error === 'string' ? s.error : COPY.startFailed }),
            typeof s?.recoveryFile === 'string' && s.recoveryFile !== ''
              ? h('p', null, `${COPY.recoveryFile} `, h('code', { class: 'path', text: s.recoveryFile }))
              : null,
            h('p', null, h('a', { href: href('overview'), text: COPY.tryAgain })))
        );
      }
    }
  };

  async function tick() {
    if (root.isConnected) sawConnected = true;
    if (stopped || (sawConnected && !root.isConnected)) {
      halt();
      return;
    }
    let state = 'idle';
    try {
      const s = await api.recordStatus();
      lost.setAttribute('hidden', '');
      announceLostOnce.done = false;
      state = typeof s?.state === 'string' ? s.state : 'idle';
      await draw(s);
    } catch (err) {
      lost.removeAttribute('hidden');
      if (!(err instanceof ApiError)) console.warn(err);
      if (!announceLostOnce.done) {
        announceLostOnce.done = true;
        announce(COPY.connectionLost);
      }
      state = 'recording';
    }
    if (stopped) return;
    if (ACTIVE.has(state)) timer = window.setTimeout(() => void tick(), POLL_MS);
    else halt();
  }

  await tick();
  return root;
}
