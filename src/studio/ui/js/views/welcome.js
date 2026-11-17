// @ts-check
import { h } from '../dom.js';
import { COPY } from '../copy.js';
import { newActionSection } from './new-action.js';

/**
 * The first screen when there is no action yet.
 * @returns {HTMLElement}
 */
export function welcomePanel() {
  return h(
    'section',
    { class: 'panel welcome', 'aria-labelledby': 'welcome-title' },
    h('h2', { class: 'panel-title', id: 'welcome-title', text: COPY.welcomeTitle }),
    h('p', { text: COPY.welcomeLead }),
    h('ol', { class: 'welcome-steps' }, h('li', { text: COPY.welcomeStep1 }), h('li', { text: COPY.welcomeStep2 }), h('li', { text: COPY.welcomeStep3 })),
    newActionSection({ primary: true })
  );
}
