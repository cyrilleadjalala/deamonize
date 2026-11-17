// @ts-check
import { h } from '../dom.js';
import { api, ApiError } from '../api.js';
import { announce, chip, copyButton } from '../components.js';
import { COPY } from '../copy.js';
import { openDialog } from '../dialog.js';
import { href } from '../router.js';

/** A file path or folder, in the one element the plain-language lint skips. @param {string} text */
const path = (text) => h('code', { class: 'path', text });

/** What a failed request says: the action that failed, the server's plain reason when it has one. No value is ever shown. */
function failure(actionFailed, answer, err) {
  const reason = err ? (err instanceof ApiError && err.status !== 0 ? err.message : COPY.unreachable) : typeof answer?.error === 'string' ? answer.error : null;
  return [h('p', { text: actionFailed }), reason ? h('p', { class: 'muted', text: reason }) : null];
}

/** @param {unknown} scope */
const scopeWord = (scope) => (scope === 'global' ? COPY.scopeGlobal : COPY.scopeProject);

/**
 * "Connect to Kiro": a choice of scope, a preview dialog that shows the exact folder, every file with its outcome and
 * the backup statement, a success screen, removal, "Copy MCP configuration", and the "Add as a Kiro Power instead"
 * option (which writes nothing).
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
  let scope = info.kiroHomeExists === true ? 'global' : 'project';

  // ----- scope choice: two exclusive radios, one always selected ------------------------------------------------
  const radio = (value, label) =>
    h('label', { class: 'connect-choice', for: `connect-scope-${value}` },
      h('input', { type: 'radio', name: 'connect-scope', id: `connect-scope-${value}`, value, checked: scope === value, onchange: () => select(value) }),
      ' ', label);
  const scopeSet = h('fieldset', { class: 'connect-scope', id: 'connect-scope' },
    h('legend', { text: COPY.scopeLegend }),
    radio('global', COPY.scopeGlobal),
    radio('project', COPY.scopeProject));
  const globalSlot = h('div', { class: 'connect-global', id: 'connect-global' });
  const folderSlot = h('div', { class: 'connect-folder' });

  const folder = /** @type {HTMLInputElement} */ (
    h('input', { id: 'connect-folder', class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', value: typeof info.defaultWorkspace === 'string' ? info.defaultWorkspace : '', 'aria-describedby': 'connect-folder-help connect-error' })
  );
  const folderField = h('div', { class: 'pg-field' },
    h('label', { class: 'field-label', for: 'connect-folder', text: COPY.folderLabel }),
    folder,
    h('p', { class: 'muted small', id: 'connect-folder-help', text: COPY.folderHelp }));
  const error = h('div', { class: 'run-error', id: 'connect-error', role: 'alert' });
  const connect = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-primary', id: 'connect-btn', text: COPY.connectButton }));

  /** @param {string} value */
  function select(value) {
    scope = value;
    globalSlot.replaceChildren(...(scope === 'global' ? [h('p', { class: 'notice', role: 'note', text: COPY.scopeGlobalSentence })] : []));
    folderSlot.replaceChildren(...(scope === 'project' ? [folderField] : []));
    error.replaceChildren();
  }
  select(scope);

  // ----- auto-add: off unless a saved consent says otherwise ------------------------------------------------------
  const autoAdd = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'connect-auto-add', 'aria-describedby': 'connect-auto-add-help' }));
  const autoAddNote = h('p', { class: 'muted small', id: 'connect-auto-add-note' });
  const autoAddRow = h('div', { class: 'pg-field connect-auto-add' },
    h('label', { for: 'connect-auto-add' }, autoAdd, ' ', COPY.autoAddLabel),
    h('p', { class: 'muted small', id: 'connect-auto-add-help', text: COPY.autoAddHelp }),
    autoAddNote);
  api
    .powerAutoAdd()
    .then((state) => {
      if (state?.enabled === true) autoAdd.checked = true;
      if (state?.writable === false) autoAddNote.textContent = COPY.autoAddNotSaved;
    })
    .catch(() => {});

  // ----- installed copies and removal ---------------------------------------------------------------------------
  const installs = h('div', { class: 'connect-installs', id: 'connect-installs' });
  /** @param {any[]} list */
  function showInstalls(list) {
    if (!Array.isArray(list) || list.length === 0) {
      installs.replaceChildren();
      return;
    }
    installs.replaceChildren(
      h('p', { text: COPY.removeLead }),
      h('ul', { class: 'plain-list' },
        ...list.map((entry) => {
          const button = h('button', { type: 'button', class: 'btn btn-quiet connect-remove', dataset: { scope: entry.scope }, text: COPY.removeButton });
          button.addEventListener('click', () => showRemove(entry, button, refresh));
          return h('li', { dataset: { scope: entry.scope } }, h('span', { text: scopeWord(entry.scope) }), ' ', path(String(entry.kiroPath ?? '')), ' ', button);
        })));
  }
  async function refresh() {
    try {
      showInstalls((await api.powerInfo())?.installs);
    } catch {
      // The list stays as it was
    }
  }
  showInstalls(info.installs);

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
    if (scope === 'project' && workspacePath === '') {
      folder.setAttribute('aria-invalid', 'true');
      error.replaceChildren(h('p', { text: COPY.folderHelp }));
      folder.focus();
      return;
    }
    folder.removeAttribute('aria-invalid');
    connect.disabled = true;
    connect.textContent = COPY.checking;
    const chosen = scope;
    try {
      const { status, body: answer } = await api.powerPreview(chosen, workspacePath);
      if (status !== 200) {
        error.replaceChildren(...failure(COPY.previewFailed, answer));
        return;
      }
      showPreview(answer, chosen, autoAdd.checked, connect, refresh);
    } catch (err) {
      error.replaceChildren(...failure(COPY.previewFailed, null, err));
    } finally {
      connect.disabled = false;
      connect.textContent = COPY.connectButton;
    }
  });

  body.replaceChildren(
    h('p', { text: COPY.connectLead }),
    scopeSet,
    globalSlot,
    folderSlot,
    autoAddRow,
    error,
    h('div', { class: 'run-bar' }, connect, copyHost, powerButton),
    powerDetails,
    installs
  );
}

/**
 * The confirmation dialog. Cancel and Escape close it without any install request.
 * @param {any} preview the answer of `POST /api/power/preview`
 * @param {string} scope
 * @param {boolean} wantsAutoAdd
 * @param {HTMLElement} opener
 * @param {() => Promise<void>} refresh
 */
function showPreview(preview, scope, wantsAutoAdd, opener, refresh) {
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
    h('p', { class: 'connect-backup', text: preview.backup === true ? COPY.backupYes : COPY.backupNone }),
    error,
    h('div', { class: 'run-bar' }, confirm, cancel),
  ].filter((n) => n !== null);

  dialog = openDialog({ title: COPY.dialogTitle, content: /** @type {Node[]} */ (content), opener });

  confirm.addEventListener('click', async () => {
    error.replaceChildren();
    confirm.disabled = true;
    confirm.textContent = COPY.installing;
    try {
      const { status, body } = await api.powerInstall(preview.confirmationId, preview.kiroPath, scope, wantsAutoAdd);
      if (status !== 200) {
        error.replaceChildren(...failure(COPY.installFailed, body));
        return;
      }
      showSuccess(dialog, preview, body, wantsAutoAdd);
      refresh();
    } catch (err) {
      error.replaceChildren(...failure(COPY.installFailed, null, err));
    } finally {
      confirm.disabled = false;
      confirm.textContent = COPY.confirm;
    }
  });
}

/** @param {ReturnType<typeof openDialog>} dialog @param {any} preview @param {any} result @param {boolean} wantsAutoAdd */
function showSuccess(dialog, preview, result, wantsAutoAdd) {
  const written = Array.isArray(result?.written) ? result.written : [];
  const placeholders = Array.isArray(result?.placeholders) ? result.placeholders : [];
  // Names only, never a value. The preview already carried the names; the install answer is the later truth
  const missing = Array.isArray(result?.missingSecrets) ? result.missingSecrets : Array.isArray(preview?.missingSecrets) ? preview.missingSecrets : [];
  const closeButton = h('button', { type: 'button', class: 'btn btn-primary', id: 'connect-close', text: COPY.close, onclick: () => dialog.close() });
  dialog.element.querySelector('.dialog-title')?.replaceChildren(COPY.connectedTitle);
  dialog.setContent(
    h('p', { text: COPY.connectedLead }),
    h('ul', { class: 'plain-list' }, ...written.map((p) => h('li', null, path(String(p))))),
    placeholders.length > 0
      ? h('div', { class: 'connect-placeholders' }, h('p', { text: COPY.placeholdersLead }), h('ul', { class: 'plain-list' }, ...placeholders.map((n) => h('li', null, chip(String(n), 'secret')))))
      : h('p', { class: 'muted', text: COPY.noPlaceholders }),
    missing.length > 0
      ? h('div', { class: 'notice connect-missing', role: 'note' },
          h('p', { text: COPY.missingLead }),
          h('ul', { class: 'plain-list' }, ...missing.map((n) => h('li', null, chip(String(n), 'secret')))),
          h('a', { href: href('credentials'), text: COPY.missingLink, onclick: () => dialog.close() }))
      : null,
    wantsAutoAdd && result?.autoAddSaved === false ? h('p', { class: 'muted', text: COPY.autoAddNotSaved }) : null,
    h('p', { class: 'connect-reload', text: COPY.connectedReload }),
    h('div', { class: 'run-bar' }, closeButton)
  );
  announce(COPY.connectedTitle);
  closeButton.focus();
}

/**
 * Confirmation, then removal of one install. A failure keeps the dialog open.
 * @param {any} entry an item of `info.installs`
 * @param {HTMLElement} opener
 * @param {() => Promise<void>} refresh
 */
function showRemove(entry, opener, refresh) {
  const error = h('div', { class: 'run-error', role: 'alert' });
  const confirm = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-primary', id: 'connect-remove-confirm', text: COPY.removeConfirm }));
  /** @type {ReturnType<typeof openDialog>} */
  let dialog;
  const cancel = h('button', { type: 'button', class: 'btn btn-quiet', id: 'connect-remove-cancel', text: COPY.cancel, onclick: () => dialog.close() });
  dialog = openDialog({
    title: COPY.removeButton,
    opener,
    content: [h('p', { text: COPY.removeConfirmLead }), h('p', null, path(String(entry.kiroPath ?? ''))), error, h('div', { class: 'run-bar' }, confirm, cancel)],
  });
  confirm.addEventListener('click', async () => {
    error.replaceChildren();
    confirm.disabled = true;
    confirm.textContent = COPY.removing;
    try {
      const { status, body } = await api.powerRemove(entry.scope);
      if (status !== 200) {
        error.replaceChildren(...failure(COPY.removeFailed, body));
        return;
      }
      const removed = Array.isArray(body?.removed) ? body.removed : [];
      const closeButton = h('button', { type: 'button', class: 'btn btn-primary', id: 'connect-close', text: COPY.close, onclick: () => dialog.close() });
      dialog.element.querySelector('.dialog-title')?.replaceChildren(COPY.removedTitle);
      dialog.setContent(
        removed.length > 0 ? h('p', { text: COPY.removedLead }) : h('p', { text: COPY.removeNothing }),
        h('ul', { class: 'plain-list' }, ...removed.map((p) => h('li', null, path(String(p))))),
        h('p', { class: 'connect-reload', text: COPY.connectedReload }),
        h('div', { class: 'run-bar' }, closeButton)
      );
      announce(COPY.removedTitle);
      closeButton.focus();
      refresh();
    } catch (err) {
      error.replaceChildren(...failure(COPY.removeFailed, null, err));
    } finally {
      confirm.disabled = false;
      confirm.textContent = COPY.removeConfirm;
    }
  });
}
