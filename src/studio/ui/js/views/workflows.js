// @ts-check
import { h } from '../dom.js';
import { api, invalidate, isDemo } from '../api.js';
import { announce, chip, emptyState, levelBadge, levelLegend, panel, riskBadge, toolName, varChip } from '../components.js';
import { COPY } from '../copy.js';
import { COPY_EDITOR as ED } from '../copy-editor.js';
import { openDialog } from '../dialog.js';
import { applicationKey } from '../validate.js';
import { WEB_LEVELS } from '../levels.js';
import { href } from '../router.js';
import { secretsSection } from '../secrets-view.js';

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

/**
 * Which steps write. Nothing for a read-only workflow or when the server sent no `writeSteps`.
 * Step numbers (index + 1) and labels only.
 * @param {any} wf
 */
function writeNote(wf) {
  const steps = Array.isArray(wf.writeSteps) ? wf.writeSteps : [];
  if (steps.length === 0 || wf.writeSummary === 'none') return null;
  return h('div', { class: 'write-note', role: 'note', dataset: { writeSummary: wf.writeSummary === 'login-only' ? 'login-only' : 'actions' } },
    h('p', { text: wf.writeSummary === 'login-only'
      ? `The only write is the login form: step ${steps[0].index + 1}, \u201C${steps[0].label}\u201D. The other steps only read.`
      : `Writes data in ${steps.length} step${steps.length === 1 ? '' : 's'}:` }),
    h('ul', { class: 'plain-list' },
      ...steps.map((s) =>
        h('li', { dataset: { writeStep: s.index } },
          `Step ${s.index + 1}: ${s.label} (${s.risk})`,
          s.kind === 'login' ? h('span', { class: 'muted', text: ' \u00B7 login form' }) : null))));
}
/**
 * "Saved session available: yes/no" for the application of a web action, with a "Forget session" button that is
 * enabled only for "yes". Only the Application_Key (an origin) is ever shown or sent.
 * @param {any} wf @param {any} overview
 * @returns {HTMLElement | null}
 */
function sessionPanel(wf, overview) {
  const target = (overview?.targets ?? []).find((t) => t.name === wf.target.name && t.type === wf.target.type);
  const key = wf.target.type === 'web' && typeof target?.start === 'string' ? applicationKey(target.start) : undefined;
  if (key === undefined) return null;
  const text = h('p', { id: 'session-text', role: 'status', text: COPY.hintChecking });
  const error = h('p', { class: 'error-text', role: 'alert' });
  const forget = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-small', id: 'forget-session', disabled: true, text: COPY.forgetSession }));
  const show = (available) => {
    text.textContent = available ? COPY.sessionYes : COPY.sessionNo;
    forget.disabled = !available;
  };
  api
    .sessionFor(key)
    .then((answer) => show(answer?.available === true))
    .catch(() => show(false));
  forget.addEventListener('click', async () => {
    forget.disabled = true;
    error.textContent = '';
    try {
      const { status } = await api.sessionForget(key);
      if (status === 200) {
        show(false);
        announce(COPY.sessionForgotten);
      } else {
        error.textContent = COPY.sessionForgetFailed;
        forget.disabled = false;
      }
    } catch {
      error.textContent = COPY.sessionForgetFailed;
      forget.disabled = false;
    }
  });
  return panel('p-session', 'Signed-in session', h('p', { class: 'muted small' }, h('code', { text: key })), text, forget, error);
}

// ----- the editor: rename and describe, edit inputs, delete ----------------------------------------------------------
/** A note for the next screen that is drawn (the tool is being rebuilt). */
let nextNotice = '';
/** Said once more after the next screen is drawn, because the router announces its own loaded message first. */
let nextAnnouncement = '';
/** The pending note, once. */
function takeNotice() {
  const text = nextNotice;
  nextNotice = '';
  return text;
}
/**
 * @typedef {{ rerender: (notice: string) => Promise<void>, leaveToList: (notice: string) => void }} EditorHooks
 */
/**
 * The text to show for an answer that is not a success: the server message for 400, 404 and 409, else "not saved".
 * @param {{ status: number, body: any }} res @param {string} notSaved
 */
function failureText(res, notSaved) {
  const message = res.body && typeof res.body.error === 'string' ? res.body.error : '';
  return [400, 404, 409].includes(res.status) && message !== '' ? message : notSaved;
}
/** @param {() => Promise<{ status: number, body: any }>} call */
async function send(call) {
  try {
    return await call();
  } catch {
    return { status: 0, body: null };
  }
}
/**
 * @param {string} id @param {string} title @param {HTMLElement[]} fields @param {HTMLElement} error @param {HTMLElement} save @param {HTMLElement} cancel
 */
function formShell(id, title, fields, error, save, cancel) {
  const form = h('form', { class: 'wf-edit-form', id, novalidate: true, 'aria-labelledby': `${id}-title` },
    h('h3', { class: 'form-title', id: `${id}-title`, text: title }),
    ...fields,
    error,
    h('div', { class: 'wf-form-actions' }, save, cancel));
  return /** @type {HTMLFormElement} */ (form);
}
/**
 * "Rename and describe": sends only `id` and the fields that changed.
 * @param {any} wf @param {EditorHooks} hooks @param {() => void} close
 */
function renameForm(wf, hooks, close) {
  const name = /** @type {HTMLInputElement} */ (h('input', { type: 'text', id: 'wf-name-input', class: 'input', maxlength: '200', autocomplete: 'off', value: wf.label ?? '' }));
  const description = /** @type {HTMLTextAreaElement} */ (h('textarea', { id: 'wf-description-input', class: 'input', maxlength: '400', 'aria-describedby': 'wf-description-help' }, wf.description ?? ''));
  const error = h('p', { class: 'wf-edit-error', id: 'wf-rename-error', role: 'alert' });
  const save = /** @type {HTMLButtonElement} */ (h('button', { type: 'submit', class: 'btn btn-primary', id: 'wf-rename-save', text: ED.save }));
  const cancel = h('button', { type: 'button', class: 'btn btn-quiet', id: 'wf-rename-cancel', text: ED.cancel, onclick: close });
  const form = formShell('wf-rename-form', ED.renameTitle, [
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'wf-name-input', text: ED.nameLabel }), name),
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'wf-description-input', text: ED.descriptionLabel }),
      description,
      h('p', { class: 'help muted small', id: 'wf-description-help', text: ED.descriptionHelp })),
  ], error, save, cancel);
  let pending = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (pending) return;
    /** @type {Record<string, string>} */
    const body = { id: wf.id };
    if (name.value.trim() !== (wf.label ?? '')) body.label = name.value;
    if (description.value.trim() !== (wf.description ?? '')) body.description = description.value;
    if (Object.keys(body).length === 1) {
      error.textContent = ED.nothingChanged;
      return;
    }
    pending = true;
    save.disabled = true;
    error.textContent = '';
    const res = await send(() => api.workflowUpdate(body));
    pending = false;
    save.disabled = false;
    if (res.status === 200) {
      announce(ED.updated);
      await hooks.rerender(res.body?.recompile === 'started' ? ED.rebuilding : '');
    } else {
      error.textContent = failureText(res, ED.notSaved);
    }
  });
  return form;
}
const TYPE_OPTIONS = /** @type {Array<[string, string]>} */ ([['string', ED.typeText], ['number', ED.typeNumber], ['boolean', ED.typeBoolean]]);
/**
 * "Edit inputs": one row per Variable; sends only the Variables whose name, type, optional or whenOmitted changed.
 * @param {any} wf @param {EditorHooks} hooks @param {() => void} close
 */
function inputsForm(wf, hooks, close) {
  const error = h('p', { class: 'wf-edit-error', id: 'wf-inputs-error', role: 'alert' });
  const save = /** @type {HTMLButtonElement} */ (h('button', { type: 'submit', class: 'btn btn-primary', id: 'wf-inputs-save', text: ED.save }));
  const cancel = h('button', { type: 'button', class: 'btn btn-quiet', id: 'wf-inputs-cancel', text: ED.cancel, onclick: close });
  const rows = wf.variables.map((/** @type {any} */ v, /** @type {number} */ i) => {
    const name = /** @type {HTMLInputElement} */ (h('input', { type: 'text', id: `wf-var-name-${i}`, class: 'input', maxlength: '60', autocomplete: 'off', spellcheck: 'false', value: v.name }));
    const type = /** @type {HTMLSelectElement} */ (h('select', { id: `wf-var-type-${i}`, class: 'input' },
      ...TYPE_OPTIONS.map(([value, label]) => h('option', { value, selected: value === (v.type ?? 'string'), text: label }))));
    const optional = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: `wf-var-optional-${i}`, checked: v.optional === true }));
    const when = /** @type {HTMLSelectElement} */ (h('select', { id: `wf-var-when-${i}`, class: 'input' },
      h('option', { value: 'skip', selected: v.whenOmitted === 'skip', text: ED.whenSkip }),
      h('option', { value: 'useRecorded', selected: v.whenOmitted !== 'skip', text: ED.whenUseRecorded })));
    const whenField = h('div', { class: 'field', id: `wf-var-when-field-${i}` }, h('label', { class: 'field-label', for: `wf-var-when-${i}`, text: ED.whenOmittedLabel }), when);
    whenField.hidden = !optional.checked;
    optional.addEventListener('change', () => {
      whenField.hidden = !optional.checked;
    });
    const row = h('fieldset', { class: 'wf-input-row', dataset: { variable: v.name } },
      h('legend', { text: v.name }),
      h('div', { class: 'row-fields' },
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: `wf-var-name-${i}`, text: ED.nameLabel }), name),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: `wf-var-type-${i}`, text: ED.typeLabel }), type),
        h('div', { class: 'field' }, optional, ' ', h('label', { class: 'field-label inline', for: `wf-var-optional-${i}`, text: ED.optionalLabel })),
        whenField));
    return { v, name, type, optional, when, row };
  });
  const lead = h('p', { class: 'muted', text: wf.variables.length ? ED.inputsLead : ED.inputsNone });
  const form = formShell('wf-inputs-form', ED.inputsTitle, [lead, ...rows.map((/** @type {any} */ r) => r.row)], error, save, cancel);
  if (wf.variables.length === 0) save.disabled = true;
  let pending = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (pending) return;
    const variables = [];
    for (const r of rows) {
      const name = r.name.value.trim();
      const original = r.v.optional ? (r.v.whenOmitted ?? 'useRecorded') : undefined;
      const optional = r.optional.checked;
      const changed = name !== r.v.name || r.type.value !== (r.v.type ?? 'string') || optional !== (r.v.optional === true) || (optional && r.when.value !== original);
      if (!changed) continue;
      variables.push({ name: r.v.name, newName: name, type: r.type.value, optional, ...(optional ? { whenOmitted: r.when.value } : {}) });
    }
    if (variables.length === 0) {
      error.textContent = ED.nothingChanged;
      return;
    }
    pending = true;
    save.disabled = true;
    error.textContent = '';
    const res = await send(() => api.workflowUpdate({ id: wf.id, variables }));
    pending = false;
    save.disabled = false;
    if (res.status === 200) {
      announce(ED.updated);
      await hooks.rerender(res.body?.recompile === 'started' ? ED.rebuilding : '');
    } else {
      error.textContent = failureText(res, ED.notSaved);
    }
  });
  return form;
}
/**
 * The delete dialog: focus on "Cancel", nothing is sent until "Delete", one request at a time.
 * @param {any} wf @param {EditorHooks} hooks @param {HTMLElement} opener
 */
function confirmDelete(wf, hooks, opener) {
  const error = h('p', { class: 'wf-edit-error', id: 'wf-delete-error', role: 'alert' });
  const cancel = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-quiet', id: 'wf-delete-cancel', text: ED.cancel }));
  const confirm = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-primary', id: 'wf-delete-confirm', text: ED.deleteConfirm }));
  const dialog = openDialog({
    title: ED.deleteTitle,
    opener,
    content: [
      h('p', null, ED.deleteBefore, h('strong', { class: 'wf-delete-name', text: wf.label || wf.id }), ED.deleteAfter),
      h('p', { class: 'muted', text: ED.deleteWarning }),
      error,
      h('div', { class: 'wf-dialog-actions' }, cancel, confirm),
    ],
  });
  let pending = false;
  cancel.addEventListener('click', () => {
    if (!pending) dialog.close();
  });
  confirm.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    confirm.disabled = true;
    cancel.disabled = true;
    error.textContent = '';
    const res = await send(() => api.workflowDelete(wf.id));
    pending = false;
    if (res.status === 200) {
      dialog.close();
      announce(ED.deleted);
      hooks.leaveToList(res.body?.recompile === 'started' ? ED.rebuilding : '');
      return;
    }
    error.textContent = failureText(res, ED.deleteNotSaved);
    confirm.disabled = false;
    cancel.disabled = false;
    cancel.focus();
  });
  cancel.focus();
  return dialog;
}
/**
 * The three controls and the place where their form opens.
 * @param {any} wf @param {EditorHooks} hooks
 */
function editorControls(wf, hooks) {
  const area = h('div', { class: 'wf-edit-area' });
  /** @type {HTMLElement | null} */
  let openFor = null;
  const closeForm = () => {
    area.replaceChildren();
    openFor?.focus();
    openFor = null;
  };
  /** @param {HTMLElement} button @param {(close: () => void) => HTMLElement} build */
  const toggle = (button, build) => {
    if (openFor === button) {
      closeForm();
      return;
    }
    openFor = button;
    const form = build(closeForm);
    area.replaceChildren(form);
    /** @type {HTMLElement | null} */ (form.querySelector('input, select, textarea'))?.focus();
  };
  const rename = h('button', { type: 'button', class: 'btn btn-small', id: 'wf-rename', text: ED.renameButton });
  const inputs = h('button', { type: 'button', class: 'btn btn-small', id: 'wf-inputs', text: ED.inputsButton });
  const del = h('button', { type: 'button', class: 'btn btn-small', id: 'wf-delete', text: ED.deleteButton });
  rename.addEventListener('click', () => toggle(rename, (close) => renameForm(wf, hooks, close)));
  inputs.addEventListener('click', () => toggle(inputs, (close) => inputsForm(wf, hooks, close)));
  del.addEventListener('click', () => confirmDelete(wf, hooks, del));
  return h('div', { class: 'wf-editor' }, h('div', { class: 'wf-actions' }, rename, inputs, del), area);
}
/** @param {any} wf @param {any} [overview] the overview, set only when the new features are shown @param {EditorHooks} [hooks] */
function detail(wf, overview, hooks) {
  const vars = wf.variables.length
    ? h('div', { class: 'table-wrap' },
        h(
          'table',
          { class: 'table compact vars-table' },
          h('caption', { class: 'sr-only', text: 'Variables' }),
          h('thead', null, h('tr', null, ...['Name', 'Type', 'Description', 'Required'].map((t) => h('th', { scope: 'col', text: t })))),
          h('tbody', null,
            ...wf.variables.map((v) =>
              h('tr', null, h('td', null, varChip(v.name)), h('td', null, h('code', { text: v.type })), h('td', { text: v.description ?? '\u2013' }), h('td', { text: v.optional ? 'optional' : 'required' }))
            ))
        ))
    : h('p', { class: 'muted', text: 'This workflow takes no input.' });
  const secretList = Array.isArray(wf.secrets) ? wf.secrets : [];
  const hasSecretModel = wf.secretsBasis !== undefined || Array.isArray(wf.unusedSecrets);
  const secrets = hasSecretModel
    ? secretsSection(secretList, wf.unusedSecrets, { basis: wf.secretsBasis, variant: 'workflow' })
    : secretList.length
      ? h('ul', { class: 'plain-list' }, ...secretList.map((x) => h('li', null, chip(x.name, 'secret'), x.kind ? h('span', { class: 'muted', text: ` ${x.kind}` }) : null)))
      : h('p', { class: 'muted', text: 'No secret needed.' });
  const facts = h(
    'dl',
    { class: 'facts' },
    h('div', null, h('dt', { text: 'Target' }), h('dd', { text: `${wf.target.name} (${wf.target.type === 'web' ? 'web' : 'terminal'})` })),
    h('div', null, h('dt', { text: 'Steps' }), h('dd', { text: String(wf.stepCount) })),
    wf.startPage ? h('div', null, h('dt', { text: ED.startPageLabel }), h('dd', null, h('code', { text: wf.startPage }))) : null,
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
      writeNote(wf),
      hooks && overview ? editorControls(wf, hooks) : null,
      nextNotice !== '' ? h('p', { class: 'wf-notice', role: 'status', text: takeNotice() }) : null,
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
        panel('p-secrets', 'Secrets needed', secrets, h('p', { class: 'muted small', text: 'Names only. Set them as environment variables when the tool runs.' }),
          overview ? h('p', null, h('a', { class: 'btn btn-small', href: href('credentials'), text: COPY.credentialsLink })) : null),
        overview ? sessionPanel(wf, overview) : null)
    )
  );
}

/** @param {{ parts: string[] }} route */
export async function renderWorkflows(route) {
  const { workflows, truncated } = await api.workflows();
  const overview = await api.overview().catch(() => null);
  const features = overview !== null && !isDemo(overview) ? overview : undefined;
  const activeId = route.parts[0];
  const active = workflows.find((w) => w.id === activeId);
  const root = h('div', { class: 'view view-workflows' });
  const spoken = nextAnnouncement;
  nextAnnouncement = '';
  if (spoken !== '') window.setTimeout(() => announce(spoken), 300);
  /** @type {EditorHooks} */
  const hooks = {
    rerender: async (notice) => {
      nextNotice = notice;
      invalidate('/api/workflows');
      invalidate('/api/overview');
      const fresh = await renderWorkflows(route);
      root.replaceWith(fresh);
      /** @type {HTMLElement | null} */ (fresh.querySelector('#wf-title'))?.focus();
    },
    leaveToList: (notice) => {
      nextNotice = notice;
      nextAnnouncement = ED.deleted;
      invalidate('/api/workflows');
      invalidate('/api/overview');
      window.location.hash = href('workflows');
    },
  };
  if (workflows.length === 0) {
    nextNotice = '';
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
      ? detail(active, features, hooks)
      : h('div', { class: 'state empty' },
          nextNotice !== '' ? h('p', { class: 'wf-notice', role: 'status', text: takeNotice() }) : null,
          h('p', { class: 'state-title', text: 'Pick a workflow' }),
          h('p', { class: 'muted', text: 'Each one becomes a tool. Open it to see its steps, the replay level of each step, and what it needs.' }),
          levelLegend()));
  root.appendChild(h('div', { class: 'split' }, aside, main));
  return root;
}
