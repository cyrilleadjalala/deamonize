/**
 * Heal mode, the part that runs inside a replay: when every deterministic locator of a step failed (or the page
 * has no DOM target), find the element another way and perform the action.
 *
 * Order, from cheapest and most deterministic to the model:
 *   1. a locator cached by an earlier heal (no model call);
 *   2. for a step recorded where there is no DOM (a canvas), the centre of its recorded relative rectangle;
 *   3. the model: a screenshot with numbered marks, the recorded thumbnail and the intent of the step.
 * The repaired locator of a model answer goes to the heal cache. Nothing here writes the workflow file.
 *
 * Standalone like the other heal modules: it uses Node built-ins, `fetch` (in the providers) and a structural
 * page type, so the compiler copies `src/heal/` verbatim into `<out>/heal/` when compiled with `--heal-support`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HealCache, healCacheKey, healCachePath, type CachedLocator } from './cache.js';
import { validateHealResult, type HealResult, type Healer, type Mark, type Viewport } from './healer.js';
import { buildMarks, type MarksPage } from './marks.js';
import { resolveHealer, type HealerResolution } from './providers/index.js';

export type HealSource = 'cache' | 'coordinates' | 'model';

/** The few Playwright locator calls a heal needs. */
export interface HealLocator {
  count(): Promise<number>;
  click(options?: { timeout?: number }): Promise<void>;
  hover(options?: { timeout?: number }): Promise<void>;
  fill(text: string, options?: { timeout?: number }): Promise<void>;
  selectOption(value: string, options?: { timeout?: number }): Promise<unknown>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
}

/** The subset of a Playwright Page used here (kept structural so this module needs no browser package). */
export interface HealPage extends MarksPage {
  url(): string;
  mouse: { click(x: number, y: number): Promise<void>; move(x: number, y: number): Promise<void> };
  keyboard: { press(key: string): Promise<void>; insertText(text: string): Promise<void>; type(text: string): Promise<void> };
  getByRole(role: string, options?: { name?: string; exact?: boolean }): HealLocator;
  getByText(text: string, options?: { exact?: boolean }): HealLocator;
  locator(selector: string): HealLocator;
}

/** The part of a workflow step a heal reads. */
export interface HealStepData {
  actionType: string;
  selectors: string[];
  label?: string;
  anchor?: { role: string; name: string };
  risk?: 'read' | 'write' | 'delete';
  allowHeal?: boolean;
  secretRef?: string;
  visual?: { thumbnailPath?: string; rect: { x: number; y: number; w: number; h: number }; intent: string };
}

export interface HealInput {
  page: HealPage;
  step: HealStepData;
  stepIndex: number;
  /** The value the step types or selects (already resolved: payload, secret or recorded). */
  value?: string;
  /** The step has no DOM target (a canvas): its recorded rectangle may be used before the model. */
  noDomTarget: boolean;
  timeoutMs: number;
  /** Values removed from every reason this returns. */
  secrets?: string[];
}

export type HealOutcome =
  | { ok: true; source: HealSource }
  | { ok: false; unavailable: boolean; reason: string };

export interface HealSessionOptions {
  env?: NodeJS.ProcessEnv;
  workflowId: string;
  /** The folder of the generated server: the cache and the recorded thumbnails live under its `.daemonize/`. */
  baseDir: string;
  /** Files the cache must never be (the workflow file). */
  protectedPaths?: string[];
  /** Replaces the lookup of the healer (tests). */
  loadHealer?: (env: NodeJS.ProcessEnv) => Promise<HealerResolution>;
}

export interface HealSession {
  heal(input: HealInput): Promise<HealOutcome>;
}

// ---------------------------------------------------------------------------
// The healer: the model providers, or a test module
// ---------------------------------------------------------------------------

/** A `${NAME}` that a host left unexpanded is "not set", not a value. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || /^\s*\$\{[^}]*\}\s*$/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

/** The test healer module is honoured only under NODE_ENV=test or with the documented unsafe flag. */
export function healerModuleAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' || env.DAEMONIZE_UNSAFE_HEALER_MODULE === '1';
}

/**
 * The healer to use, from `DAEMONIZE_MODEL_*`. `DAEMONIZE_HEALER_MODULE` (a module exporting `createHealer(env)` or a
 * default healer) replaces the providers, but only where `healerModuleAllowed`; elsewhere it is ignored.
 */
export async function loadHealer(env: NodeJS.ProcessEnv = process.env): Promise<HealerResolution> {
  const clean = cleanEnv(env);
  const modulePath = clean.DAEMONIZE_HEALER_MODULE?.trim();
  if (modulePath && healerModuleAllowed(clean)) {
    try {
      const mod = (await import(pathToFileURL(resolve(modulePath)).href)) as Record<string, unknown>;
      const made = mod.createHealer ?? mod.default;
      const healer = (typeof made === 'function' ? await (made as (e: NodeJS.ProcessEnv) => unknown)(clean) : made) as Healer | undefined;
      if (healer !== undefined && typeof healer.locate === 'function') {
        return { available: true, healer, provider: 'module', model: 'module' };
      }
      return { available: false, reason: 'the healer module does not export a healer' };
    } catch (err) {
      return { available: false, reason: `the healer module could not be loaded: ${(err as Error).message.split(/\r?\n/)[0]}` };
    }
  }
  return resolveHealer(clean);
}

// ---------------------------------------------------------------------------
// Acting and checking
// ---------------------------------------------------------------------------

const CHANGE_POLL_MS = 100;
const CHANGE_WAIT_MS = 1500;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0];

/** A cheap description of what the user could see: the address and a hash of the screenshot. */
async function fingerprint(page: HealPage): Promise<string> {
  const png = await page.screenshot({ type: 'png' });
  return `${page.url()}|${createHash('sha1').update(png).digest('hex')}`;
}

/** Actions that have no visible effect of their own are not checked. */
const UNCHECKED_ACTIONS = new Set(['hover', 'scrollIntoView']);

interface Attempt {
  ok: boolean;
  /** The action may have started: a write or delete step must not be repeated. */
  acted: boolean;
  reason?: string;
}

/**
 * Run one way of performing the step and check, leniently, that something happened: the address or the picture
 * of the page changed. `run` calls `started()` right before it acts.
 */
async function attempt(
  page: HealPage,
  step: HealStepData,
  run: (started: () => void) => Promise<void>
): Promise<Attempt> {
  const before = await fingerprint(page).catch(() => undefined);
  let acted = false;
  try {
    await run(() => {
      acted = true;
    });
  } catch (err) {
    return { ok: false, acted, reason: firstLine(err) };
  }
  if (UNCHECKED_ACTIONS.has(step.actionType) || before === undefined) return { ok: true, acted };
  const until = Date.now() + CHANGE_WAIT_MS;
  for (; ;) {
    // A page that cannot be photographed any more (closed, navigating) did change
    const after = await fingerprint(page).catch(() => undefined);
    if (after === undefined || after !== before) return { ok: true, acted };
    if (Date.now() >= until) return { ok: false, acted, reason: 'the action had no visible effect (the page is unchanged)' };
    await sleep(CHANGE_POLL_MS);
  }
}

async function actAtPoint(page: HealPage, step: HealStepData, value: string | undefined, x: number, y: number): Promise<void> {
  switch (step.actionType) {
    case 'click':
      await page.mouse.click(x, y);
      return;
    case 'hover':
    case 'scrollIntoView':
      await page.mouse.move(x, y);
      return;
    case 'type':
      await page.mouse.click(x, y);
      await page.keyboard.press('ControlOrMeta+A');
      if (value === undefined || value === '') await page.keyboard.press('Delete');
      else await page.keyboard.insertText(value);
      return;
    case 'select':
      // No element to ask for its options: open it, type the option and confirm
      await page.mouse.click(x, y);
      if (value !== undefined && value !== '') await page.keyboard.type(value);
      await page.keyboard.press('Enter');
      return;
    case 'keypress':
    case 'form_submit':
      await page.mouse.click(x, y);
      await page.keyboard.press(value ?? 'Enter');
      return;
    default:
      throw new Error(`Unknown action type: ${step.actionType}`);
  }
}

async function actOnLocator(locator: HealLocator, step: HealStepData, value: string | undefined, timeout: number): Promise<void> {
  switch (step.actionType) {
    case 'click':
      await locator.click({ timeout });
      return;
    case 'hover':
      await locator.hover({ timeout });
      return;
    case 'scrollIntoView':
      await locator.scrollIntoViewIfNeeded({ timeout });
      return;
    case 'type':
      await locator.fill(value ?? '', { timeout });
      return;
    case 'select':
      await locator.selectOption(value ?? '', { timeout });
      return;
    case 'keypress':
    case 'form_submit':
      await locator.press(value ?? 'Enter', { timeout });
      return;
    default:
      throw new Error(`Unknown action type: ${step.actionType}`);
  }
}

function locatorOf(page: HealPage, cached: CachedLocator): HealLocator | undefined {
  if ('role' in cached) return page.getByRole(cached.role, { name: cached.name, exact: true });
  if ('text' in cached) return page.getByText(cached.text, { exact: true });
  if ('css' in cached) return page.locator(cached.css);
  return undefined;
}

function viewportOf(page: HealPage): Viewport {
  return page.viewportSize() ?? { width: 1280, height: 720 };
}

function pointOf(box: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The cached locator a model answer deserves: the accessible name when it is unique now, else the point. */
async function repairedLocator(page: HealPage, mark: Mark | undefined, point: { x: number; y: number }, viewport: Viewport): Promise<CachedLocator> {
  if (mark?.role !== undefined && mark.name !== undefined && mark.name !== '' && mark.role !== 'clickable') {
    const unique = await page.getByRole(mark.role, { name: mark.name, exact: true }).count().catch(() => 0);
    if (unique === 1) return { role: mark.role, name: mark.name };
  }
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return { point: { x: clamp(point.x / viewport.width), y: clamp(point.y / viewport.height) } };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export function createHealSession(options: HealSessionOptions): HealSession {
  const env = options.env ?? process.env;
  let healerLookup: Promise<HealerResolution> | undefined;
  let cache: HealCache | undefined;
  let cacheChecked = false;

  const getHealer = (): Promise<HealerResolution> => {
    healerLookup ??= (options.loadHealer ?? loadHealer)(env);
    return healerLookup;
  };
  const getCache = (): HealCache | undefined => {
    if (!cacheChecked) {
      cacheChecked = true;
      try {
        cache = new HealCache(healCachePath(options.baseDir, env), { protectedPaths: options.protectedPaths });
      } catch {
        // A cache that would overwrite the workflow file is not used at all
        cache = undefined;
      }
    }
    return cache;
  };

  const readThumbnail = async (step: HealStepData): Promise<Buffer | undefined> => {
    const recorded = step.visual?.thumbnailPath;
    if (recorded === undefined) return undefined;
    const name = recorded.split(/[\\/]/).pop() as string;
    const dir = env.DAEMONIZE_ANCHORS_DIR?.trim() ? resolve(env.DAEMONIZE_ANCHORS_DIR) : join(options.baseDir, '.daemonize', 'anchors');
    try {
      return await readFile(join(dir, name));
    } catch {
      return undefined;
    }
  };

  async function heal(input: HealInput): Promise<HealOutcome> {
    const { page, step } = input;
    const risk = step.risk ?? 'read';
    const secrets = [
      ...(input.secrets ?? []),
      ...[env.DAEMONIZE_MODEL_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY].filter((v): v is string => !!v),
    ];
    const clean = (text: string): string => {
      let out = text;
      for (const secret of secrets) if (secret !== '') out = out.split(secret).join('***');
      return out.slice(0, 300);
    };
    const fail = (reason: string, unavailable = false): HealOutcome => ({ ok: false, unavailable, reason: clean(reason) });
    const viewport = viewportOf(page);
    const key = healCacheKey({
      workflowId: options.workflowId,
      stepIndex: input.stepIndex,
      anchor: step.anchor === undefined ? undefined : `${step.anchor.role}|${step.anchor.name}`,
      intent: step.visual?.intent,
    });

    // 1. A locator an earlier heal found
    const store = getCache();
    const cached = await store?.get(key).catch(() => undefined);
    if (cached !== undefined) {
      const known = cached.locator;
      const tried = await attempt(page, step, async (started) => {
        if ('point' in known) {
          started();
          await actAtPoint(page, step, input.value, known.point.x * viewport.width, known.point.y * viewport.height);
          return;
        }
        const locator = locatorOf(page, known);
        if (locator === undefined || (await locator.count()) !== 1) throw new Error('the cached locator does not match exactly one element');
        started();
        await actOnLocator(locator, step, input.value, input.timeoutMs);
      });
      if (tried.ok) return { ok: true, source: 'cache' };
      await store?.drop(key).catch(() => undefined);
      if (tried.acted && risk !== 'read') {
        return fail(`the cached locator was used but its effect was not seen (${tried.reason}); a ${risk} step is not repeated`);
      }
    }

    // 2. No DOM: the recorded rectangle, relative to the viewport
    if (input.noDomTarget && step.visual !== undefined) {
      const r = step.visual.rect;
      const point = { x: (r.x + r.w / 2) * viewport.width, y: (r.y + r.h / 2) * viewport.height };
      const tried = await attempt(page, step, async (started) => {
        started();
        await actAtPoint(page, step, input.value, point.x, point.y);
      });
      if (tried.ok) return { ok: true, source: 'coordinates' };
      if (tried.acted && risk !== 'read') {
        return fail(`the recorded coordinates were used but their effect was not seen (${tried.reason}); a ${risk} step is not repeated`);
      }
    }

    // 3. The model
    const resolution = await getHealer();
    if (!resolution.available) return fail(resolution.reason, true);

    let built;
    try {
      built = await buildMarks(page);
    } catch (err) {
      return fail(`the page could not be marked: ${firstLine(err)}`);
    }
    const thumbnail = await readThumbnail(step);
    let answer: unknown;
    try {
      answer = await resolution.healer.locate({
        screenshotPng: built.screenshotPng,
        marks: built.marks,
        anchorThumbnailPng: thumbnail,
        intent: step.visual?.intent ?? step.label ?? step.actionType,
        step: {
          action: step.actionType,
          ...(step.anchor !== undefined && step.secretRef === undefined ? { role: step.anchor.role, name: step.anchor.name } : {}),
        },
        viewport,
      });
    } catch (err) {
      answer = { kind: 'none', reason: `the model call failed: ${firstLine(err)}` };
    }
    const result: HealResult = validateHealResult(answer, built.marks, viewport);
    if (result.kind === 'none') return fail(result.reason);

    const mark = result.kind === 'mark' ? built.marks.find((m) => m.id === result.markId) : undefined;
    const point = result.kind === 'mark' ? pointOf((mark as Mark).box) : { x: result.x, y: result.y };
    // The locator to remember is decided before the action, while the page is as the model saw it
    const repaired = await repairedLocator(page, mark, point, viewport);
    const done = await attempt(page, step, async (started) => {
      started();
      await actAtPoint(page, step, input.value, point.x, point.y);
    });
    if (!done.ok) return fail(`the located element was used but ${done.reason ?? 'the action failed'}`);
    await store?.put(key, repaired).catch(() => undefined);
    return { ok: true, source: 'model' };
  }

  return { heal };
}
