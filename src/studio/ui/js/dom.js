// @ts-check
/**
 * Safe DOM builders. Data is only ever written with textContent / text nodes / setAttribute of plain values:
 * there is no innerHTML anywhere in the UI, and inline handlers or inline styles cannot be created from here.
 */

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** @typedef {string | number | boolean | null | undefined | Node | Child[]} Child */

/** Only same-page anchors and our own API paths may become a link or a picture address. */
function safeAddress(value) {
  const v = String(value);
  // `data/...png` is a picture of the static demo, relative to the page (so it works under a sub-path)
  return v.startsWith('#') || (v.startsWith('/') && !v.startsWith('//')) || v === 'favicon.svg' || /^data\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.png$/.test(v);
}

function build(ns, tag, props, children) {
  const el = ns === SVG_NS ? document.createElementNS(SVG_NS, tag) : document.createElementNS(HTML_NS, tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', String(value));
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined && v !== null) el.setAttribute(`data-${k}`, String(v));
      }
    } else if (key.startsWith('on')) {
      if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'style' || key === 'innerHTML' || key === 'outerHTML' || key === 'srcdoc') continue;
    else if ((key === 'href' || key === 'src') && !safeAddress(value)) continue;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

/** @param {Node} el @param {Child[]} children */
export function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
  return el;
}

/**
 * HTML element builder.
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...Child} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  return /** @type {HTMLElement} */ (build(HTML_NS, tag, props, children));
}

/**
 * SVG element builder.
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...Child} children
 * @returns {SVGElement}
 */
export function s(tag, props, ...children) {
  return /** @type {SVGElement} */ (build(SVG_NS, tag, props, children));
}

/** Remove every child of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Cut a text to `max` characters with an ellipsis. */
export function clip(text, max) {
  const t = String(text ?? '');
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}\u2026`;
}

/** Width in percent as a CSSOM assignment (allowed under a strict CSP, unlike a style attribute). */
export function setWidth(el, percent) {
  el.style.width = `${percent}%`;
  return el;
}
