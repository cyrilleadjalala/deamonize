// @ts-check
/**
 * The replay timeline: one list item per step of a call. Every value is written as text (no HTML from a label).
 * `renderReplayTimeline` is the name of the design, `renderTimeline` the one of the task list: both are the same function.
 */
import { h } from './dom.js';
import { COPY_TIMELINE as T, durationText, pictureAltText } from './copy-timeline.js';

const NOT_REPEATED_NOTE = 'Not repeated: this step changes data';
const LEVEL_TEXT = {
  http: T.levelHttp,
  accessibility: T.levelAccessibility,
  vision: T.levelVision,
  terminal: T.levelTerminal,
  skipped: T.levelSkipped,
  not_run: T.levelNotRun,
};
const STATUS_TEXT = {
  ok: T.statusOk,
  failed: T.statusFailed,
  drifted: T.statusDrifted,
  skipped: T.statusSkipped,
  not_run: T.statusNotRun,
  blocked: T.statusBlocked,
};

/** @param {unknown} value @param {Record<string, string>} table @param {string} fallback */
function wordFor(value, table, fallback) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value) ? table[value] : fallback;
}

/** @param {unknown} v @returns {Record<string, any>} */
function asStep(v) {
  return v !== null && typeof v === 'object' ? /** @type {Record<string, any>} */ (v) : {};
}

/**
 * The same list without thumbnails when `withPictures` is false.
 * @param {any[]} trace
 * @param {{ workflow?: any, failureShotUrl?: string, failureStepIndex?: number, stoppedByApproval?: boolean, drifted?: boolean, reason?: string }} options
 * @param {boolean} withPictures
 */
function build(trace, options, withPictures) {
  const steps = Array.isArray(trace) ? trace : [];
  const stopped = options.stoppedByApproval === true;
  const wfSteps = Array.isArray(options.workflow?.steps) ? options.workflow.steps : [];
  const list = h('ol', { class: withPictures ? 'timeline' : 'timeline timeline-simple', 'aria-label': withPictures ? T.listLabel : T.simpleLabel });
  // The failing step: the one named by the caller, else the first step that failed or drifted
  const named = Number.isInteger(options.failureStepIndex) ? options.failureStepIndex : undefined;
  const firstBad = steps.findIndex((s) => ['failed', 'drifted'].includes(asStep(s).status));
  steps.forEach((raw, position) => {
    const s = asStep(raw);
    const index = Number.isInteger(s.index) && s.index >= 0 ? s.index : position;
    const level = stopped ? 'not_run' : s.level;
    const status = stopped ? 'not_run' : s.status;
    const levelText = wordFor(level, LEVEL_TEXT, T.levelNotRun);
    const statusText = wordFor(status, STATUS_TEXT, T.statusNotRun);
    const note = typeof s.note === 'string' ? s.note : '';
    const blocked = !stopped && (status === 'blocked' || note === NOT_REPEATED_NOTE);
    const skipped = !stopped && (status === 'skipped' || level === 'skipped');
    const driftedFlag = !stopped && (status === 'drifted' || (status === 'failed' && options.drifted === true));
    const isFailingRow = !stopped && (named !== undefined ? named === index : firstBad === position);

    const head = h('div', { class: 'tl-head' },
      h('span', { class: 'tl-num', text: `${T.stepWord} ${index + 1}` }),
      ' ',
      h('span', { class: 'tl-label', text: typeof s.label === 'string' ? s.label : '' }));
    const meta = h('div', { class: 'tl-meta' },
      h('span', { class: 'tl-chip tl-level', dataset: { level: typeof level === 'string' ? level : 'not_run' }, text: `${T.levelLabel}: ${levelText}` }),
      ' ',
      h('span', { class: 'tl-chip tl-status', dataset: { status: typeof status === 'string' ? status : 'not_run' }, text: `${T.statusLabel}: ${statusText}` }),
      ' ',
      h('span', { class: 'tl-duration', text: `${T.durationLabel}: ${durationText(Number(s.durationMs))}` }));
    const row = h('li', { class: 'tl-row', dataset: { step: index, status: typeof status === 'string' ? status : 'not_run' } }, head, meta);

    const flags = [];
    if (stopped) flags.push(T.stoppedByApproval);
    if (driftedFlag && status !== 'drifted') flags.push(T.drifted);
    if (blocked) flags.push(T.blocked);
    if (skipped) flags.push(T.skipped);
    for (const text of flags) row.append(h('p', { class: 'tl-flag', text }));
    if (!stopped && note !== '') row.append(h('p', { class: 'tl-note', text: note }));
    if (driftedFlag && isFailingRow && typeof options.reason === 'string' && options.reason !== '') {
      row.append(h('p', { class: 'tl-note', text: `${T.reasonLabel}: ${options.reason}` }));
    }

    if (withPictures) {
      const recorded = wfSteps[index]?.thumbnailUrl;
      /** @type {Array<[string, string]>} */
      const pictures = [];
      if (typeof recorded === 'string' && recorded !== '') pictures.push([recorded, pictureAltText(index + 1)]);
      if (isFailingRow && typeof options.failureShotUrl === 'string' && options.failureShotUrl !== '') pictures.push([options.failureShotUrl, T.failureAlt]);
      for (const [src, alt] of pictures) {
        const img = h('img', { class: 'tl-thumb', src, alt, loading: 'lazy', width: '160', height: '90' });
        if (img.getAttribute('src') === null) {
          row.append(h('p', { class: 'tl-nopic', text: T.noPicture }));
          continue;
        }
        const figure = h('figure', { class: 'tl-figure' }, img);
        img.addEventListener('error', () => figure.replaceWith(h('p', { class: 'tl-nopic', text: T.noPicture })));
        row.append(figure);
      }
    }
    list.append(row);
  });
  return list;
}

/**
 * @param {any[]} trace The trace steps of a call.
 * @param {{ workflow?: any, failureShotUrl?: string, failureStepIndex?: number, stoppedByApproval?: boolean, drifted?: boolean, reason?: string }} [options]
 * @returns {HTMLElement}
 */
export function renderReplayTimeline(trace, options = {}) {
  return build(trace, options ?? {}, true);
}
export const renderTimeline = renderReplayTimeline;

/**
 * The same list without thumbnails (used by the Activity view).
 * @param {any[]} steps
 * @returns {HTMLElement}
 */
export function renderSimpleTimeline(steps) {
  return build(steps, {}, false);
}
