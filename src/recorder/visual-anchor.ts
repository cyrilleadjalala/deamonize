import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Frame, Locator, Page } from 'playwright';
import { deserializeWorkflowSet } from '../workflow/workflow-set.js';
import type { Anchor, StepActionType, VisualAnchor, Workflow, WorkflowSet } from '../types.js';

/** A rectangle in CSS pixels of the page viewport. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** What the intent description is built from: nothing typed, only names. */
export interface VisualStep {
  actionType: StepActionType;
  anchor?: Anchor;
  label?: string;
  secretRef?: string;
}

export interface VisualOptions {
  /** The Workflow file the step belongs to: thumbnails go to `<file>.assets/` next to it. */
  workflowFile: string;
  workflowId: string;
  /** Index of the step in its workflow. */
  index: number;
  /** false: keep rect and intent, never take a picture. */
  thumbnail?: boolean;
}

export interface CapturedVisual {
  visual: VisualAnchor;
  /** A thumbnail file was written. */
  saved: boolean;
}

export const MAX_THUMBNAIL_WIDTH = 160;
export const MAX_THUMBNAIL_HEIGHT = 120;
export const MAX_THUMBNAIL_BYTES = 20 * 1024;
export const CLIP_PADDING = 6;

const PRECISION = 10000;
const LOCATE_TIMEOUT_MS = 1000;
const DOWNSCALE_FACTORS = [1, 0.75, 0.5, 0.35];

/** Fields whose picture is never taken: passwords, one-time codes and tokens. */
const SENSITIVE_SELECTOR = [
  'input[type="password"]',
  '[autocomplete~="current-password"]',
  '[autocomplete~="new-password"]',
  '[autocomplete~="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="token" i]',
  'input[id*="token" i]',
  'input[name*="passw" i]',
  'input[id*="passw" i]',
].join(', ');

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The box as fractions of the viewport: x, y, w and h are in [0, 1] with x + w <= 1 and y + h <= 1.
 * The part of the box outside the viewport is cut; a box fully outside has a zero size.
 */
export function normalizeRect(box: Box, viewport: Viewport): VisualAnchor['rect'] {
  const axis = (start: number, size: number, total: number): [number, number] => {
    if (!Number.isFinite(start) || !Number.isFinite(size) || !Number.isFinite(total) || total <= 0) return [0, 0];
    const from = clamp(start / total, 0, 1);
    const to = clamp((start + Math.max(0, size)) / total, 0, 1);
    let a = Math.round(from * PRECISION);
    let b = Math.min(Math.round(Math.max(0, to - from) * PRECISION), PRECISION - a);
    // Decimal fractions may add up to slightly more than 1 in floating point
    while (b > 0 && a / PRECISION + b / PRECISION > 1) b -= 1;
    a = clamp(a, 0, PRECISION);
    return [a / PRECISION, b / PRECISION];
  };
  const [x, w] = axis(box.x, box.width, viewport.width);
  const [y, h] = axis(box.y, box.height, viewport.height);
  return { x, y, w, h };
}

/** The area to photograph: the box with a padding, rounded outwards to whole pixels and kept inside the viewport. */
export function padClip(box: Box, viewport: Viewport, padding = CLIP_PADDING): Box {
  const left = clamp(Math.floor(box.x - padding), 0, Math.max(0, viewport.width));
  const top = clamp(Math.floor(box.y - padding), 0, Math.max(0, viewport.height));
  const right = clamp(Math.ceil(box.x + box.width + padding), 0, Math.max(0, viewport.width));
  const bottom = clamp(Math.ceil(box.y + box.height + padding), 0, Math.max(0, viewport.height));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Size of the thumbnail: the clip scaled down to fit in 160x120, never enlarged. */
export function fitSize(width: number, height: number, factor = 1): { width: number; height: number } {
  const scale = Math.min(1, MAX_THUMBNAIL_WIDTH / width, MAX_THUMBNAIL_HEIGHT / height) * factor;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Where a thumbnail goes, relative to the Workflow file (forward slashes, as stored in the file). */
export function thumbnailRelativePath(workflowFile: string, workflowId: string, index: number): string {
  return `${assetsDirName(workflowFile)}/step-${workflowId}-${index}.png`;
}

function assetsDirName(workflowFile: string): string {
  return `${basename(workflowFile)}.assets`;
}

export function assetsDirOf(workflowFile: string): string {
  return join(dirname(resolve(workflowFile)), assetsDirName(workflowFile));
}

/** Absolute path of a thumbnail referenced by a relative path of a Workflow file. */
export function resolveThumbnail(workflowFile: string, thumbnailPath: string): string {
  return resolve(dirname(resolve(workflowFile)), thumbnailPath);
}

const NOUNS: Record<string, string> = {
  textbox: 'field',
  searchbox: 'field',
  spinbutton: 'field',
  combobox: 'combobox',
  listbox: 'list',
  menuitem: 'menu item',
  checkbox: 'checkbox',
  radio: 'radio button',
  option: 'option',
  tab: 'tab',
  switch: 'switch',
};

const VERBS: Partial<Record<StepActionType, string>> = {
  click: 'Click',
  type: 'Type into',
  select: 'Select an option in',
  hover: 'Hover over',
  keypress: 'Press a key in',
  scrollIntoView: 'Scroll to',
};

const MAX_NAME = 60;

function shorten(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > MAX_NAME ? `${one.slice(0, MAX_NAME - 1)}…` : one;
}

/**
 * A short description of what the step does to its target, built from the role, the accessible name and the
 * enclosing context: `Click the button 'Save' in the dialog 'Edit customer'`. Typed values never appear in it.
 */
export function buildIntent(step: VisualStep): string {
  const verb = VERBS[step.actionType] ?? 'Use';
  const anchor = step.anchor;
  const role = anchor?.role ?? '';
  const noun = NOUNS[role] ?? (role === '' || role === 'document' ? 'element' : role);
  const name = anchor?.name !== undefined && anchor.name.trim() !== '' ? shorten(anchor.name) : undefined;
  let text = `${verb} the ${noun}${name === undefined ? '' : ` '${name}'`}`;
  const parent = anchor?.parent;
  if (parent !== undefined && parent.name.trim() !== '') {
    text += ` in the ${parent.kind} '${shorten(parent.name)}'`;
  } else if (name === undefined && step.label !== undefined && step.label.trim() !== '') {
    // Nothing better than the label recorded with the step
    text += ` (${shorten(step.label)})`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function viewportOf(page: Page): Promise<Viewport> {
  const size = page.viewportSize();
  if (size !== null) return size;
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

/** The boxes of the visible password, one-time-code and token fields of the page and its frames, in viewport pixels. */
async function sensitiveBoxes(page: Page, viewport: Viewport): Promise<Box[]> {
  const boxes: Box[] = [];
  const everything: Box = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  for (const frame of page.frames()) {
    let rects: Box[];
    try {
      rects = await frame.evaluate((selector) => {
        return Array.from(document.querySelectorAll(selector))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
      }, SENSITIVE_SELECTOR);
    } catch {
      // A frame that cannot be inspected is assumed to hide such a field
      boxes.push(everything);
      continue;
    }
    if (rects.length === 0) continue;
    let origin = { x: 0, y: 0 };
    if (frame.parentFrame() !== null) {
      const holder = await frame.frameElement().catch(() => undefined);
      const at = holder === undefined ? null : await holder.boundingBox().catch(() => null);
      await holder?.dispose().catch(() => { });
      if (at === null) {
        boxes.push(everything);
        continue;
      }
      origin = at;
    }
    for (const r of rects) boxes.push({ x: r.x + origin.x, y: r.y + origin.y, width: r.width, height: r.height });
  }
  return boxes;
}

/** Scale a PNG down inside the page (a canvas), so no image library is needed. */
async function downscale(page: Page, png: Buffer, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ({ data, w, h }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('no canvas');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      return canvas.toDataURL('image/png').split(',')[1];
    },
    { data: png.toString('base64'), w: width, h: height }
  );
  return Buffer.from(base64, 'base64');
}

/** A PNG of the clip that is at most 160x120 and 20 KB, or undefined when that cannot be reached. */
async function takeThumbnail(page: Page, clip: Box): Promise<Buffer | undefined> {
  // caret 'initial' and the default animations: hiding the caret leaves a `style=""` attribute on the focused
  // field, which would change the recorded final screen
  const shot = await page.screenshot({ type: 'png', clip, scale: 'css', caret: 'initial', style: '[data-daemonize-ui] { visibility: hidden !important }' });
  for (const factor of DOWNSCALE_FACTORS) {
    const size = fitSize(clip.width, clip.height, factor);
    let png: Buffer;
    try {
      png = await downscale(page, shot, size.width, size.height);
    } catch {
      // No canvas: the clip itself is the thumbnail when it is already small enough
      return clip.width <= MAX_THUMBNAIL_WIDTH && clip.height <= MAX_THUMBNAIL_HEIGHT && shot.length <= MAX_THUMBNAIL_BYTES
        ? shot
        : undefined;
    }
    if (png.length <= MAX_THUMBNAIL_BYTES) return png;
  }
  return undefined;
}

/** A Visual_Anchor and the picture that goes with it, not yet written to disk. */
export interface PreparedVisual {
  visual: VisualAnchor;
  png?: Buffer;
}

/**
 * Compute the Visual_Anchor of a step: the rect of its target as fractions of the viewport, an intent, and
 * a thumbnail (PNG bytes, at most 160x120 and 20 KB). The thumbnail is skipped (rect and intent are kept) for a
 * secret field, and when the area to photograph touches a password, one-time-code or token field.
 * Returns undefined when the target has no box (not found, not visible).
 */
export async function prepareVisualAnchor(
  frame: Frame | Page,
  target: Locator | Box,
  step: VisualStep,
  opts: { thumbnail?: boolean } = {}
): Promise<PreparedVisual | undefined> {
  const page = 'mainFrame' in frame ? frame : frame.page();
  const box = 'boundingBox' in target ? await target.boundingBox({ timeout: LOCATE_TIMEOUT_MS }) : target;
  if (box === null) return undefined;

  const viewport = await viewportOf(page);
  const visual: VisualAnchor = { rect: normalizeRect(box, viewport), intent: buildIntent(step) };
  if (opts.thumbnail === false || step.secretRef !== undefined) return { visual };

  const clip = padClip(box, viewport);
  if (clip.width < 1 || clip.height < 1) return { visual };

  try {
    const secrets = await sensitiveBoxes(page, viewport);
    if (secrets.some((s) => boxesIntersect(clip, s))) return { visual };
    if ('boundingBox' in target && (await isSensitiveElement(target))) return { visual };

    const png = await takeThumbnail(page, clip);
    return png === undefined ? { visual } : { visual, png };
  } catch {
    // The page went away (navigation) or cannot be photographed: rect and intent are still good
    return { visual };
  }
}

/** Write a thumbnail to `<workflowfile>.assets/` and return its path relative to the Workflow file. */
export async function writeThumbnail(png: Buffer, opts: Pick<VisualOptions, 'workflowFile' | 'workflowId' | 'index'>): Promise<string> {
  const relative = thumbnailRelativePath(opts.workflowFile, opts.workflowId, opts.index);
  const file = resolveThumbnail(opts.workflowFile, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, png);
  return relative;
}

/** `prepareVisualAnchor`, then the thumbnail is written and referenced by `visual.thumbnailPath`. */
export async function captureVisualAnchor(
  frame: Frame | Page,
  target: Locator | Box,
  step: VisualStep,
  opts: VisualOptions
): Promise<CapturedVisual | undefined> {
  const prepared = await prepareVisualAnchor(frame, target, step, opts);
  if (prepared === undefined) return undefined;
  if (prepared.png === undefined) return { visual: prepared.visual, saved: false };
  prepared.visual.thumbnailPath = await writeThumbnail(prepared.png, opts);
  return { visual: prepared.visual, saved: true };
}

async function isSensitiveElement(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((el, selector) => el.matches(selector) || el.closest(selector) !== null, SENSITIVE_SELECTOR, { timeout: LOCATE_TIMEOUT_MS })
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// Assets of a Workflow file
// ---------------------------------------------------------------------------

function referencedThumbnails(set: WorkflowSet): string[] {
  return (set.workflows ?? []).flatMap((w) =>
    (w.steps ?? []).flatMap((s) => (s.visual?.thumbnailPath === undefined ? [] : [s.visual.thumbnailPath]))
  );
}

/**
 * Delete the files of `<workflowfile>.assets/` that no step references any more (workflows replaced or removed).
 * Returns the names of the files deleted. The folder itself goes when it ends up empty.
 */
export async function pruneAssets(workflowFile: string): Promise<string[]> {
  const set = deserializeWorkflowSet(await readFile(workflowFile, 'utf-8'));
  const dir = assetsDirOf(workflowFile);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const kept = new Set(referencedThumbnails(set).map((p) => resolveThumbnail(workflowFile, p)));
  const deleted: string[] = [];
  for (const name of names) {
    if (kept.has(join(dir, name))) continue;
    await rm(join(dir, name), { force: true });
    deleted.push(name);
  }
  if (deleted.length === names.length) await rm(dir, { recursive: true, force: true });
  return deleted;
}

/**
 * Make the thumbnails of workflows that came from `fromFile` belong to `toFile`: the files are copied to
 * `<toFile>.assets/` and the paths of the steps are rewritten. A thumbnail whose file is missing is dropped
 * from its step. Returns the number of thumbnails the workflows reference afterwards.
 */
export async function adoptAssets(workflows: Workflow[], fromFile: string, toFile: string): Promise<number> {
  let count = 0;
  for (const workflow of workflows) {
    for (const step of workflow.steps) {
      const visual = step.visual;
      if (visual?.thumbnailPath === undefined) continue;
      const source = resolveThumbnail(fromFile, visual.thumbnailPath);
      const relative = `${assetsDirName(toFile)}/${basename(source)}`;
      const target = resolveThumbnail(toFile, relative);
      try {
        if (source !== target) {
          await mkdir(dirname(target), { recursive: true });
          await copyFile(source, target);
        } else {
          await readFile(source).then(() => undefined);
        }
        visual.thumbnailPath = relative;
        count += 1;
      } catch {
        delete visual.thumbnailPath;
      }
    }
  }
  return count;
}
