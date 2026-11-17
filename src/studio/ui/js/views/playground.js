// @ts-check
import { h, clear } from '../dom.js';
import { api, ApiError } from '../api.js';
import { announce, chip, copyButton, emptyState, levelBadge, pill, riskBadge, toolName as toolNameChip } from '../components.js';
import { secretsSection } from '../secrets-view.js';
import { buildArguments, describeField, fieldsFromSchema, formatElapsed, initialValues, parseTimeout } from '../schema-form.js';

/**
 * The MCP playground: pick a tool, fill a form made from its input schema, call it and see what an agent would get:
 * success, drift, healing, the levels used, the screen, and the diagnostics of a failure.
 * The server does the validation, the confirmation of write/delete tools and the redaction; nothing secret is here.
 */

/** @param {string} text */
const firstParagraph = (text) => String(text ?? '').split(/\n\s*\n/)[0];

/** @param {string} label @param {...any} content */
function kv(label, ...content) {
  return h('div', null, h('dt', { text: label }), h('dd', null, ...content));
}

/** @param {any} r */
function driftChip(r) {
  if (r.driftChecked === false) return chip('Drift not checked', 'plain');
  if (r.drifted === true) return h('span', { class: 'chip heal', dataset: { flag: 'drifted', value: 'true' }, text: 'Drifted' });
  if (r.drifted === false) return h('span', { class: 'chip pass', dataset: { flag: 'drifted', value: 'false' }, text: 'Not drifted' });
  return null;
}

/** @param {any} r */
function healChip(r) {
  if (r.healed === undefined) return null;
  const n = Array.isArray(r.healedSteps) ? r.healedSteps.length : 0;
  return h('span', { class: r.healed ? 'chip heal' : 'chip plain', dataset: { flag: 'healed', value: String(r.healed) }, text: r.healed ? `Healed ${n} step${n === 1 ? '' : 's'}` : 'Not healed' });
}

/** @param {any} failure */
function failureBlock(failure) {
  const { stepIndex, action, risk, label, level, status, tried, reason, ...rest } = failure;
  const rows = [];
  if (typeof stepIndex === 'number') rows.push(kv('Step', `${stepIndex + 1}`, h('span', { class: 'muted', text: ` (index ${stepIndex})` })));
  if (action) rows.push(kv('Action', h('code', { text: String(action) }), label ? h('span', { class: 'muted', text: ` ${label}` }) : null));
  if (risk) rows.push(kv('Risk', riskBadge(String(risk))));
  if (level) rows.push(kv('Level', levelBadge(String(level), { small: true })));
  if (typeof status === 'number') rows.push(kv('HTTP status', String(status)));
  if (reason) rows.push(kv('Reason', String(reason)));
  const locators = Array.isArray(tried) ? tried : [];
  if (locators.length) rows.push(kv('Tried', h('ul', { class: 'plain-list pg-tried' }, ...locators.map((t) => h('li', null, h('code', { text: String(t) }))))));
  const extra = Object.entries(rest);
  if (extra.length) rows.push(kv('More', h('code', { text: JSON.stringify(Object.fromEntries(extra)) })));
  return h('section', { class: 'pg-failure', 'aria-label': 'Failure diagnostics' }, h('h4', { class: 'mini-title', text: 'Failure diagnostics' }), h('dl', { class: 'facts' }, ...rows));
}

/**
 * What the result panel shows for an answer of the playground.
 * @param {any} r
 */
function resultPanel(r) {
  const isRefusal = r.refused === 'validation';
  const bridgeError = r.ok === false && !isRefusal;
  const success = r.ok !== false && r.success === true;
  const badges = h('div', { class: 'pg-badges', role: 'group', 'aria-label': 'Result summary' });
  badges.append(
    isRefusal
      ? pill('fail', 'Refused before the call')
      : bridgeError
        ? pill('fail', r.error === 'aborted' ? 'Cancelled' : 'Could not complete')
        : pill(success ? 'pass' : 'fail', success ? 'Success' : 'Failed')
  );
  if (!isRefusal && !bridgeError) {
    const d = driftChip(r);
    if (d) badges.append(' ', d);
    const hc = healChip(r);
    if (hc) badges.append(' ', hc);
  }
  if (r.mode) badges.append(' ', chip(`Mode: ${r.mode}`, 'plain'));
  if (typeof r.elapsedMs === 'number') badges.append(' ', chip(formatElapsed(r.elapsedMs), 'plain'));
  if (r.screenType) badges.append(' ', chip(r.screenType === 'terminal' ? 'Terminal screen' : 'Web page', 'plain'));
  if (r.levelFallback) badges.append(' ', chip('Level fallback', 'heal'));
  const levels = Array.isArray(r.levels) ? r.levels : [];
  if (levels.length) {
    const counts = new Map();
    for (const l of levels) counts.set(l, (counts.get(l) ?? 0) + 1);
    const row = h('div', { class: 'pg-levels', role: 'group', 'aria-label': 'Replay levels used' }, h('span', { class: 'muted', text: 'Levels used: ' }));
    for (const [level, n] of counts) row.append(levelBadge(level, { small: true }), h('span', { class: 'muted', text: ` \u00D7${n} ` }));
    badges.append(row);
  }

  const body = [badges];
  if (isRefusal) {
    body.push(h('div', { class: 'state error', role: 'note', dataset: { refused: 'validation' } },
      h('p', { class: 'state-title', text: 'The server was not asked' }),
      h('p', { text: 'These arguments do not fit the tool\u2019s input schema. An agent would get the same refusal:' }),
      h('ul', { class: 'plain-list' }, ...(r.errors ?? []).map((e) => h('li', null, h('code', { text: e.instancePath || '(arguments)' }), ` ${e.message}`)))));
  } else if (bridgeError) {
    body.push(h('div', { class: 'state error', role: 'alert', dataset: { bridge: String(r.error) } },
      h('p', { class: 'state-title', text: r.error === 'timeout' ? 'The call timed out' : r.error === 'server_crashed' ? 'The server stopped' : 'The call did not complete' }),
      h('p', { text: r.message ?? 'The playground could not finish the call.' })));
  } else {
    if (r.error && !r.failure) {
      body.push(h('p', { class: 'error-text', role: 'note', text: `${r.error}${r.message ? `: ${r.message}` : ''}` }));
      if (Array.isArray(r.errors) && r.errors.length) {
        body.push(h('ul', { class: 'plain-list' }, ...r.errors.map((e) => h('li', null, h('code', { text: e.instancePath || '(arguments)' }), ` ${e.message}`))));
      }
    }
    if (r.failure) body.push(failureBlock(r.failure));
    if (r.heal) body.push(h('p', { class: 'muted', text: `Heal: ${r.heal.attempted ? 'attempted' : 'not attempted'}${r.heal.reason ? ` \u2013 ${r.heal.reason}` : ''}` }));
    // The screen: what the call ended on
    const hasScreen = r.title || r.text || r.screenshotUrl || r.data !== undefined;
    if (hasScreen) {
      const screen = h('section', { class: 'pg-screen', 'aria-label': 'Screen preview', dataset: { screen: r.screenType === 'terminal' ? 'terminal' : 'web' } });
      screen.append(h('h4', { class: 'mini-title', text: 'Screen' }));
      if (r.title) screen.append(h('p', { class: 'pg-title' }, h('span', { class: 'muted', text: 'Page title: ' }), h('strong', { text: r.title })));
      if (r.screenshotUrl) {
        screen.append(h('figure', { class: 'thumb pg-shot' },
          h('img', { src: r.screenshotUrl, alt: r.failure ? 'Screenshot of the page at the failing step' : 'Screenshot of the final screen', loading: 'lazy' }),
          h('figcaption', { text: r.failure ? 'Page at the failing step' : 'Final screen' })));
      }
      if (r.screenshotSkipped) {
        screen.append(h('p', { class: 'muted', role: 'note', text: r.screenshotSkipped === 'sensitive_field' ? 'No screenshot: a password or code field is visible on the final screen.' : 'The screenshot could not be taken.' }));
      }
      if (r.text) {
        screen.append(h('pre', { class: r.screenType === 'terminal' ? 'code-block pg-term' : 'code-block pg-text', tabindex: '0', 'aria-label': r.screenType === 'terminal' ? 'Rendered terminal screen' : 'Visible text of the page' }, h('code', { text: r.text })));
      }
      if (r.data !== undefined) {
        screen.append(h('p', { class: 'mini-title', text: 'Data (result zone)' }));
        screen.append(h('pre', { class: 'code-block', tabindex: '0', 'aria-label': 'Extracted data' }, h('code', { text: JSON.stringify(r.data, null, 2) })));
      }
      if (r.dataTruncated) screen.append(h('p', { class: 'muted', text: 'The data is too large to show here.' }));
      body.push(screen);
    } else if (success && r.screenshotSkipped) {
      body.push(h('p', { class: 'muted', role: 'note', text: 'No screenshot: a password or code field is visible on the final screen.' }));
    }
  }

  // The raw answer, for people who want every field
  const json = JSON.stringify(r, null, 2);
  const raw = h('details', { class: 'pg-json' },
    h('summary', { text: 'JSON view' }),
    h('pre', { class: 'code-block', tabindex: '0', 'aria-label': 'Result as JSON' }, h('code', { text: json })),
    copyButton(json, 'Copy result as JSON', { text: 'Copy JSON' }));
  body.push(raw);

  return h('section', { class: 'panel pg-result', 'aria-labelledby': 'pg-result-title', dataset: { result: isRefusal ? 'refused' : bridgeError ? 'error' : success ? 'success' : 'failed' } },
    h('h3', { id: 'pg-result-title', class: 'panel-title', text: 'Result' }), ...body);
}

/** @param {any[]} history */
function historyPanel(history) {
  const rows = [...history].reverse();
  const status = (e) => (e.ok === false ? (e.error ?? 'error') : e.success ? 'success' : 'failed');
  const body = rows.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact pg-history', 'aria-label': 'Last calls' },
        h('thead', null, h('tr', null, ...['Time', 'Tool', 'Arguments', 'Outcome', 'Mode', 'Time taken'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', null, ...rows.map((e) =>
          h('tr', { dataset: { outcome: status(e) } },
            h('td', { text: new Date(e.at).toLocaleTimeString() }),
            h('td', null, h('code', { text: e.tool })),
            h('td', null, h('code', { class: 'pg-args', text: JSON.stringify(e.arguments) })),
            h('td', { text: [status(e), e.drifted ? 'drifted' : '', e.healed ? 'healed' : ''].filter(Boolean).join(', ') }),
            h('td', { text: e.mode }),
            h('td', { text: formatElapsed(e.elapsedMs) }))))))
    : emptyState('No calls yet', 'The last 50 calls of this session are listed here. Secret values are shown as ***.');
  return h('section', { class: 'panel pg-history-panel', 'aria-labelledby': 'pg-history-title' }, h('h3', { id: 'pg-history-title', class: 'panel-title', text: 'Call history' }), body);
}

/**
 * @param {HTMLElement} root
 * @param {any} info
 */
function mount(root, info) {
  /** @type {any[]} */
  const tools = info.tools;
  const state = {
    /** @type {any} */ tool: undefined,
    /** @type {any[]} */ fields: [],
    /** @type {Record<string, string | boolean>} */ values: {},
    timeout: '',
    mode: info.mode === 'heal' ? 'heal' : 'strict',
    preview: info.preview === true,
    serverStarted: info.serverStarted === true,
    /** @type {AbortController | undefined} */ abort: undefined,
    running: false,
  };

  const statusPill = h('span', { id: 'pg-server-state', role: 'status' });
  const modeNote = h('p', { class: 'muted pg-note', id: 'pg-mode-note' });
  const statusError = h('div', { class: 'run-error', role: 'alert' });
  const toolPane = h('div', { class: 'pg-main' });
  const historyHost = h('div', { class: 'pg-history-host' });
  const dialogHost = h('div');

  const drawStatus = () => {
    statusPill.replaceChildren(pill(state.serverStarted ? 'pass' : 'notrun', state.serverStarted ? 'Server running' : 'Server stopped (starts on the next call)'));
  };

  const refreshHistory = async () => {
    try {
      const data = await api.playgroundHistory();
      historyHost.replaceChildren(historyPanel(data.history));
      if (typeof data.serverStarted === 'boolean') {
        state.serverStarted = data.serverStarted;
        drawStatus();
      }
    } catch {
      // The history is a convenience
    }
  };

  // ----- status bar ------------------------------------------------------------------------------------------
  const restartBusy = (busy) => {
    for (const b of root.querySelectorAll('.pg-server-actions button, .pg-mode button')) /** @type {HTMLButtonElement} */ (b).disabled = busy;
  };
  const restart = async (payload, doneMessage) => {
    statusError.replaceChildren();
    restartBusy(true);
    modeNote.textContent = 'Restarting the server\u2026';
    try {
      const { status, body } = await api.playgroundRestart(payload);
      if (status !== 200) throw new ApiError(body?.message ?? body?.error ?? 'The server did not restart.', status);
      state.serverStarted = body.serverStarted === true;
      state.mode = body.mode === 'heal' ? 'heal' : 'strict';
      modeNote.textContent = doneMessage;
      announce(doneMessage);
    } catch (err) {
      modeNote.textContent = '';
      statusError.replaceChildren(h('p', { class: 'state-title', text: 'The server did not restart' }), h('p', { text: err instanceof ApiError ? err.message : 'Unknown error.' }));
    } finally {
      restartBusy(false);
      drawStatus();
      drawModeButtons();
    }
  };

  const modeBar = h('div', { class: 'pg-mode', role: 'group', 'aria-label': 'Replay mode' });
  const drawModeButtons = () => {
    if (!info.healSupport) return;
    modeBar.replaceChildren(
      h('span', { class: 'field-label inline', text: 'Replay mode' }),
      ...['strict', 'heal'].map((m) =>
        h('button', {
          type: 'button', class: 'btn btn-small', 'aria-pressed': String(state.mode === m), dataset: { mode: m }, text: m === 'strict' ? 'Strict' : 'Heal',
          onclick: () => {
            if (state.mode === m) return;
            restart({ mode: m }, `Mode is now ${m}. The server was restarted.`);
          },
        })));
  };

  const previewBox = h('input', { type: 'checkbox', id: 'pg-preview', checked: state.preview ? true : undefined });
  previewBox.addEventListener('change', () => {
    state.preview = /** @type {HTMLInputElement} */ (previewBox).checked;
  });

  const bar = h('section', { class: 'panel pg-status', 'aria-labelledby': 'pg-status-title' },
    h('h3', { id: 'pg-status-title', class: 'panel-title', text: 'Server' }),
    h('div', { class: 'pg-bar' },
      statusPill,
      info.healSupport ? modeBar : h('span', { class: 'muted', text: 'Strict mode only (compiled without --heal-support)' }),
      info.previewSupported ? h('span', { class: 'pg-preview' }, previewBox, h('label', { for: 'pg-preview', class: 'field-label inline', text: ' Screenshot of the final screen' })) : null,
      h('span', { class: 'pg-server-actions' },
        h('button', { type: 'button', class: 'btn btn-small btn-quiet', text: 'Restart server', onclick: () => restart({}, 'The server was restarted.') }),
        ' ',
        h('button', { type: 'button', class: 'btn btn-small btn-quiet', text: 'Stop server', onclick: async () => {
          statusError.replaceChildren();
          try {
            const { status, body } = await api.playgroundStop();
            if (status === 200) state.serverStarted = body.serverStarted === true;
          } catch (err) {
            statusError.replaceChildren(h('p', { text: err instanceof ApiError ? err.message : 'The server could not be stopped.' }));
          }
          drawStatus();
          announce('Server stopped');
        } }))),
    modeNote,
    statusError,
    info.simulated ? h('p', { class: 'notice', role: 'note', dataset: { simulated: 'true' }, text: 'Simulated server: the answers are fixed and fictitious. Try the query "drift" on search_customers, the name "fail" on create_customer, and switch to Heal for open_sales_chart.' }) : null);

  // ----- tool list -------------------------------------------------------------------------------------------
  const list = h('ul', { class: 'wf-list' });
  const drawList = () => {
    list.replaceChildren(...tools.map((t) =>
      h('li', null,
        h('button', {
          type: 'button', class: 'wf-link pg-tool', 'aria-current': t === state.tool ? 'true' : undefined, dataset: { tool: t.name },
          onclick: () => selectTool(t),
        },
          h('span', { class: 'wf-name', text: t.label || t.name }),
          h('code', { class: 'wf-tool', text: t.name }),
          h('span', { class: 'wf-badges' }, riskBadge(t.risk), ...(t.levels ?? []).filter((l) => l !== 'none').map((l) => levelBadge(l, { small: true })))))));
  };

  // ----- one tool ---------------------------------------------------------------------------------------------
  const selectTool = (tool) => {
    state.tool = tool;
    state.fields = fieldsFromSchema(tool.inputSchema, tool.sensitiveArgs ?? []);
    state.values = initialValues(state.fields);
    state.timeout = '';
    drawList();
    drawTool();
    announce(`${tool.name} selected`);
  };

  /** @type {HTMLElement} */
  let resultHost = h('div', { class: 'pg-result-host' });

  const drawTool = () => {
    const tool = state.tool;
    clear(toolPane);
    if (tool === undefined) {
      toolPane.append(emptyState('Pick a tool', 'Choose a tool on the left to fill its arguments and call it.'));
      return;
    }
    const fieldErrors = {};
    const controls = new Map();
    const form = h('form', { class: 'pg-form', novalidate: true, 'aria-labelledby': 'pg-tool-title' });

    const head = h('header', { class: 'pg-head' },
      h('h2', { id: 'pg-tool-title', class: 'view-title pg-tool-title', tabindex: '-1' }, toolNameChip(tool.name)),
      h('div', { class: 'wf-meta' }, riskBadge(tool.risk), ...(tool.levels ?? []).filter((l) => l !== 'none').map((l) => levelBadge(l, { small: true }))),
      h('p', { class: 'muted', text: firstParagraph(tool.description) }));

    const fieldNodes = state.fields.map((f) => {
      const id = `pg-f-${f.name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      const helpId = `${id}-help`;
      const errId = `${id}-err`;
      /** @type {HTMLElement} */
      let control;
      const current = state.values[f.name];
      const common = { id, name: f.name, 'aria-describedby': `${helpId} ${errId}`, 'aria-required': f.required ? 'true' : undefined, autocomplete: 'off', dataset: { field: f.name } };
      if (f.kind === 'boolean') {
        control = h('input', { ...common, type: 'checkbox', checked: current === true ? true : undefined });
        control.addEventListener('change', () => { state.values[f.name] = /** @type {HTMLInputElement} */ (control).checked; });
      } else if (f.kind === 'enum') {
        control = h('select', { ...common, class: 'input' },
          ...(f.required ? [] : [h('option', { value: '', text: '(not set)' })]),
          ...(f.options ?? []).map((o) => h('option', { value: o, text: o, selected: o === current ? true : undefined })));
        control.addEventListener('change', () => { state.values[f.name] = /** @type {HTMLSelectElement} */ (control).value; });
      } else if (f.inputType === 'textarea') {
        control = h('textarea', { ...common, class: 'input pg-json-input', rows: '4', spellcheck: 'false', text: String(current ?? '') });
        control.addEventListener('input', () => { state.values[f.name] = /** @type {HTMLTextAreaElement} */ (control).value; });
      } else {
        control = h('input', {
          ...common, class: 'input', type: f.inputType, value: String(current ?? ''),
          min: f.min, max: f.max, minlength: f.minLength, maxlength: f.maxLength, step: f.kind === 'integer' ? '1' : f.kind === 'number' ? 'any' : undefined,
          spellcheck: 'false',
        });
        control.addEventListener('input', () => { state.values[f.name] = /** @type {HTMLInputElement} */ (control).value; });
      }
      controls.set(f.name, control);
      const label = h('label', { class: 'field-label', for: id },
        f.name, ' ', f.required ? chip('required', 'required') : chip('optional', 'optional'),
        f.sensitive ? h('span', { class: 'chip secret', text: 'secret field' }) : null);
      const help = h('p', { class: 'muted small', id: helpId, text: [f.description, describeField(f)].filter(Boolean).join(' \u00B7 ') });
      const err = h('p', { class: 'error-text', id: errId, role: 'alert' });
      fieldErrors[f.name] = err;
      const sensitiveNote = f.sensitive ? h('p', { class: 'muted small', text: 'Shown as *** in the history and never echoed back.' }) : null;
      return h('div', { class: f.kind === 'boolean' ? 'pg-field pg-field-check' : 'pg-field', dataset: { field: f.name } },
        f.kind === 'boolean' ? h('div', null, control, ' ', label) : label, f.kind === 'boolean' ? null : control, help, sensitiveNote, err);
    });

    const secrets = tool.secrets ?? [];
    const hasSecretModel = tool.secretsBasis !== undefined || Array.isArray(tool.unusedSecrets);
    const secretsBlock = hasSecretModel
      ? h('div', { class: 'pg-secrets' }, secretsSection(secrets, tool.unusedSecrets, { basis: tool.secretsBasis, variant: 'playground' }))
      : secrets.length
      ? h('section', { class: 'pg-secrets', 'aria-label': 'Secrets provided by the environment' },
          h('h4', { class: 'mini-title', text: 'Provided by env' }),
          h('ul', { class: 'plain-list' }, ...secrets.map((s) => h('li', null, h('span', { class: 'chip secret', text: s.name }), h('span', { class: 'muted', text: ` read from DAEMONIZE_SECRET_${s.name} in the Studio\u2019s environment. Its value is never shown.` })))))
      : null;

    const timeoutId = 'pg-timeout';
    const timeoutErr = h('p', { class: 'error-text', id: 'pg-timeout-err', role: 'alert' });
    const timeoutInput = h('input', { id: timeoutId, class: 'input pg-timeout', type: 'text', inputmode: 'numeric', autocomplete: 'off', 'aria-describedby': 'pg-timeout-help pg-timeout-err', value: state.timeout, placeholder: 'default' });
    timeoutInput.addEventListener('input', () => { state.timeout = /** @type {HTMLInputElement} */ (timeoutInput).value; });
    const timeoutField = h('div', { class: 'pg-field', dataset: { field: '_timeoutMs' } },
      h('label', { class: 'field-label', for: timeoutId }, '_timeoutMs ', chip('optional', 'optional')),
      timeoutInput,
      h('p', { class: 'muted small', id: 'pg-timeout-help', text: 'Timeout of the whole call, in milliseconds (1 to 600000). Reserved: not part of the payload.' }),
      timeoutErr);

    const callBtn = h('button', { type: 'submit', class: 'btn btn-primary', id: 'pg-call', text: 'Call tool' });
    const abortBtn = h('button', { type: 'button', class: 'btn', id: 'pg-abort', hidden: true, text: 'Abort' });
    const spinner = h('span', { class: 'pg-running', role: 'status', 'aria-live': 'polite' });
    const callError = h('div', { class: 'run-error', role: 'alert' });

    const setRunning = (running) => {
      state.running = running;
      callBtn.disabled = running;
      abortBtn.hidden = !running;
      form.setAttribute('aria-busy', String(running));
      spinner.replaceChildren(...(running ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Calling the tool\u2026'] : []));
    };

    const showResult = (r) => {
      resultHost.replaceChildren(resultPanel(r));
      const ok = r.ok !== false && r.success === true;
      announce(r.refused ? 'The call was refused before reaching the server' : r.ok === false ? `The call did not complete: ${r.error}` : ok ? 'Call succeeded' : 'Call failed');
    };

    const run = async (confirmed) => {
      callError.replaceChildren();
      for (const e of Object.values(fieldErrors)) e.textContent = '';
      timeoutErr.textContent = '';
      for (const c of controls.values()) c.removeAttribute('aria-invalid');
      const { args, errors } = buildArguments(state.fields, state.values);
      const t = parseTimeout(state.timeout);
      const invalid = Object.keys(errors);
      for (const name of invalid) {
        fieldErrors[name].textContent = errors[name];
        controls.get(name).setAttribute('aria-invalid', 'true');
      }
      if (!t.ok) {
        timeoutErr.textContent = t.message;
        timeoutInput.setAttribute('aria-invalid', 'true');
      }
      if (invalid.length || !t.ok) {
        (invalid.length ? controls.get(invalid[0]) : timeoutInput).focus();
        announce('Some arguments need attention');
        return;
      }
      // A write or delete tool asks first; the server refuses without the confirmation anyway
      if (tool.risk !== 'read' && !confirmed) return confirmDialog(tool, () => run(true));
      state.abort = new AbortController();
      setRunning(true);
      try {
        const payload = { tool: tool.name, arguments: args, mode: state.mode, ...(t.value === undefined ? {} : { timeoutMs: t.value }), ...(tool.risk !== 'read' ? { confirm: true } : {}), ...(info.previewSupported ? { preview: state.preview } : {}) };
        const { status, body } = await api.playgroundCall(payload, state.abort.signal);
        if (status === 200) {
          showResult(body);
        } else if (status === 409 && body?.error === 'confirmation_required') {
          confirmDialog(tool, () => run(true));
        } else {
          callError.replaceChildren(h('p', { class: 'state-title', text: 'The call was not made' }), h('p', { text: body?.message ?? body?.error ?? `The server answered ${status}.` }));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          resultHost.replaceChildren(resultPanel({ ok: false, error: 'aborted', success: false, message: 'You cancelled the call; the server was stopped and starts again on the next call.' }));
          state.serverStarted = false;
        } else {
          callError.replaceChildren(h('p', { class: 'state-title', text: 'The call did not complete' }), h('p', { text: err instanceof ApiError ? err.message : 'Unknown error.' }));
        }
      } finally {
        state.abort = undefined;
        setRunning(false);
        drawStatus();
        refreshHistory();
      }
    };

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!state.running) run(false);
    });
    abortBtn.addEventListener('click', () => state.abort?.abort());

    form.append(
      ...fieldNodes.length ? fieldNodes : [h('p', { class: 'muted', text: 'This tool takes no arguments.' })],
      timeoutField,
      secretsBlock,
      h('div', { class: 'run-bar' }, callBtn, abortBtn, spinner),
      callError);

    resultHost = h('div', { class: 'pg-result-host' });
    toolPane.append(head, form, resultHost);
  };

  /**
   * An accessible confirmation (a modal dialog: focus stays inside, Esc cancels, focus returns to the button).
   * @param {any} tool @param {() => void} onConfirm
   */
  const confirmDialog = (tool, onConfirm) => {
    clear(dialogHost);
    const verb = tool.risk === 'delete' ? 'delete' : 'change';
    const writeSteps = Array.isArray(tool.writeSteps) ? tool.writeSteps : [];
    /** Step numbers and labels only: no argument or secret value. */
    const writeList =
      writeSteps.length === 0 || tool.writeSummary === 'none'
        ? null
        : h('div', { id: 'pg-confirm-writes', dataset: { writeSummary: tool.writeSummary === 'login-only' ? 'login-only' : 'actions' } },
            h('p', { text: tool.writeSummary === 'login-only'
              ? 'The only write is the login form. The other steps only read.'
              : `Writes data in ${writeSteps.length} step${writeSteps.length === 1 ? '' : 's'}:` }),
            h('ul', { class: 'plain-list' },
              ...writeSteps.map((s) =>
                h('li', { dataset: { writeStep: s.index } },
                  `Step ${s.index + 1}: ${s.label} (${s.risk})`,
                  s.kind === 'login' ? h('span', { class: 'muted', text: ' \u00B7 login form' }) : null))));
    const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { class: 'pg-dialog', 'aria-labelledby': 'pg-confirm-title', 'aria-describedby': 'pg-confirm-text', dataset: { risk: tool.risk } },
      h('h3', { id: 'pg-confirm-title', class: 'panel-title', text: `Run ${tool.name}?` }),
      h('p', { id: 'pg-confirm-text' }, riskBadge(tool.risk), ` This tool can ${verb} data in the real application. It will run against whatever the server is pointed at.`),
      writeList,
      h('div', { class: 'run-bar' },
        h('button', { type: 'button', class: 'btn btn-quiet', id: 'pg-confirm-cancel', text: 'Cancel', onclick: () => dialog.close('cancel') }),
        h('button', { type: 'button', class: 'btn btn-primary', id: 'pg-confirm-ok', text: `Run ${tool.name}`, onclick: () => dialog.close('confirm') }))));
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'confirm';
      dialog.remove();
      if (confirmed) onConfirm();
      else document.getElementById('pg-call')?.focus();
    });
    dialogHost.append(dialog);
    dialog.showModal();
    /** @type {HTMLElement} */ (dialog.querySelector('#pg-confirm-cancel')).focus();
  };

  drawStatus();
  drawModeButtons();
  drawList();
  const wanted = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tool');
  const first = tools.find((t) => t.name === wanted) ?? tools[0];
  const nav = h('nav', { class: 'wf-nav', 'aria-label': 'Tools' }, h('p', { class: 'field-label', text: `${tools.length} tool${tools.length === 1 ? '' : 's'}` }), list);
  root.append(bar, h('div', { class: 'split pg-split' }, nav, toolPane), historyHost, dialogHost);
  if (first !== undefined) selectTool(first);
  else drawTool();
  refreshHistory();
}

/** @returns {Promise<HTMLElement>} */
export async function renderPlayground() {
  const info = await api.playgroundFresh();
  const root = h('div', { class: 'view view-playground' });
  root.appendChild(h('h1', { class: 'view-title', tabindex: '-1', text: 'Playground' }));
  root.appendChild(h('p', { class: 'view-lead', text: 'Call the compiled MCP tools here, and see drift, healing and a preview of the screen.' }));
  if (info?.staticDemo === true) {
    root.appendChild(h('p', { class: 'notice', role: 'note', dataset: { 'static-banner': 'true' } },
      h('strong', { text: 'Simulated demo: no real application is driven. ' }),
      'The tools below run a fixed simulation in this page; nothing is sent anywhere.'));
  }
  if (info === null) {
    root.appendChild(h('div', { class: 'state empty', dataset: { playground: 'absent' } },
      h('p', { class: 'state-title', text: 'The playground is not enabled yet' }),
      h('p', { class: 'muted', text: 'This page becomes available once the MCP playground is enabled on the Studio server.' })));
    return root;
  }
  if (info.available !== true) {
    root.appendChild(h('div', { class: 'state empty', dataset: { playground: 'unavailable' } },
      h('p', { class: 'state-title', text: 'No MCP server to call yet' }),
      h('p', { class: 'muted', text: info.message ?? 'The compiled server could not be started.' }),
      h('p', { class: 'muted', text: 'Run daemonize compile, then reload this page.' })));
    return root;
  }
  const tools = Array.isArray(info.tools) ? info.tools : [];
  if (tools.length === 0) {
    root.appendChild(h('div', { class: 'state empty', dataset: { playground: 'empty' } },
      h('p', { class: 'state-title', text: 'The server lists no tools' }),
      h('p', { class: 'muted', text: 'The server started but did not list any tool.' })));
    return root;
  }
  const host = h('div', { class: 'pg', dataset: { playground: 'ready', simulated: info.simulated ? 'true' : 'false' } });
  root.appendChild(host);
  mount(host, { ...info, tools });
  return root;
}
