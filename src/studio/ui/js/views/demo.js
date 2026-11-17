// @ts-check
import { h } from '../dom.js';
import { api, isDemo } from '../api.js';
import { COPY } from '../copy.js';

/**
 * The static demo and the sample mode have no recording, credentials or connection. The new routes show a short note.
 * @param {string} title the heading of the screen
 * @returns {Promise<HTMLElement | null>} the note screen in a demo, null otherwise
 */
export async function demoScreen(title) {
  let overview;
  try {
    overview = await api.overview();
  } catch {
    return null; // The view reports its own problem
  }
  if (!isDemo(overview)) return null;
  return h(
    'div',
    { class: 'view view-demo' },
    h('h1', { class: 'view-title', tabindex: '-1', text: title }),
    h('p', { class: 'notice', role: 'note', text: COPY.demoNote }),
    h('p', null, h('a', { href: '#/', text: COPY.backToOverview }))
  );
}
