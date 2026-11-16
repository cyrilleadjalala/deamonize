/**
 * Strict Level 2 execution of one web step with Playwright, shared by the generated
 * run-time (copied verbatim into the output directory) and the tests.
 *
 * Imports only Playwright types and the sibling runtime modules, never anything from src/.
 * What does not need a browser (candidate order, which candidate to use, the failure
 * diagnostic) lives in step-plan.ts.
 *
 * Every step is resolved by its accessible role and name, in the recorded parent context,
 * in the recorded frame, on the recorded page, or inside the row bound to a Variable.
 * Nothing is guessed: a locator that matches several elements is a failure.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Frame, Locator, Page } from 'playwright';
import { WEB_ZONE_FUNCTION, finishWebZone, notFoundMessage, zoneFailure, type RawWebZone, type ZoneLike, type ZoneOutcome } from './extract.js';
import { resolveRowStep } from './row-resolver.js';
import { waitForEffect, type SettlePage } from './settle.js';
import {
  MAX_ACCESSIBLE_NAME,
  MAX_THUMBNAIL_BYTES,
  StepExecutionError,
  decideCandidate,
  explainState,
  frameHintSelector,
  planLocators,
  redactSecrets,
  resolveStepValue,
  type CandidateState,
  type LocatorCandidate,
  type ScopeKind,
  type StepLike,
} from './step-plan.js';

type Role = Parameters<Page['getByRole']>[0];

/** The pages of one replay, in opening order (0 is the first page), and the page the steps run on. */
export interface WebRun {
  pages: Page[];
  current: number;
  /** Secret values typed so far: removed from every diagnostic. */
  secrets: string[];
}

export function createWebRun(context: BrowserContext, first: Page): WebRun {
  const run: WebRun = { pages: [first], current: 0, secrets: [] };
  context.on('page', (page) => {
    if (!run.pages.includes(page)) run.pages.push(page);
  });
  return run;
}

export interface StepOptions {
  /** Time the step has to find its element and act on it. */
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  /** The clock used for one-time codes (default: now). */
  nowMs?: number;
}

const POLL_MS = 50;
const FRAME_PROBE_MS = 100;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split(/\r?\n/)[0];
}

/** The meaningful line of an error thrown by the row resolver inside the page. */
function rowMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const match = /(ROW_NOT_FOUND|AMBIGUOUS_ROW|ROW_VARIABLE_MISSING|ROW_KEY_EMPTY):[^\n]*/.exec(text);
  return match !== null ? match[0] : firstLine(err);
}

/**
 * Execute one step. Resolves when the step was performed and its effect observed;
 * throws StepExecutionError (with the locators tried and the reason) when no locator worked.
 */
export async function executeWebStep(
  run: WebRun,
  step: StepLike,
  variables: Record<string, unknown>,
  options: StepOptions
): Promise<void> {
  if (step.actionType === 'switch_page') {
    await switchPage(run, step, options.timeoutMs);
    return;
  }

  let value: string | undefined;
  try {
    // For a one-time-code step this is the current code, computed now so it cannot expire while earlier steps ran
    value = resolveStepValue(step, variables, options.env ?? process.env, options.nowMs);
  } catch (err) {
    throw new StepExecutionError([], redactSecrets((err as Error).message, run.secrets));
  }
  if (step.secretRef !== undefined && value !== undefined && !run.secrets.includes(value)) run.secrets.push(value);

  const plan = planLocators(step, variables);
  if (plan.length === 0) {
    throw new StepExecutionError(
      [],
      step.anchor?.role === 'canvas'
        ? 'the step was recorded on a canvas, which has no accessible target: only heal mode can replay it, by coordinates'
        : 'the step has neither an accessible anchor nor a selector',
      true
    );
  }
  const page = run.pages[run.current];
  if (page === undefined || page.isClosed()) {
    throw new StepExecutionError(plan.map((c) => c.description), `page ${run.current} is closed`);
  }

  // The wait on the effect starts before the action, so what the action itself triggers is seen
  await waitForEffect(page as unknown as SettlePage, {
    timeoutMs: options.timeoutMs,
    action: () => locateAndAct(page, step, plan, variables, value, options.timeoutMs),
  });
}

async function switchPage(run: WebRun, step: StepLike, timeoutMs: number): Promise<void> {
  const target = step.anchor?.popup?.page;
  if (typeof target !== 'number') {
    throw new StepExecutionError([], 'a switch_page step without the number of its page');
  }
  const opens = step.anchor?.popup?.opens === true;
  const tried = [opens ? `wait for page ${target} to open` : `go back to page ${target}`];
  const until = Date.now() + timeoutMs;
  while (run.pages.length <= target && Date.now() < until) await sleep(25);

  const page = run.pages[target];
  if (page === undefined) {
    throw new StepExecutionError(tried, `the pop-up never opened: ${run.pages.length} page(s) exist, page ${target} was expected`);
  }
  if (page.isClosed()) {
    throw new StepExecutionError(tried, `page ${target} is closed`);
  }
  await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, until - Date.now()) }).catch(() => { });
  run.current = target;
  await page.bringToFront().catch(() => { });
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

interface FrameRef {
  frame: Frame;
  key: string;
  label: string;
}

type FrameHint = { name?: string; title?: string; src?: string };

/** A frame found by position must still look like the recorded one: its name, title or source is the recorded one. */
async function matchesHint(handle: { evaluate<R>(fn: (el: Element) => R): Promise<R> }, hint: FrameHint): Promise<boolean> {
  const recorded = [hint.name, hint.title, hint.src].filter((v): v is string => v !== undefined && v !== '');
  if (recorded.length === 0) return true;
  const actual = await handle.evaluate((el: Element) => [el.getAttribute('name'), el.getAttribute('title'), el.getAttribute('src')]);
  return recorded.some((value) => actual.includes(value));
}

async function walkFrames(
  root: Frame,
  levels: Array<{ locate: (frame: Frame) => Locator; verify?: FrameHint }>
): Promise<Frame | undefined> {
  let frame = root;
  for (const level of levels) {
    try {
      const handle = await level.locate(frame).elementHandle({ timeout: FRAME_PROBE_MS });
      if (handle === null) return undefined;
      if (level.verify !== undefined && !(await matchesHint(handle, level.verify))) {
        await handle.dispose();
        return undefined;
      }
      const next = await handle.contentFrame();
      await handle.dispose();
      if (next === null) return undefined;
      frame = next;
    } catch {
      return undefined;
    }
  }
  return frame;
}

/** The frame of the recorded index chain, then the one found through the name, title or source of the iframes. */
async function resolveFrames(page: Page, step: StepLike): Promise<FrameRef[]> {
  const main = page.mainFrame();
  const chain = step.anchor?.frame ?? [];
  if (chain.length === 0) return [{ frame: main, key: 'main', label: '' }];

  const out: FrameRef[] = [];
  // The frame at the recorded position, as long as it is still the recorded frame
  const hints = step.anchor?.frameHints;
  const byIndex = await walkFrames(
    main,
    chain.map((index, level) => ({ locate: (f: Frame) => f.locator('iframe, frame').nth(index), verify: hints?.[level] }))
  );
  if (byIndex !== undefined) out.push({ frame: byIndex, key: 'index', label: ` in the frame ${JSON.stringify(chain)}` });

  if (hints !== undefined && hints.length === chain.length) {
    const selectors = hints.map(frameHintSelector);
    if (selectors.every((s): s is string => s !== undefined)) {
      const byHints = await walkFrames(main, selectors.map((selector) => ({ locate: (f: Frame) => f.locator(selector) })));
      if (byHints !== undefined && byHints !== byIndex) {
        out.push({ frame: byHints, key: 'hints', label: ' in the frame found by its name, title or source' });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

const REGION_ROLES = ['listbox', 'menu', 'region', 'group', 'form', 'dialog', 'alertdialog'];

function scopeLocator(frame: Frame, scope: { kind: ScopeKind; name: string }): Locator {
  const exact = scope.name.length < MAX_ACCESSIBLE_NAME;
  const named = (role: string): Locator => frame.getByRole(role as Role, { name: scope.name, exact });
  if (scope.kind === 'dialog') return named('dialog').or(named('alertdialog'));
  if (scope.kind === 'region') return REGION_ROLES.map(named).reduce((all, one) => all.or(one));
  return frame
    .locator('section, fieldset, [role=region], [role=group]')
    .filter({ has: frame.getByRole('heading', { name: scope.name, exact }) });
}

function buildLocator(frame: Frame, candidate: LocatorCandidate, rowSelector: string | undefined): Locator {
  const root: Frame | Locator = candidate.inRow === true && rowSelector !== undefined ? frame.locator(rowSelector) : frame;
  if (candidate.role !== undefined) {
    const where: Frame | Locator = candidate.scope !== undefined ? scopeLocator(frame, candidate.scope) : root;
    return where.getByRole(candidate.role.role as Role, { name: candidate.role.name, exact: candidate.role.exact });
  }
  return root.locator(candidate.selector as string);
}

interface Pair {
  key: string;
  frame: Frame;
  candidate: LocatorCandidate;
  description: string;
}

async function locateAndAct(
  page: Page,
  step: StepLike,
  plan: LocatorCandidate[],
  variables: Record<string, unknown>,
  value: string | undefined,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const failed = new Map<string, string>();
  let lastTried: string[] = plan.map((c) => c.description);
  let lastReasons: string[] = [];
  let frameMissing = false;

  for (; ;) {
    const frames = await resolveFrames(page, step);
    frameMissing = frames.length === 0;
    // Candidate by candidate, in priority order, each in the frames found: a weak locator in one frame never beats a strong one in the other
    const pairs: Pair[] = plan.flatMap((candidate, i) =>
      frames.map((f) => ({
        key: `${f.key}|${i}`,
        frame: f.frame,
        candidate,
        description: candidate.description + f.label,
      }))
    );

    const states: CandidateState[] = [];
    const notes: Array<string | undefined> = [];
    const locators: Array<Locator | undefined> = [];
    const rows = new Map<Frame, { selector?: string; error?: string }>();

    for (const pair of pairs) {
      const failure = failed.get(pair.key);
      if (failure !== undefined) {
        states.push({ count: 0, failed: true });
        notes.push(failure);
        locators.push(undefined);
        continue;
      }
      if (pair.candidate.unusable !== undefined) {
        states.push({ count: 0, unusable: true });
        notes.push(pair.candidate.unusable);
        locators.push(undefined);
        continue;
      }
      let rowSelector: string | undefined;
      if (pair.candidate.inRow === true) {
        let row = rows.get(pair.frame);
        if (row === undefined) {
          try {
            const resolved = await resolveRowStep(pair.frame, step as Parameters<typeof resolveRowStep>[1], variables);
            row = { selector: resolved?.rowSelector };
          } catch (err) {
            row = { error: rowMessage(err) };
          }
          rows.set(pair.frame, row);
        }
        if (row.error !== undefined) {
          states.push({ count: 0, unusable: true });
          notes.push(row.error);
          locators.push(undefined);
          continue;
        }
        rowSelector = row.selector;
      }
      const locator = buildLocator(pair.frame, pair.candidate, rowSelector);
      let count = 0;
      let note: string | undefined;
      try {
        count = await locator.count();
      } catch (err) {
        note = firstLine(err);
      }
      states.push({ count });
      notes.push(note);
      locators.push(locator);
    }

    lastTried = pairs.length > 0 ? pairs.map((p) => p.description) : plan.map((c) => c.description);
    lastReasons = pairs.map((_, i) => `${i + 1}. ${explainState(states[i], notes[i])}`);

    const pick = decideCandidate(states, Date.now() - startedAt);
    if (pick !== undefined) {
      const pair = pairs[pick];
      try {
        await act(page, pair.frame, locators[pick] as Locator, step, value, Math.max(300, deadline - Date.now()));
        return;
      } catch (err) {
        const message = firstLine(err);
        failed.set(pair.key, `the action failed: ${message}`);
        const risk = step.risk ?? 'read';
        if (risk !== 'read') {
          // The action may have started: acting again could do it twice
          throw new StepExecutionError(
            lastTried,
            `the action failed on ${pair.description}: ${message}. A ${risk} step is never retried in strict mode`
          );
        }
      }
    }

    if (Date.now() >= deadline) break;
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }

  if (frameMissing) {
    const hints = step.anchor?.frameHints;
    throw new StepExecutionError(
      lastTried,
      `the frame ${JSON.stringify(step.anchor?.frame ?? [])}${hints !== undefined ? ' (and its name, title or source)' : ''} was not found within ${timeoutMs} ms`,
      true
    );
  }
  throw new StepExecutionError(
    lastTried,
    `no locator worked within ${timeoutMs} ms: ${lastReasons.join('; ')}`,
    true
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function act(
  page: Page,
  frame: Frame,
  locator: Locator,
  step: StepLike,
  value: string | undefined,
  timeout: number
): Promise<void> {
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
      await typeInto(page, locator, value ?? '', timeout);
      return;
    case 'select': {
      const tag = await locator.evaluate((el: Element) => el.tagName, undefined, { timeout });
      if (tag === 'SELECT') {
        await locator.selectOption(value ?? '', { timeout });
        return;
      }
      // A custom combobox: open it, then choose the option of that name (it usually lives in a portal)
      await locator.click({ timeout });
      await frame.getByRole('option', { name: value ?? '', exact: true }).click({ timeout });
      return;
    }
    case 'keypress':
    case 'form_submit':
      await locator.press(value ?? 'Enter', { timeout });
      return;
    default:
      throw new Error(`Unknown action type: ${step.actionType}`);
  }
}

/** Type in an input, or in a contenteditable element through real keyboard input events. */
async function typeInto(page: Page, locator: Locator, text: string, timeout: number): Promise<void> {
  const kind = await locator.evaluate(
    (el: Element) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? 'field' : (el as HTMLElement).isContentEditable ? 'editable' : 'other'),
    undefined,
    { timeout }
  );
  if (kind !== 'editable') {
    await locator.fill(text, { timeout });
    return;
  }
  await locator.click({ timeout });
  await page.keyboard.press('ControlOrMeta+A');
  if (text === '') {
    await page.keyboard.press('Delete');
  } else {
    await page.keyboard.insertText(text);
  }
}

// ---------------------------------------------------------------------------
// Result zone
// ---------------------------------------------------------------------------

/**
 * Read the Result_Zone of a page. The element is waited for up to `timeoutMs` (the page may still be
 * rendering); a zone that never appears is `result_zone_not_found`. The in-page reader is installed
 * as an expression (Playwright does not call a function given as a string) and called with explicit arguments.
 */
export async function extractWebZone(page: Page, zone: ZoneLike, timeoutMs: number): Promise<ZoneOutcome> {
  const locator = page.locator(zone.selector ?? 'body').first();
  try {
    await locator.waitFor({ state: 'attached', timeout: Math.max(1, timeoutMs) });
  } catch {
    return zoneFailure('result_zone_not_found', notFoundMessage(zone), zone);
  }
  try {
    await page.evaluate(`window.__daemonizeZone = ${WEB_ZONE_FUNCTION}`);
    const raw = (await locator.evaluate(
      (el: Element, extractor: unknown) => (window as unknown as { __daemonizeZone(el: Element, ex: unknown): unknown }).__daemonizeZone(el, extractor),
      zone.extractor ?? { kind: 'text' },
      { timeout: Math.max(1, timeoutMs) }
    )) as RawWebZone;
    return finishWebZone(raw, zone);
  } catch (err) {
    return zoneFailure('result_extraction_failed', `The result zone could not be read: ${firstLine(err)}`, zone);
  } finally {
    await page.evaluate('delete window.__daemonizeZone').catch(() => { });
  }
}

// ---------------------------------------------------------------------------
// Failure screenshot
// ---------------------------------------------------------------------------

export interface FailureShot {
  screenshot?: string;
  thumbnail?: string;
  /** The PNG as base64, only inside a container, so the host can keep the file itself. */
  data?: string;
}

/** Save a PNG under the temp directory; a thumbnail is inlined only when it is smaller than 20 KB. */
export function saveFailureScreenshot(png: Buffer, stepIndex: number, inContainer = false): FailureShot {
  const dir = join(tmpdir(), 'daemonize-failures');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `fail-${Date.now()}-${randomBytes(3).toString('hex')}-${stepIndex}.png`);
  writeFileSync(path, png);
  const shot: FailureShot = { screenshot: path };
  if (png.length < MAX_THUMBNAIL_BYTES) shot.thumbnail = `data:image/png;base64,${png.toString('base64')}`;
  if (inContainer) shot.data = png.toString('base64');
  return shot;
}

/** Screenshot of the page the failing step ran on; empty when the page cannot be captured. */
export async function captureFailure(run: WebRun, stepIndex: number): Promise<FailureShot> {
  try {
    const png = await run.pages[run.current].screenshot({ timeout: 3000 });
    return saveFailureScreenshot(png, stepIndex, process.env.DAEMONIZE_IN_CONTAINER !== undefined);
  } catch {
    return {};
  }
}
