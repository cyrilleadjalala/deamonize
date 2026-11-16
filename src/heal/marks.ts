/**
 * Set-of-mark screenshots for heal mode: number the visible interactive elements, draw the numbers on the
 * page, take the screenshot, remove the overlay. Fields that hold a password or a one-time code are never
 * marked and their region is painted over before the picture is taken.
 *
 * The ranking, de-duplication and capping are pure functions; only `buildMarks` touches a page.
 */
import type { Box, Mark, Viewport } from './healer.js';

export const DEFAULT_MARK_CAP = 60;
export const UI_ATTRIBUTE = 'data-daemonize-ui';

/** A raw element found on the page, before ranking. */
export interface MarkCandidate {
  box: Box;
  role?: string;
  name?: string;
  /** A CSS selector hint (e.g. `#save`) when the element has an id. */
  css?: string;
}

/** The subset of a Playwright Page that this module needs. */
export interface MarksPage {
  viewportSize(): { width: number; height: number } | null;
  evaluate<R>(script: string): Promise<R>;
  screenshot(options: { type: 'png' }): Promise<Buffer>;
}

export interface BuildMarksOptions {
  cap?: number;
}

export interface BuiltMarks {
  marks: Mark[];
  screenshotPng: Buffer;
}

const ROLE_WEIGHT: Record<string, number> = {
  button: 10,
  link: 9,
  textbox: 9,
  searchbox: 9,
  combobox: 8,
  checkbox: 8,
  radio: 8,
  switch: 8,
  menuitem: 7,
  tab: 7,
  option: 6,
  slider: 6,
  spinbutton: 6,
  clickable: 3,
};

function weight(candidate: MarkCandidate): number {
  const base = candidate.role ? (ROLE_WEIGHT[candidate.role] ?? 4) : 3;
  return base + (candidate.name ? 2 : 0);
}

/** Intersection of a box with the viewport, or undefined when nothing remains. */
export function clipToViewport(box: Box, viewport: Viewport): Box | undefined {
  const x1 = Math.max(0, box.x);
  const y1 = Math.max(0, box.y);
  const x2 = Math.min(viewport.width, box.x + box.width);
  const y2 = Math.min(viewport.height, box.y + box.height);
  if (!(x2 > x1) || !(y2 > y1)) return undefined;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Intersection over union of two boxes, 0 when they do not touch. */
export function overlapRatio(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

export function locatorHintFor(candidate: Pick<MarkCandidate, 'role' | 'name' | 'css'>): string | undefined {
  const q = (s: string) => JSON.stringify(s);
  if (candidate.role && candidate.role !== 'clickable' && candidate.name) {
    return `getByRole(${q(candidate.role)}, { name: ${q(candidate.name)} })`;
  }
  if (candidate.css) return `locator(${q(candidate.css)})`;
  if (candidate.name) return `getByText(${q(candidate.name)})`;
  return undefined;
}

/**
 * Rank, clip, de-duplicate and cap the candidates, then number them 1..n in reading order.
 * Important roles win when there are more than `cap`; near-identical boxes keep only the best one.
 */
export function rankMarks(candidates: MarkCandidate[], viewport: Viewport, cap = DEFAULT_MARK_CAP): Mark[] {
  const clipped: MarkCandidate[] = [];
  for (const c of candidates) {
    const box = clipToViewport(c.box, viewport);
    if (!box || box.width < 4 || box.height < 4) continue;
    clipped.push({ ...c, box });
  }
  // Best first; ties broken by position so the result is deterministic
  const ordered = clipped
    .map((c, i) => ({ c, i }))
    .sort((a, b) => weight(b.c) - weight(a.c) || a.c.box.y - b.c.box.y || a.c.box.x - b.c.box.x || a.i - b.i)
    .map((e) => e.c);
  const kept: MarkCandidate[] = [];
  for (const c of ordered) {
    if (kept.length >= Math.max(0, cap)) break;
    if (kept.some((k) => overlapRatio(k.box, c.box) > 0.85)) continue;
    kept.push(c);
  }
  kept.sort((a, b) => Math.round(a.box.y / 10) - Math.round(b.box.y / 10) || a.box.x - b.box.x);
  return kept.map((c, i) => {
    const mark: Mark = { id: i + 1, box: c.box };
    if (c.role) mark.role = c.role;
    if (c.name) mark.name = c.name;
    const hint = locatorHintFor(c);
    if (hint) mark.locatorHint = hint;
    return mark;
  });
}

/** Runs in the page: lists visible interactive elements and the regions that must be blanked. */
const COLLECT_SCRIPT = `(() => {
  const SELECTOR = 'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]';
  const vw = window.innerWidth, vh = window.innerHeight;
  const IMPLICIT = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' };
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox' };
  const isSecret = (el) => {
    if (!(el instanceof HTMLInputElement)) return false;
    const type = (el.type || '').toLowerCase();
    const hay = [el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.placeholder].join(' ').toLowerCase();
    return type === 'password' || /one-time-code|otp|totp|2fa|verification code/.test(hay);
  };
  const visible = (el, r) => {
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    if (el.labels && el.labels.length) return el.labels[0].innerText.trim();
    if (el.placeholder) return el.placeholder.trim();
    if (el.title) return el.title.trim();
    const text = (el.innerText || '').trim().replace(/\\s+/g, ' ');
    return text.slice(0, 80);
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.tagName === 'INPUT') return INPUT_ROLE[(el.type || 'text').toLowerCase()] || 'textbox';
    if (IMPLICIT[el.tagName]) return IMPLICIT[el.tagName];
    return 'clickable';
  };
  const candidates = [], secrets = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (el.closest('[${UI_ATTRIBUTE}]')) continue;
    if (el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const box = { x: r.left, y: r.top, width: r.width, height: r.height };
    if (isSecret(el)) { secrets.push(box); continue; }
    const out = { box, role: roleOf(el), name: nameOf(el) || undefined };
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) out.css = '#' + el.id;
    candidates.push(out);
  }
  return { candidates, secrets };
})()`;

/** Runs in the page: draws the labels and the blank regions. Every node carries the UI attribute. */
function overlayScript(marks: Mark[], secrets: Box[]): string {
  return `((marks, secrets) => {
  const root = document.createElement('div');
  root.setAttribute('${UI_ATTRIBUTE}', '');
  root.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';
  for (const s of secrets) {
    const blank = document.createElement('div');
    blank.setAttribute('${UI_ATTRIBUTE}', '');
    blank.style.cssText = 'position:fixed;background:#000;left:' + s.x + 'px;top:' + s.y + 'px;width:' + s.width + 'px;height:' + s.height + 'px;';
    root.appendChild(blank);
  }
  for (const m of marks) {
    const frame = document.createElement('div');
    frame.setAttribute('${UI_ATTRIBUTE}', '');
    frame.style.cssText = 'position:fixed;outline:2px solid #e11d48;left:' + m.box.x + 'px;top:' + m.box.y + 'px;width:' + m.box.width + 'px;height:' + m.box.height + 'px;';
    const label = document.createElement('span');
    label.setAttribute('${UI_ATTRIBUTE}', '');
    label.textContent = String(m.id);
    label.style.cssText = 'position:absolute;left:0;top:0;background:#e11d48;color:#fff;font:bold 11px/1 monospace;padding:1px 3px;';
    frame.appendChild(label);
    root.appendChild(frame);
  }
  document.documentElement.appendChild(root);
})(${JSON.stringify(marks)}, ${JSON.stringify(secrets)})`;
}

const REMOVE_SCRIPT = `(() => { for (const n of Array.from(document.querySelectorAll('[${UI_ATTRIBUTE}]'))) n.remove(); })()`;

/** Mark the page, take the screenshot, and always remove the overlay afterwards. */
export async function buildMarks(page: MarksPage, options: BuildMarksOptions = {}): Promise<BuiltMarks> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const found = await page.evaluate<{ candidates: MarkCandidate[]; secrets: Box[] }>(COLLECT_SCRIPT);
  const marks = rankMarks(found.candidates, viewport, options.cap ?? DEFAULT_MARK_CAP);
  try {
    await page.evaluate<void>(overlayScript(marks, found.secrets));
    const screenshotPng = await page.screenshot({ type: 'png' });
    return { marks, screenshotPng };
  } finally {
    await page.evaluate<void>(REMOVE_SCRIPT).catch(() => undefined);
  }
}
