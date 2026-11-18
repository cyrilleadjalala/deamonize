// @ts-check
import { h } from '../dom.js';
import { api, ApiError } from '../api.js';
import { announce } from '../components.js';
import { COPY } from '../copy.js';
import { foreignOriginText } from '../copy-record.js';
import { applicationKey, validateName, validateUrl } from '../validate.js';

/**
 * The "+ New action" button and the inline form it opens. Cancel closes the form without any request and gives focus
 * back to the button. A valid submit sends one start request with the name, the address and the reuse choice, then
 * goes to the status screen. Every error keeps what the user typed.
 * @param {{ primary?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function newActionSection(options = {}) {
  const host = h('div', { class: 'new-action' });
  const button = /** @type {HTMLButtonElement} */ (
    h('button', { type: 'button', class: options.primary ? 'btn btn-primary' : 'btn', id: 'new-action-btn', 'aria-expanded': 'false', 'aria-controls': 'new-action-form', text: COPY.newAction })
  );
  const formHost = h('div', { class: 'new-action-host' });
  host.append(button, formHost);

  const close = () => {
    formHost.replaceChildren();
    button.setAttribute('aria-expanded', 'false');
    button.hidden = false;
    button.focus();
  };

  button.addEventListener('click', () => {
    if (formHost.firstChild) {
      /** @type {HTMLElement | null} */ (formHost.querySelector('#action-name'))?.focus();
      return;
    }
    button.setAttribute('aria-expanded', 'true');
    formHost.append(buildForm(close));
    /** @type {HTMLElement | null} */ (formHost.querySelector('#action-name'))?.focus();
  });
  return host;
}

/** @param {() => void} onCancel */
function buildForm(onCancel) {
  const nameInput = /** @type {HTMLInputElement} */ (
    h('input', { id: 'action-name', name: 'name', class: 'input', type: 'text', autocomplete: 'off', 'aria-describedby': 'action-name-help action-name-error', maxlength: '400' })
  );
  const urlInput = /** @type {HTMLInputElement} */ (
    h('input', { id: 'action-url', name: 'url', class: 'input', type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'action-url-help action-url-error', maxlength: '4096' })
  );
  const reuse = /** @type {HTMLInputElement} */ (h('input', { id: 'reuse-session', name: 'reuseSession', type: 'checkbox', 'aria-describedby': 'reuse-hint' }));
  const nameError = h('p', { class: 'error-text', id: 'action-name-error', role: 'alert' });
  const urlError = h('p', { class: 'error-text', id: 'action-url-error', role: 'alert' });
  const hint = h('p', { class: 'muted small', id: 'reuse-hint', role: 'status', text: COPY.hintNoSession });
  const formError = h('div', { class: 'run-error', role: 'alert' });
  const submit = /** @type {HTMLButtonElement} */ (h('button', { type: 'submit', class: 'btn btn-primary', id: 'start-recording', text: COPY.startRecording }));
  const cancel = h('button', { type: 'button', class: 'btn btn-quiet', id: 'cancel-action', text: COPY.cancel, onclick: onCancel });

  const form = h(
    'form',
    { class: 'new-action-form panel', id: 'new-action-form', novalidate: true, 'aria-labelledby': 'new-action-title' },
    h('h2', { class: 'panel-title', id: 'new-action-title', text: COPY.newActionTitle }),
    h('div', { class: 'pg-field' },
      h('label', { class: 'field-label', for: 'action-name', text: COPY.nameLabel }),
      nameInput,
      h('p', { class: 'muted small', id: 'action-name-help', text: COPY.nameHelp }),
      nameError),
    h('div', { class: 'pg-field' },
      h('label', { class: 'field-label', for: 'action-url', text: COPY.urlLabel }),
      urlInput,
      h('p', { class: 'muted small', id: 'action-url-help', text: COPY.urlHelp }),
      urlError),
    h('div', { class: 'pg-field pg-field-check' },
      h('div', null, reuse, ' ', h('label', { class: 'field-label inline', for: 'reuse-session', text: COPY.reuseLabel })),
      hint),
    formError,
    h('div', { class: 'run-bar' }, submit, cancel)
  );

  /** @param {HTMLInputElement} input @param {HTMLElement} slot @param {string} message */
  const mark = (input, slot, message) => {
    slot.textContent = message;
    input.setAttribute('aria-invalid', 'true');
  };
  const unmark = () => {
    for (const [input, slot] of /** @type {Array<[HTMLInputElement, HTMLElement]>} */ ([[nameInput, nameError], [urlInput, urlError]])) {
      slot.textContent = '';
      input.removeAttribute('aria-invalid');
    }
    formError.replaceChildren();
  };

  // The saved-session hint: only the Application_Key (an origin) is sent, 400 ms after the last change
  let hintTimer = 0;
  let hintToken = 0;
  const updateHint = () => {
    window.clearTimeout(hintTimer);
    const token = ++hintToken;
    const checked = validateUrl(urlInput.value);
    const key = checked.ok ? applicationKey(checked.value) : undefined;
    if (key === undefined) {
      hint.textContent = COPY.hintNoSession;
      return;
    }
    hintTimer = window.setTimeout(async () => {
      hint.textContent = COPY.hintChecking;
      try {
        const answer = await api.sessionFor(key);
        if (token !== hintToken) return;
        hint.textContent = answer?.available === true ? COPY.hintSession : COPY.hintNoSession;
      } catch {
        if (token === hintToken) hint.textContent = COPY.hintNoSession;
      }
    }, 400);
  };
  urlInput.addEventListener('input', updateHint);
  let pending = false;

  // Another application than the one this folder holds: the message shows 300 ms after the last keystroke and the start button waits
  const ORIGIN_MS = 300;
  const URL_DESCRIBED_BY = 'action-url-help action-url-error';
  /** @type {string | undefined} */
  let heldOrigin;
  /** @type {HTMLElement | null} */
  let originNote = null;
  let originTimer = 0;
  /** @param {unknown} value @returns {string | undefined} */
  const originOf = (value) => {
    if (typeof value !== 'string') return undefined;
    try {
      const origin = new URL(value.trim()).origin;
      return origin === 'null' ? undefined : origin;
    } catch {
      return undefined;
    }
  };
  const checkOrigin = () => {
    const wanted = originOf(urlInput.value);
    const foreign = heldOrigin !== undefined && wanted !== undefined && wanted !== heldOrigin;
    if (foreign && heldOrigin !== undefined) {
      if (originNote === null) {
        originNote = h('p', { class: 'error-text action-url-origin', id: 'action-url-origin', role: 'alert' });
        urlError.after(originNote);
      }
      originNote.textContent = foreignOriginText(heldOrigin);
      urlInput.setAttribute('aria-describedby', `${URL_DESCRIBED_BY} action-url-origin`);
    } else if (originNote !== null) {
      originNote.remove();
      originNote = null;
      urlInput.setAttribute('aria-describedby', URL_DESCRIBED_BY);
    }
    submit.disabled = pending || originNote !== null;
  };
  urlInput.addEventListener('input', () => {
    window.clearTimeout(originTimer);
    originTimer = window.setTimeout(checkOrigin, ORIGIN_MS);
  });
  api
    .overviewFresh()
    .then((overview) => {
      const target = overview?.targets?.[0];
      if (target !== undefined && (target.type === undefined || target.type === 'web') && Number(target.workflows) >= 1) heldOrigin = originOf(target.start);
      if (heldOrigin !== undefined) checkOrigin();
    })
    .catch(() => undefined);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (pending || originNote !== null) return;
    unmark();
    const name = validateName(nameInput.value);
    const url = validateUrl(urlInput.value);
    /** @type {HTMLInputElement[]} */
    const invalid = [];
    if (!name.ok) {
      mark(nameInput, nameError, name.message);
      invalid.push(nameInput);
    }
    if (!url.ok) {
      mark(urlInput, urlError, url.message);
      invalid.push(urlInput);
    }
    if (invalid.length > 0 || !name.ok || !url.ok) {
      invalid[0].focus();
      announce(invalid.length > 1 ? 'Two fields need attention' : 'One field needs attention');
      return;
    }
    pending = true;
    submit.disabled = true;
    submit.textContent = COPY.starting;
    try {
      const { status, body } = await api.recordStart({ name: name.value, url: url.value, reuseSession: reuse.checked });
      if (status === 202) {
        window.location.hash = '#/record';
        return;
      }
      const message = typeof body?.error === 'string' ? body.error : COPY.startFailed;
      if (status === 400 && body?.field === 'name') {
        mark(nameInput, nameError, message);
        nameInput.focus();
      } else if ((status === 400 || status === 409) && body?.field === 'url') {
        mark(urlInput, urlError, message);
        urlInput.focus();
      } else {
        formError.replaceChildren(h('p', { class: 'state-title', text: COPY.startFailed }), h('p', { text: message }));
      }
    } catch (err) {
      formError.replaceChildren(h('p', { text: err instanceof ApiError && err.status !== 0 ? err.message : COPY.unreachable }));
    } finally {
      pending = false;
      submit.disabled = originNote !== null;
      submit.textContent = COPY.startRecording;
    }
  });
  return form;
}
