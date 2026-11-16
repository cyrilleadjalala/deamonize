/**
 * Effect-based waits and timeout resolution of a web replay.
 *
 * Dependency free on purpose: the compiler copies this file verbatim next to the
 * generated server (like screen-hash.ts), so the file that ships is the file
 * that is tested. The page is described by a minimal structural interface, so
 * nothing here imports Playwright.
 *
 * An action is "settled" as soon as ONE of these holds:
 *   - a navigation of the main frame committed;
 *   - the DOM was quiet for `quietMs` (or only changes at a fixed rhythm, like a ticker)
 *     and no request started by the action is still pending;
 *   - the request(s) started by the action completed.
 * WebSockets, event streams, long polls that stay pending and requests that repeat
 * on a fixed interval are never waited for. The wait is bounded by the step timeout;
 * reaching the bound is not an error: the next locator's own timeout decides.
 */

export const DEFAULT_QUIET_MS = 150;
export const DEFAULT_STEP_TIMEOUT_MS = 8000;
export const DEFAULT_WORKFLOW_TIMEOUT_MS = 30000;
export const MAX_TIMEOUT_MS = 600000;
/** A request still pending after this long is a long poll or a stream: it is not waited for. */
export const LONG_LIVED_MS = 2000;
/** Time left to the page to render a response once the last counted request completed. */
export const RESPONSE_GRACE_MS = 50;
const POLL_MS = 20;

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

/** A positive integer not above `max`, from a number or a numeric string; undefined otherwise. */
export function parseTimeoutMs(value: unknown, max: number = MAX_TIMEOUT_MS): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) return undefined;
  return n;
}

export interface TimeoutSources {
  /** `_timeoutMs` argument of the tool call */
  call?: unknown;
  /** DAEMONIZE_TIMEOUT_MS */
  env?: unknown;
  /** Workflow.timeoutMs */
  workflow?: unknown;
  /** WorkflowSet.timeoutMs */
  set?: unknown;
}

/** Timeout of the whole replay: the call, then the environment, then the workflow, then the set, then 30 s. */
export function resolveTimeoutMs(sources: TimeoutSources = {}, defaultMs: number = DEFAULT_WORKFLOW_TIMEOUT_MS): number {
  for (const candidate of [sources.call, sources.env, sources.workflow, sources.set]) {
    const parsed = parseTimeoutMs(candidate);
    if (parsed !== undefined) return parsed;
  }
  return defaultMs;
}

/** Timeout of one step: the step's own, then DAEMONIZE_STEP_TIMEOUT_MS, then 8 s. */
export function resolveStepTimeoutMs(
  sources: { step?: unknown; env?: unknown } = {},
  defaultMs: number = DEFAULT_STEP_TIMEOUT_MS
): number {
  return parseTimeoutMs(sources.step) ?? parseTimeoutMs(sources.env) ?? defaultMs;
}

/** A step never waits longer than what is left of the whole replay (but always at least `floorMs`). */
export function boundStepTimeoutMs(stepMs: number, remainingMs: number, floorMs = 100): number {
  return Math.max(floorMs, Math.min(stepMs, remainingMs));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Requests that never "complete" as a response: sockets, event streams, inline data. */
export function isIgnorableRequest(
  url: string,
  resourceType: string,
  headers: Record<string, string> = {}
): boolean {
  if (resourceType === 'websocket' || resourceType === 'eventsource') return true;
  if (/^(wss?|data|blob):/i.test(url)) return true;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'accept' && /text\/event-stream/i.test(value)) return true;
  }
  return false;
}

/**
 * True when the last `minSamples` timestamps are evenly spaced (each interval within
 * `tolerance` of the mean): a poll loop or a ticker rather than a reaction to the action.
 */
export function isPeriodic(times: number[], minSamples = 4, tolerance = 0.35): boolean {
  if (times.length < minSamples) return false;
  const recent = times.slice(-minSamples);
  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i++) intervals.push(recent[i] - recent[i - 1]);
  const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
  if (mean <= 0) return false;
  return intervals.every((v) => Math.abs(v - mean) <= mean * tolerance);
}

/** What the page reports about its mutations: the count, the page clock and the last mutation times. */
export interface DomSample {
  count: number;
  pageNow: number;
  times: number[];
}

/** Tracks DOM mutations observed by polling the page; time is injected, so it needs no browser. */
export class QuietTracker {
  private lastChangeAt: number;
  private count: number | undefined;
  private ambient = false;

  constructor(
    private readonly quietMs: number,
    startedAt: number
  ) {
    this.lastChangeAt = startedAt;
  }

  observe(sample: DomSample, now: number): void {
    const last = sample.times.length > 0 ? sample.times[sample.times.length - 1] : undefined;
    if (this.count !== undefined && sample.count !== this.count) {
      // A smaller count means the page was reloaded: everything is new
      const age = sample.count > this.count && last !== undefined ? Math.max(0, sample.pageNow - last) : 0;
      this.lastChangeAt = Math.max(this.lastChangeAt, now - age);
    }
    this.count = sample.count;

    if (last !== undefined && isPeriodic(sample.times)) {
      const recent = sample.times.slice(-4);
      const mean = (recent[recent.length - 1] - recent[0]) / (recent.length - 1);
      this.ambient = sample.pageNow - last <= 2 * mean + this.quietMs;
    } else {
      this.ambient = false;
    }
  }

  isQuiet(now: number): boolean {
    return this.ambient || now - this.lastChangeAt >= this.quietMs;
  }
}

interface RequestEntry {
  key: string;
  startedAt: number;
  finishedAt?: number;
  ignorable: boolean;
}

/** Tracks the requests started during a wait; time is injected, so it needs no browser. */
export class RequestTracker {
  private readonly entries = new Map<unknown, RequestEntry>();
  private readonly starts = new Map<string, number[]>();
  private lastFinishAt = 0;

  start(id: unknown, url: string, resourceType: string, headers: Record<string, string>, now: number): void {
    const key = url.split(/[?#]/)[0];
    this.entries.set(id, { key, startedAt: now, ignorable: isIgnorableRequest(url, resourceType, headers) });
    const list = this.starts.get(key) ?? [];
    list.push(now);
    this.starts.set(key, list);
  }

  finish(id: unknown, now: number): void {
    const entry = this.entries.get(id);
    if (entry !== undefined && entry.finishedAt === undefined) {
      entry.finishedAt = now;
      this.lastFinishAt = now;
    }
  }

  private counts(entry: RequestEntry, now: number): boolean {
    if (entry.ignorable) return false;
    if (isPeriodic(this.starts.get(entry.key) ?? [], 3)) return false;
    return entry.finishedAt !== undefined || now - entry.startedAt < LONG_LIVED_MS;
  }

  /** Counted requests still waiting for their response. */
  pending(now: number): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.finishedAt === undefined && this.counts(entry, now)) n++;
    }
    return n;
  }

  /** True once at least one counted request started and all counted requests completed `graceMs` ago. */
  responded(now: number, graceMs: number = RESPONSE_GRACE_MS): boolean {
    let counted = 0;
    for (const entry of this.entries.values()) {
      if (this.counts(entry, now)) counted++;
    }
    return counted > 0 && this.pending(now) === 0 && now - this.lastFinishAt >= graceMs;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export interface SettleRequest {
  url(): string;
  resourceType(): string;
  headers(): Record<string, string>;
}

/** The part of a Playwright page that waitForEffect uses (cast a Playwright Page to it). */
export interface SettlePage {
  on(event: string, handler: (arg: any) => void): unknown;
  off(event: string, handler: (arg: any) => void): unknown;
  evaluate(expression: string): Promise<unknown>;
  mainFrame?(): unknown;
  waitForLoadState?(state: string, options?: { timeout?: number }): Promise<unknown>;
}

export type SettleReason = 'navigation' | 'quiet' | 'response' | 'bound';

export interface EffectOptions {
  /** Bound of the wait (the step timeout). Reaching it is not an error. */
  timeoutMs?: number;
  quietMs?: number;
  /** Runs once the watching started, so effects that happen during the action itself are seen. */
  action?: () => Promise<unknown>;
}

// Installed once per document; survives across steps and reports the last mutation times.
const OBSERVE_EXPRESSION = `(() => {
  const g = globalThis;
  if (!g.__daemonizeFx && typeof MutationObserver !== "undefined" && document) {
    const state = { count: 0, times: [] };
    g.__daemonizeFx = state;
    new MutationObserver(() => {
      state.count++;
      state.times.push(performance.now());
      if (state.times.length > 8) state.times.shift();
    }).observe(document, { childList: true, attributes: true, characterData: true, subtree: true });
  }
  const s = g.__daemonizeFx || { count: 0, times: [] };
  return { count: s.count, pageNow: performance.now(), times: s.times.slice() };
})()`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Wait for the observable effect of an action. Never throws because of the wait itself;
 * an error of `opts.action` is passed on. Resolves with why the wait ended.
 */
export async function waitForEffect(page: SettlePage, opts: EffectOptions = {}): Promise<SettleReason> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const requests = new RequestTracker();
  const quiet = new QuietTracker(quietMs, Date.now());
  let navigated = false;

  const onRequest = (req: SettleRequest) => {
    try {
      requests.start(req, req.url(), req.resourceType(), req.headers(), Date.now());
    } catch {
      // A request that cannot be described is not waited for
    }
  };
  const onDone = (req: SettleRequest) => requests.finish(req, Date.now());
  const onNavigated = (frame: unknown) => {
    if (page.mainFrame === undefined || frame === page.mainFrame()) navigated = true;
  };

  const sample = async (): Promise<void> => {
    try {
      quiet.observe((await page.evaluate(OBSERVE_EXPRESSION)) as DomSample, Date.now());
    } catch {
      // The document is being replaced (a navigation) or is gone: nothing to read
    }
  };

  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  page.on('framenavigated', onNavigated);
  try {
    await sample();
    if (opts.action !== undefined) await opts.action();

    const boundAt = Date.now() + timeoutMs;
    for (; ;) {
      const now = Date.now();
      if (navigated) {
        try {
          await page.waitForLoadState?.('domcontentloaded', { timeout: Math.max(1, boundAt - now) });
        } catch {
          // Bounded: the next locator decides
        }
        return 'navigation';
      }
      await sample();
      const t = Date.now();
      if (requests.responded(t)) return 'response';
      if (quiet.isQuiet(t) && requests.pending(t) === 0) return 'quiet';
      if (t >= boundAt) return 'bound';
      await sleep(Math.min(POLL_MS, boundAt - t));
    }
  } finally {
    page.off('request', onRequest);
    page.off('requestfinished', onDone);
    page.off('requestfailed', onDone);
    page.off('framenavigated', onNavigated);
  }
}
