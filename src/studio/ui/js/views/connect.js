// @ts-check
import { h } from '../dom.js';
import { api, ApiError } from '../api.js';
import { announce, chip, copyButton } from '../components.js';
import { COPY } from '../copy.js';
import { openDialog } from '../dialog.js';

/** A file path or folder, in the one element the plain-language lint skips. @param {string} text */
const path = (text) => h('code', { class: 'path', text });

/**
 * "Connect to Kiro": a folder field, a preview dialog that shows the exact folder and every file with its outcome, a
 * success screen, "Copy MCP configuration", and the "Add as a Kiro Power instead" option (which writes nothing).
 * @returns {HTMLElement}
 */
export function connectCard() {
  const root = h('section', { class: 'panel connect-card', 'aria-labelledby': 'connect-title', id: 'connect-card' });
  root.append(h('h3', { class: 'panel-title', id: 'connect-title', text: COPY.connectTitle }));
  const body = h('div', { class: 'connect-body' }, h('p', { class: 'muted', text: COPY.checking, role: 'status' }));
  root.append(body);
  load(body).catch(() => {
    body.replaceChildren(h('p', { class: 'error-text', role: 'alert', text: COPY.notBuilt }));
  });
  return root;
}

/** @param {HTMLElement} body */
async function load(body) {
  const info = await api.powerInfo();
  if (info?.available !== true) {
    body.replaceChildren(h('p', { class: 'muted', text: COPY.notBuilt }));
    return;
  }
  const folder = /** @type {HTMLInputElement} */ (
    h('input', { id: 'connect-folder', class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', value: typeof info.defaultWorkspace === 'string' ? info.defaultWorkspace : '', 'aria-describedby': 'connect-folder-help connect-error' })
  );
  const error = h('div', { class: 'run-error', id: 'connect-error', role: 'alert' });
  const connect = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-primary', id: 'connect-btn', text: COPY.connectButton }));

  // The copy button needs its text now: the snippet is fetched ahead of the click
  const copyHost = h('span', { class: 'connect-copy' });
  api
    .powerSnippet()
    .then((answer) => {
      if (typeof answer?.snippet === 'string') {
        const button = copyButton(answer.snippet, COPY.copyMcp, { text: COPY.copyMcp });
        button.classList.remove('btn-small');
        button.addEventListener('click', () => announce(COPY.copyMcpDone));
        copyHost.replaceChildren(button);
      }
    })
    .catch(() => copyHost.replaceChildren(h('span', { class: 'muted small', text: COPY.copyMcpFailed })));

  const powerDetails = h('div', { class: 'connect-power', hidden: true, id: 'connect-power' });
  const powerButton = h('button', {
    type: 'button',
    class: 'btn btn-quiet',
    'aria-expanded': 'false',
    'aria-controls': 'connect-power',
    text: COPY.powerInstead,
    onclick: () => {
      const open = powerDetails.hasAttribute('hidden');
      if (open) powerDetails.removeAttribute('hidden');
      else powerDetails.setAttribute('hidden', '');
      powerButton.setAttribute('aria-expanded', String(open));
    },
  });
  powerDetails.append(
    h('p', { text: COPY.powerLead }),
    h('p', null, path(typeof info.outputPath === 'string' ? info.outputPath : '')),
    h('ol', null, h('li', { text: COPY.powerSteps1 }), h('li', { text: COPY.powerSteps2 }), h('li', { text: COPY.powerSteps3 }))
  );

  connect.addEventListener('click', async () => {
    error.replaceChildren();
    const workspacePath = folder.value.trim();
    if (workspacePath === '') {
      folder.setAttribute('aria-invalid', 'true');
      error.replaceChildren(h('p', { text: COPY.folderHelp }));
      folder.focus();
      return;
    }
    folder.removeAttribute('aria-invalid');
    connect.disabled = true;
    connect.textContent = COPY.checking;
    try {
      const { status, body: answer } = await api.powerPreview(workspacePath);
      if (status !== 200) {
        error.replaceChildren(h('p', { text: typeof answer?.error === 'string' ? answer.error : COPY.previewFailed }));
        return;
      }
      showPreview(answer, connect);
    } catch (err) {
      error.replaceChildren(h('p', { text: err instanceof ApiError && err.status !== 0 ? err.message : COPY.unreachable }));
    } finally {
      connect.disabled = false;
      connect.textContent = COPY.connectButton;
    }
  });

  body.replaceChildren(
    h('p', { text: COPY.connectLead }),
    h('div', { class: 'pg-field' },
      h('label', { class: 'field-label', for: 'connect-folder', text: COPY.folderLabel }),
      folder,
      h('p', { class: 'muted small', id: 'connect-folder-help', text: COPY.folderHelp })),
    error,
    h('div', { class: 'run-bar' }, connect, copyHost, powerButton),
    powerDetails
  );
}

/**
 * The confirmation dialog. Cancel and Escape close it without any install request.
 * @param {any} preview the answer of `POST /api/power/preview`
 * @param {HTMLElement} opener
 */
function showPreview(preview, opener) {
  const files = Array.isArray(preview.files) ? preview.files : [];
  const error = h('div', { class: 'run-error', role: 'alert' });
  const confirm = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-primary', id: 'connect-confirm', text: COPY.confirm }));
  /** @type {ReturnType<typeof openDialog>} */
  let dialog;
  const cancel = h('button', { type: 'button', class: 'btn btn-quiet', id: 'connect-cancel', text: COPY.cancel, onclick: () => dialog.close() });
  const outcomeWord = (o) => (o === 'merge' ? COPY.outcomeMerge : o === 'replace' ? COPY.outcomeReplace : COPY.outcomeCreate);

  const content = [
    h('p', { text: COPY.dialogLead }),
    h('p', null, path(String(preview.kiroPath ?? ''))),
    h('ul', { class: 'plain-list connect-files' },
      ...files.map((f) => h('li', { dataset: { outcome: f.outcome } }, h('span', { class: 'outcome', text: outcomeWord(f.outcome) }), ' ', path(String(f.path))))),
    preview.replacesEntry === true ? h('p', { class: 'notice', role: 'note', text: COPY.replaceNotice }) : null,
    error,
    h('div', { class: 'run-bar' }, confirm, cancel),
  ].filter((n) => n !== null);

  dialog = openDialog({ title: COPY.dialogTitle, content: /** @type {Node[]} */ (content), opener });

  confirm.addEventListener('click', async () => {
    error.replaceChildren();
    confirm.disabled = true;
    confirm.textContent = COPY.installing;
    try {
      const { status, body } = await api.powerInstall(preview.confirmationId, preview.kiroPath);
      if (status !== 200) {
        error.replaceChildren(h('p', { text: typeof body?.error === 'string' ? body.error : COPY.installFailed }));
        return;
      }
      showSuccess(dialog, body);
    } catch (err) {
      error.replaceChildren(h('p', { text: err instanceof ApiError && err.status !== 0 ? err.message : COPY.unreachable }));
    } finally {
      confirm.disabled = false;
      confirm.textContent = COPY.confirm;
    }
  });
}

/** @param {ReturnType<typeof openDialog>} dialog @param {any} result */
function showSuccess(dialog, result) {
  const written = Array.isArray(result?.written) ? result.written : [];
  const placeholders = Array.isArray(result?.placeholders) ? result.placeholders : [];
  const closeButton = h('button', { type: 'button', class: 'btn btn-primary', id: 'connect-close', text: COPY.close, onclick: () => dialog.close() });
  dialog.element.querySelector('.dialog-title')?.replaceChildren(COPY.connectedTitle);
  dialog.setContent(
    h('p', { text: COPY.connectedLead }),
    h('ul', { class: 'plain-list' }, ...written.map((p) => h('li', null, path(String(p))))),
    placeholders.length > 0
      ? h('div', { class: 'connect-placeholders' }, h('p', { text: COPY.placeholdersLead }), h('ul', { class: 'plain-list' }, ...placeholders.map((n) => h('li', null, chip(String(n), 'secret')))))
      : h('p', { class: 'muted', text: COPY.noPlaceholders }),
    h('div', { class: 'run-bar' }, closeButton)
  );
  announce(COPY.connectedTitle);
  closeButton.focus();
}
