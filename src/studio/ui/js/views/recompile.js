// @ts-check
import { h } from '../dom.js';
import { api, ApiError } from '../api.js';
import { announce } from '../components.js';
import { announceOnChange } from '../announcer.js';
import { COPY, announceText, statusText } from '../copy.js';
import { COPY_COMPILE } from '../copy-compile.js';

/**
 * The "Advanced options" group: two checkboxes, both unchecked until `apply` gives the modes of the compiled output.
 * @returns {{ element: HTMLElement, body: () => { http: 'off' | 'auto', healSupport: boolean }, apply: (target: any) => void }}
 */
function advancedOptions() {
  const http = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'opt-http', 'aria-describedby': 'opt-http-note' }));
  const heal = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'opt-heal', 'aria-describedby': 'opt-heal-note' }));
  const httpNote = h('p', { class: 'option-note muted', id: 'opt-http-note', text: COPY_COMPILE.httpNote });
  const healNote = h('p', { class: 'option-note muted', id: 'opt-heal-note', text: COPY_COMPILE.healNote });
  const terminalNote = h('p', { class: 'option-note muted', id: 'opt-terminal-note', text: COPY_COMPILE.terminalNote });
  http.checked = false;
  heal.checked = false;
  httpNote.hidden = true;
  healNote.hidden = true;
  terminalNote.hidden = true;
  const sync = () => {
    httpNote.hidden = !http.checked;
    healNote.hidden = !heal.checked;
  };
  http.addEventListener('change', sync);
  heal.addEventListener('change', sync);
  const element = h(
    'fieldset',
    { class: 'advanced-options', id: 'advanced-options' },
    h('legend', { text: COPY_COMPILE.advancedTitle }),
    h('label', { class: 'option-row' }, http, h('span', { text: COPY_COMPILE.optionHttp })),
    httpNote,
    h('label', { class: 'option-row' }, heal, h('span', { text: COPY_COMPILE.optionHeal })),
    healNote,
    terminalNote
  );
  return {
    element,
    body: () => ({ http: http.checked && !http.disabled ? 'auto' : 'off', healSupport: heal.checked && !heal.disabled }),
    apply: (target) => {
      const terminal = target?.type === 'terminal';
      http.disabled = terminal;
      heal.disabled = terminal;
      http.checked = !terminal && (target?.modes?.http === 'auto' || target?.modes?.http === true);
      heal.checked = !terminal && target?.modes?.healSupport === true;
      terminalNote.hidden = !terminal;
      sync();
    },
  };
}

/**
 * The "Recompile" button: sends one build request and follows `GET /api/compile/status` until it ends, announcing each
 * change of state once. Hidden by the caller in the static demo and in sample mode.
 * @param {{ target?: any, onDone?: () => (void | Promise<void>) }} [opts] the first target (sets the checkboxes) and what to do when a build ends in `done`
 * @returns {HTMLElement & { applyTarget?: (target: any) => void }}
 */
export function recompileControl(opts = {}) {
  const status = h('p', { class: 'muted', id: 'rebuild-status', role: 'status' });
  const error = h('div', { class: 'run-error', role: 'alert' });
  const button = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn', id: 'rebuild-btn', text: COPY.rebuild }));
  const options = advancedOptions();
  options.apply(opts.target);
  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const channel = `rebuild-${Math.random().toString(36).slice(2)}`;

  button.addEventListener('click', async () => {
    button.disabled = true;
    error.replaceChildren();
    try {
      const { status: code, body } = await api.compileStart(options.body());
      if (code !== 202 && code !== 409) {
        error.replaceChildren(h('p', { text: typeof body?.error === 'string' ? body.error : COPY.rebuildFailed }));
        return;
      }
      for (;;) {
        const s = await api.compileStatus();
        const key = `${s.state}:${s.phase ?? ''}`;
        status.textContent = statusText('compile', s.state, s.phase ?? null);
        announceOnChange(channel, key, announceText('compile', s.state, s.phase ?? null));
        if (s.state === 'done') {
          try {
            await opts.onDone?.();
          } catch {
            // A failed refresh of the flags does not change the build result
          }
          break;
        }
        if (s.state === 'error') {
          error.replaceChildren(h('p', { text: typeof s.error === 'string' ? s.error : COPY.rebuildFailed }));
          break;
        }
        if (!button.isConnected) break;
        await wait(1500);
      }
    } catch (err) {
      error.replaceChildren(h('p', { text: err instanceof ApiError && err.status !== 0 ? COPY.rebuildFailed : COPY.unreachable }));
      announce(COPY.rebuildFailed);
    } finally {
      button.disabled = false;
    }
  });
  const root = /** @type {HTMLElement & { applyTarget?: (target: any) => void }} */ (h('div', { class: 'rebuild' }, options.element, button, status, error));
  root.applyTarget = options.apply;
  return root;
}
