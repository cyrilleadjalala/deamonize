// @ts-check
import { h } from '../dom.js';
import { api, ApiError } from '../api.js';
import { announce } from '../components.js';
import { announceOnChange } from '../announcer.js';
import { COPY, announceText, statusText } from '../copy.js';

/**
 * The "Recompile" button: sends one build request and follows `GET /api/compile/status` until it ends, announcing each
 * change of state once. Hidden by the caller in the static demo and in sample mode.
 * @returns {HTMLElement}
 */
export function recompileControl() {
  const status = h('p', { class: 'muted', id: 'rebuild-status', role: 'status' });
  const error = h('div', { class: 'run-error', role: 'alert' });
  const button = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn', id: 'rebuild-btn', text: COPY.rebuild }));
  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const channel = `rebuild-${Math.random().toString(36).slice(2)}`;

  button.addEventListener('click', async () => {
    button.disabled = true;
    error.replaceChildren();
    try {
      const { status: code, body } = await api.compileStart();
      if (code !== 202 && code !== 409) {
        error.replaceChildren(h('p', { text: typeof body?.error === 'string' ? body.error : COPY.rebuildFailed }));
        return;
      }
      for (;;) {
        const s = await api.compileStatus();
        const key = `${s.state}:${s.phase ?? ''}`;
        status.textContent = statusText('compile', s.state, s.phase ?? null);
        announceOnChange(channel, key, announceText('compile', s.state, s.phase ?? null));
        if (s.state === 'done') break;
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
  return h('div', { class: 'rebuild' }, button, status, error);
}
