// @ts-check
/**
 * The Activity view (`#/activity`). G0 seam: an empty body; group G-U1 fills it and keeps the export.
 */
import { h } from '../dom.js';
/**
 * @param {import('../router.js').Route} _route
 * @returns {HTMLElement}
 */
export function renderActivity(_route) {
  return h('section', { class: 'panel activity' });
}
