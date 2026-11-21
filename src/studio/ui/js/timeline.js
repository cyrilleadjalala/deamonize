// @ts-check
/**
 * The replay timeline. G0 seam: empty bodies; group G-U2 fills them and keeps the exports.
 * `renderReplayTimeline` is the name of the design, `renderTimeline` the one of the task list: both are the same function.
 */
import { h } from './dom.js';
/**
 * @param {any[]} _trace The trace steps of a call.
 * @param {{ workflow?: any, failureShotUrl?: string, stoppedByApproval?: boolean }} [_options]
 * @returns {HTMLElement}
 */
export function renderReplayTimeline(_trace, _options) {
  return h('ol', { class: 'timeline' });
}
export const renderTimeline = renderReplayTimeline;
/**
 * The same list without thumbnails (used by the Activity view).
 * @param {any[]} _steps
 * @returns {HTMLElement}
 */
export function renderSimpleTimeline(_steps) {
  return h('ol', { class: 'timeline timeline-simple' });
}
