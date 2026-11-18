// @ts-check
/**
 * An accessible modal dialog built with the safe builders. `role="dialog"`, `aria-modal="true"`, the name comes from
 * the heading, the rest of the page is `inert`, Tab and Shift+Tab wrap inside, Escape closes, and focus goes back to
 * the opener (or to the heading of the current screen when the opener is gone).
 */
import { h } from './dom.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const BACKGROUND = ['header', 'main', 'footer'];

let counter = 0;

/**
 * Drops `null`, `undefined` and `false` and keeps the order of the rest.
 * @param {unknown} children one child or a list
 * @returns {any[]}
 */
export function withoutEmpty(children) {
  const list = Array.isArray(children) ? children : [children];
  return list.filter((c) => c !== null && c !== undefined && c !== false);
}

/**
 * @param {{ title: string, content: Node | Node[], opener?: HTMLElement | null, onClose?: () => void }} options
 * @returns {{ element: HTMLElement, body: HTMLElement, close: () => void, setContent: (...nodes: Node[]) => void, focusFirst: () => void }}
 */
export function openDialog({ title, content, opener, onClose }) {
  const id = `dialog-title-${++counter}`;
  const body = h('div', { class: 'dialog-body' });
  const heading = h('h2', { id, class: 'dialog-title', text: title });
  const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id }, heading, body);
  const backdrop = h('div', { class: 'dialog-backdrop' }, box);
  let closed = false;

  const setContent = (...nodes) => {
    body.replaceChildren(...withoutEmpty(nodes));
  };
  setContent(...withoutEmpty(content));

  const focusables = () => /** @type {HTMLElement[]} */ ([...box.querySelectorAll(FOCUSABLE)]).filter((el) => !el.hasAttribute('hidden'));
  const focusFirst = () => {
    const first = focusables()[0];
    (first ?? box).focus();
  };

  const inerted = [];
  for (const tag of BACKGROUND) {
    for (const el of document.querySelectorAll(tag)) {
      if (!el.hasAttribute('inert')) {
        el.setAttribute('inert', '');
        inerted.push(el);
      }
    }
  }

  const close = () => {
    if (closed) return;
    closed = true;
    box.removeEventListener('keydown', onKey);
    for (const el of inerted) el.removeAttribute('inert');
    backdrop.remove();
    const target = opener && opener.isConnected ? opener : /** @type {HTMLElement | null} */ (document.querySelector('main [tabindex="-1"]'));
    target?.focus({ preventScroll: true });
    onClose?.();
  };

  /** @param {Event} ev */
  function onKey(ev) {
    const key = /** @type {KeyboardEvent} */ (ev);
    if (key.key === 'Escape') {
      key.preventDefault();
      key.stopPropagation();
      close();
      return;
    }
    if (key.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) {
      key.preventDefault();
      box.focus();
      return;
    }
    const first = items[0];
    const lastItem = items[items.length - 1];
    const active = document.activeElement;
    if (key.shiftKey && (active === first || !box.contains(active))) {
      key.preventDefault();
      lastItem.focus();
    } else if (!key.shiftKey && (active === lastItem || !box.contains(active))) {
      key.preventDefault();
      first.focus();
    }
  }
  box.setAttribute('tabindex', '-1');
  box.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  focusFirst();
  return { element: box, body, close, setContent, focusFirst };
}
