/**
 * Accessibility audits that run inside the page, without a library. They are plain strings so that nothing the
 * test transpiler adds can leak into the function sent to the browser.
 */

export interface ContrastFailure {
  text: string;
  tag: string;
  cls: string;
  ratio: number;
  fg: string;
  bg: string;
}

/** Contrast ratio of every visible piece of HTML text against its effective background (WCAG 2.x formula). */
export const CONTRAST_AUDIT = `(() => {
  const parse = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value);
    if (!m) return { r: 0, g: 0, b: 0, a: 0 };
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const background = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) chain.push(getComputedStyle(n).backgroundColor);
    let acc = { r: 12, g: 10, b: 20, a: 1 }; // the page colour under everything
    for (let i = chain.length - 1; i >= 0; i--) acc = over(parse(chain[i]), acc);
    return acc;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    return true;
  };
  const failures = [];
  let checked = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') || el.closest('.sr-only') || el.matches('script,style,noscript')) continue;
    if (el.disabled || el.closest('button:disabled')) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim() !== '').map((n) => n.textContent.trim()).join(' ');
    if (own === '' || !visible(el)) continue;
    const style = getComputedStyle(el);
    const bg = background(el);
    const fg = over(parse(style.color), { ...bg, a: 1 });
    const l1 = lum(fg), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    checked += 1;
    if (ratio < 4.5) failures.push({ text: own.slice(0, 60), tag: el.tagName.toLowerCase(), cls: el.className && el.className.baseVal === undefined ? String(el.className) : '', ratio: Math.round(ratio * 100) / 100, fg: style.color, bg: 'rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(',') + ')' });
  }
  return { checked, failures };
})()`;

/** Interactive elements without an accessible name, and images without alt. */
export const NAME_AUDIT = `(() => {
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label');
    if (label && label.trim() !== '') return label.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? text(n) : ''; }).join(' ').trim();
      if (t !== '') return t;
    }
    if (el.labels && el.labels.length > 0) return [...el.labels].map(text).join(' ').trim();
    const own = text(el);
    if (own !== '') return own;
    const title = el.getAttribute('title');
    return title ? title.trim() : '';
  };
  const unnamed = [];
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [tabindex="0"]';
  for (const el of document.querySelectorAll(selector)) {
    if (el.closest('[hidden]') || el.closest('[aria-hidden=true]')) continue;
    if (nameOf(el) === '') unnamed.push(el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || ''));
  }
  const noAlt = [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).map((i) => i.getAttribute('src'));
  const badLabels = [...document.querySelectorAll('[aria-labelledby]')].filter((el) => !el.getAttribute('aria-labelledby').split(/\\s+/).every((id) => document.getElementById(id))).map((el) => el.tagName.toLowerCase());
  const duplicateIds = [...document.querySelectorAll('[id]')].map((e) => e.id).filter((id, i, all) => all.indexOf(id) !== i);
  return { unnamed, noAlt, badLabels, duplicateIds };
})()`;
