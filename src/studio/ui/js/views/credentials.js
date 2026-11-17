// @ts-check
import { h } from '../dom.js';
import { api, ApiError } from '../api.js';
import { announce, pill } from '../components.js';
import { COPY, configuredText, displayName, kindWord, reasonFor } from '../copy.js';
import { demoScreen } from './demo.js';

export const REQUEST_TIMEOUT_MS = 10000;
const MIN_LENGTH = 3;

/**
 * Runs one credential request with a 10 second limit. Resolves `{ status }`, where 0 means no answer in time or no
 * connection. The submitted value is not part of any message.
 * @param {(signal: AbortSignal) => Promise<{ status: number, body: any }>} send
 */
async function withTimeout(send) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const { status } = await send(controller.signal);
    return { status };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { status: 401 };
    return { status: 0 };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * One row: name, kind, status, a masked input with its label, Save and (while configured) Remove.
 * @param {{ name: string, kind: string, configured: boolean }} secret
 * @param {number} index
 */
function credentialRow(secret, index) {
  const label = displayName(secret.name);
  const kind = secret.kind === 'totp' || secret.kind === 'token' ? secret.kind : 'password';
  const inputId = `secret-input-${index}`;
  const helpId = `secret-help-${index}`;
  const errorId = `secret-error-${index}`;
  let configured = secret.configured === true;
  let pending = false;

  const statusHost = h('span', { class: 'secret-status' });
  const input = /** @type {HTMLInputElement} */ (
    h('input', {
      id: inputId,
      class: 'input',
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-describedby': kind === 'totp' ? `${helpId} ${errorId}` : errorId,
    })
  );
  const error = h('p', { class: 'error-text', id: errorId, role: 'alert' });
  const saveButton = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-primary', text: COPY.save, dataset: { action: 'save' } }));
  const removeHost = h('span', { class: 'secret-remove' });
  const removeButton = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-quiet', text: COPY.remove, dataset: { action: 'remove' } }));
  removeButton.setAttribute('aria-label', `${COPY.remove} ${label}`);
  saveButton.setAttribute('aria-label', `${COPY.save} ${label}`);

  const refresh = () => {
    statusHost.replaceChildren(pill(configured ? 'pass' : 'fail', configuredText(configured)));
    saveButton.disabled = pending || input.value.length < MIN_LENGTH;
    removeButton.disabled = pending;
    removeHost.replaceChildren(...(configured ? [removeButton] : []));
  };
  input.addEventListener('input', refresh);

  saveButton.addEventListener('click', async () => {
    if (pending || input.value.length < MIN_LENGTH) return;
    const value = input.value;
    pending = true;
    error.textContent = '';
    saveButton.textContent = COPY.saving;
    refresh();
    let status = 0;
    try {
      ({ status } = await withTimeout((signal) => api.secretSave(secret.name, value, signal)));
    } finally {
      input.value = ''; // the value never stays in the page
      pending = false;
      saveButton.textContent = COPY.save;
    }
    if (status === 200) {
      configured = true;
      announce(`${label} saved`);
    } else {
      error.textContent = `${COPY.notSaved} ${reasonFor(status)}`;
    }
    refresh();
  });

  removeButton.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    error.textContent = '';
    removeButton.textContent = COPY.removing;
    refresh();
    let status = 0;
    try {
      ({ status } = await withTimeout((signal) => api.secretForget(secret.name, signal)));
    } finally {
      pending = false;
      removeButton.textContent = COPY.remove;
    }
    if (status === 200) {
      configured = false;
      announce(`${label} removed`);
    } else {
      error.textContent = `${COPY.notRemoved} ${reasonFor(status)}`;
    }
    refresh();
  });

  refresh();
  return h(
    'li',
    { class: 'secret-row panel', dataset: { secret: secret.name, kind } },
    h('div', { class: 'secret-head' }, h('strong', { class: 'secret-name', text: label }), ' ', h('span', { class: 'muted', text: kindWord(kind) }), ' ', statusHost),
    h('div', { class: 'pg-field' },
      h('label', { class: 'field-label', for: inputId, text: `${COPY.valueFor} ${label}` }),
      input,
      kind === 'totp' ? h('p', { class: 'muted small', id: helpId, text: COPY.totpHelp }) : null,
      error),
    h('div', { class: 'run-bar' }, saveButton, removeHost)
  );
}

/** @returns {Promise<HTMLElement>} */
export async function renderCredentials() {
  const demo = await demoScreen(COPY.credentialsTitle);
  if (demo !== null) return demo;

  const root = h('div', { class: 'view view-credentials' });
  root.append(h('h1', { class: 'view-title', tabindex: '-1', text: COPY.credentialsTitle }), h('p', { class: 'view-lead', text: COPY.credentialsLead }));
  const host = h('div', { class: 'credentials-host' });
  root.append(host);

  const load = async () => {
    host.replaceChildren(h('p', { class: 'state loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), COPY.checking));
    try {
      const answer = await api.secrets();
      const secrets = Array.isArray(answer?.secrets) ? answer.secrets : [];
      if (secrets.length === 0) {
        host.replaceChildren(h('p', { class: 'state empty', id: 'no-credentials', text: COPY.none }));
        return;
      }
      host.replaceChildren(h('ul', { class: 'plain-list secret-list' }, ...secrets.map((s, i) => credentialRow(s, i))));
    } catch {
      host.replaceChildren(
        h('div', { class: 'state error', role: 'alert' },
          h('p', { text: COPY.loadFailed }),
          h('button', { type: 'button', class: 'btn', id: 'credentials-retry', text: COPY.retry, onclick: () => void load() }))
      );
    }
  };
  await load();
  return root;
}
