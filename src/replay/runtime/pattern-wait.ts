/**
 * Waiting for a pattern on the rendered screen of a terminal program (requirements 17.2 to 17.5).
 *
 * Dependency free: it only imports the Node built-in `node:vm`, so the file is copied verbatim into the
 * output directory and the Docker context like the other run-time modules (screen-hash.ts, settle.ts).
 *
 * A pattern is either a literal text or a regular expression (JavaScript syntax, flags `i m s u`),
 * optionally limited to a rectangle of the screen. It is tested against the RENDERED text (what a
 * person sees after cursor moves, clears and redraws), never against the raw byte stream.
 *
 * Regular expression safety. JavaScript has no way to interrupt a running match, so the budget is
 * enforced by construction:
 *   - the source is at most MAX_PATTERN_LENGTH (500) characters and the flags are `i m s u` only;
 *   - a group that contains an unbounded quantifier and is itself quantified without a bound
 *     (`(a+)+`, `(.*)*`, `(\w+\s*)+`) is rejected, as it is the source of catastrophic backtracking;
 *   - the screen text is cut to MAX_SCREEN_CHARS and the expression is run ONCE per poll (never in
 *     a loop over lines or over positions), so a poll costs one bounded match;
 *   - the static checks cannot catch every slow expression (`(a|aa)+$`, `.*a.*b.*c`), so the match runs in
 *     a `node:vm` script with a MATCH_BUDGET_MS timeout, which interrupts the regex engine; a match that
 *     runs out of budget satisfies neither mode.
 */
import { createContext, Script } from 'node:vm';

export const MAX_PATTERN_LENGTH = 500;
export const MAX_SCREEN_CHARS = 100_000;
export const MIN_POLL_MS = 25;
export const MAX_POLL_MS = 50;
export const DEFAULT_POLL_MS = 40;
export const MAX_EXCERPT_LINES = 30;
export const MAX_EXCERPT_CHARS = 2000;

const ALLOWED_FLAGS = 'imsu';

export interface ScreenRegion {
  /** 0-based row and column of the top left corner, then the size. */
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface ScreenPatternSpec {
  /** A literal text (exclusive with `regex`). Trailing blanks are ignored: the screen text has none. */
  text?: string;
  /** A regular expression source (exclusive with `text`). */
  regex?: string;
  /** Flags of the expression, among `i m s u`; default `m` (^ and $ match at every line). */
  flags?: string;
  /** Test only this rectangle of the screen. */
  region?: ScreenRegion;
  /** `appear` (default): wait until the pattern is on screen. `disappear`: until it is gone. */
  mode?: 'appear' | 'disappear';
  timeoutMs?: number;
}

export interface CompiledScreenPattern {
  kind: 'text' | 'regex';
  /** The literal text, or the source of the expression: what a diagnostic may name. */
  source: string;
  flags: string;
  region?: ScreenRegion;
  mode: 'appear' | 'disappear';
  timeoutMs?: number;
  /** The expression to run (a literal text is escaped into one). */
  regex: RegExp;
}

/** The pattern is refused: empty, too long, unknown flag, invalid or catastrophic. */
export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

/** Escape a text so it matches itself in a regular expression. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A pattern that matches a whole screen line equal to `line` (blanks at the end ignored). */
export function lineSpec(line: string): { regex: string; flags: string } {
  return { regex: `^${escapeRegex(line.trimEnd())}$`, flags: 'm' };
}

/**
 * True when the source has a group containing an unbounded quantifier (`+`, `*`, `{n,}`) that is itself
 * followed by an unbounded quantifier. Escapes and character classes are skipped.
 */
export function hasNestedQuantifier(source: string): boolean {
  const unboundedAt = (i: number): boolean => {
    const c = source[i];
    if (c === '+' || c === '*') return true;
    if (c === '{') {
      const m = /^\{\d+,\}/.exec(source.slice(i));
      return m !== null;
    }
    return false;
  };
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
    } else if (c === '(') {
      stack.push(false);
    } else if (c === ')') {
      const inner = stack.pop() ?? false;
      if (inner && unboundedAt(i + 1)) return true;
      // A quantified group that contains an unbounded quantifier makes the enclosing group unbounded too
      if (inner && stack.length > 0) stack[stack.length - 1] = true;
    } else if (unboundedAt(i) && stack.length > 0) {
      stack[stack.length - 1] = true;
    }
  }
  return false;
}

/** Validate and compile a pattern; throws PatternError with a message safe to show. */
export function compileScreenPattern(spec: ScreenPatternSpec): CompiledScreenPattern {
  const hasText = spec.text !== undefined;
  const hasRegex = spec.regex !== undefined;
  if (hasText === hasRegex) throw new PatternError('A screen pattern needs exactly one of "text" and "regex"');

  const mode = spec.mode ?? 'appear';
  if (mode !== 'appear' && mode !== 'disappear') throw new PatternError(`Unknown wait mode "${String(mode)}"`);
  const region = spec.region;
  if (region !== undefined) {
    const ok = [region.row, region.col, region.rows, region.cols].every((n) => Number.isInteger(n) && n >= 0)
      && region.rows >= 1 && region.cols >= 1;
    if (!ok) throw new PatternError('The region of a screen pattern needs integer row, col >= 0 and rows, cols >= 1');
  }
  if (spec.timeoutMs !== undefined && !(Number.isFinite(spec.timeoutMs) && spec.timeoutMs >= 1)) {
    throw new PatternError('The timeout of a screen pattern must be a positive number of milliseconds');
  }

  let source: string;
  let flags: string;
  let kind: 'text' | 'regex';
  if (hasText) {
    kind = 'text';
    source = (spec.text as string).trimEnd();
    flags = 'm';
    if (source === '') throw new PatternError('A screen pattern cannot be empty');
    if (source.length > MAX_PATTERN_LENGTH) throw new PatternError(`A screen pattern is at most ${MAX_PATTERN_LENGTH} characters`);
  } else {
    kind = 'regex';
    source = spec.regex as string;
    flags = spec.flags ?? 'm';
    if (source === '') throw new PatternError('A screen pattern cannot be empty');
    if (source.length > MAX_PATTERN_LENGTH) throw new PatternError(`A screen pattern is at most ${MAX_PATTERN_LENGTH} characters`);
    for (const flag of flags) {
      if (!ALLOWED_FLAGS.includes(flag)) throw new PatternError(`Flag "${flag}" is not allowed in a screen pattern (use ${ALLOWED_FLAGS.split('').join(', ')})`);
    }
    if (new Set(flags).size !== flags.length) throw new PatternError('A flag is repeated in a screen pattern');
    if (hasNestedQuantifier(source)) throw new PatternError('The regular expression repeats a repeated group, which can take forever to match');
  }

  let regex: RegExp;
  try {
    regex = new RegExp(kind === 'text' ? escapeRegex(source) : source, flags);
  } catch (err) {
    throw new PatternError(`Invalid regular expression: ${(err as Error).message}`);
  }
  const compiled: CompiledScreenPattern = { kind, source, flags, mode, regex };
  if (region !== undefined) compiled.region = { ...region };
  if (spec.timeoutMs !== undefined) compiled.timeoutMs = spec.timeoutMs;
  return compiled;
}

/** The part of the screen a pattern looks at: the whole text, or its region, cut to MAX_SCREEN_CHARS. */
function visibleText(screenText: string, region: ScreenRegion | undefined): string {
  let text = screenText;
  if (region !== undefined) {
    text = text
      .split('\n')
      .slice(region.row, region.row + region.rows)
      .map((line) => line.slice(region.col, region.col + region.cols))
      .join('\n');
  }
  return text.length > MAX_SCREEN_CHARS ? text.slice(0, MAX_SCREEN_CHARS) : text;
}

/** Longest time one match may run. A regular expression that backtracks for longer is abandoned. */
export const MATCH_BUDGET_MS = 50;

const matchSandbox: { re?: RegExp; text?: string } = {};
const matchContext = createContext(matchSandbox);
const matchScript = new Script('re.test(text)');

const backtrackCache = new Map<string, boolean>();

/** Does the source contain an unescaped `+ * ? { |` outside a character class? Without one, a match is linear. */
function canBacktrack(source: string): boolean {
  const cached = backtrackCache.get(source);
  if (cached !== undefined) return cached;
  let found = false;
  let inClass = false;
  for (let i = 0; i < source.length && !found; i++) {
    const c = source[i] as string;
    if (c === '\\') i += 1;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else found = '+*?{|'.includes(c);
  }
  if (backtrackCache.size > 200) backtrackCache.clear();
  backtrackCache.set(source, found);
  return found;
}

/**
 * One match, interrupted after MATCH_BUDGET_MS (the static checks cannot rule out every quadratic or
 * exponential expression, for instance `(a|aa)+$` or `.*a.*b.*c`). Returns undefined when the budget ran out.
 */
function runMatch(compiled: CompiledScreenPattern, text: string): boolean | undefined {
  // An escaped literal, or an expression without repetition, optional part or alternative, cannot backtrack: no budget needed
  if (compiled.kind === 'text' || !canBacktrack(compiled.regex.source)) return compiled.regex.test(text);
  matchSandbox.re = compiled.regex;
  matchSandbox.text = text;
  try {
    // The timeout is wall-clock time: a second try keeps a stall of a loaded machine from reading as a slow expression
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return matchScript.runInContext(matchContext, { timeout: MATCH_BUDGET_MS }) as boolean;
      } catch (err) {
        if ((err as { code?: string }).code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err;
      }
    }
    return undefined;
  } finally {
    matchSandbox.text = undefined;
  }
}

/** Is the pattern on the screen now? One match, no loop. A match that runs out of budget counts as absent. */
export function patternPresent(screenText: string, compiled: CompiledScreenPattern): boolean {
  return runMatch(compiled, visibleText(screenText, compiled.region)) === true;
}

/**
 * Is the condition of the wait satisfied: the pattern is there (`appear`) or is gone (`disappear`)?
 * A match that runs out of budget satisfies neither mode, so the wait goes on and ends in `pattern_timeout`.
 */
export function matchesScreen(screenText: string, compiled: CompiledScreenPattern): boolean {
  const present = runMatch(compiled, visibleText(screenText, compiled.region));
  return present !== undefined && present === (compiled.mode === 'appear');
}

/** The last lines of a screen, bounded, for a diagnostic. The caller redacts secrets. */
export function screenExcerpt(screenText: string): string {
  const lines = screenText.split('\n');
  const text = lines.slice(-MAX_EXCERPT_LINES).join('\n');
  return text.length > MAX_EXCERPT_CHARS ? text.slice(text.length - MAX_EXCERPT_CHARS) : text;
}

/** The wait of a step as stored in a workflow file (`ScreenWait`): `pattern` is a regular expression source. */
export interface StepWaitLike {
  pattern?: string;
  text?: string;
  flags?: string;
  region?: ScreenRegion;
  mode?: 'appear' | 'disappear';
  timeoutMs: number;
  when?: 'before' | 'after';
}

/** Compile the wait recorded on a step. */
export function compileStepWait(wait: StepWaitLike): CompiledScreenPattern {
  return compileScreenPattern({
    ...(wait.text === undefined ? {} : { text: wait.text }),
    ...(wait.pattern === undefined ? {} : { regex: wait.pattern }),
    ...(wait.flags === undefined ? {} : { flags: wait.flags }),
    ...(wait.region === undefined ? {} : { region: wait.region }),
    ...(wait.mode === undefined ? {} : { mode: wait.mode }),
    timeoutMs: wait.timeoutMs,
  });
}

/** Thrown by a driver when the pattern of a step did not show up in time; the replay is strict and stops. */
export class PatternTimeoutError extends Error {
  constructor(
    readonly wait: CompiledScreenPattern,
    readonly elapsedMs: number,
    readonly screenExcerpt: string
  ) {
    super('pattern_timeout');
    this.name = 'PatternTimeoutError';
  }
}

/** What a failed pattern wait looks like in a result; the same on the host and in a container. */
export interface PatternTimeoutFailure {
  stepIndex: number;
  /** The pattern (never a secret value). */
  pattern: string;
  mode: 'appear' | 'disappear';
  elapsedMs: number;
  screenExcerpt: string;
}

/** The result of a pattern that did not show up in time: strict, so no later step ran. Secrets are removed from the excerpt. */
export function patternTimeoutResult(
  input: { stepIndex: number; wait: CompiledScreenPattern; elapsedMs: number; screenExcerpt?: string; secrets?: readonly string[] },
  totalElapsedMs: number
): { success: false; error: 'pattern_timeout'; drifted: true; failure: PatternTimeoutFailure; elapsedMs: number } {
  let excerpt = input.screenExcerpt ?? '';
  for (const secret of input.secrets ?? []) {
    if (secret !== '') excerpt = excerpt.split(secret).join('***');
  }
  return {
    success: false,
    error: 'pattern_timeout',
    drifted: true,
    failure: {
      stepIndex: input.stepIndex,
      pattern: input.wait.source,
      mode: input.wait.mode,
      elapsedMs: input.elapsedMs,
      screenExcerpt: excerpt,
    },
    elapsedMs: totalElapsedMs,
  };
}

export interface WaitOptions {
  /** Give up after this many milliseconds. */
  timeoutMs: number;
  /** Poll interval, clamped to 25..50 ms (default 40). */
  pollMs?: number;
  /** When given, a match only counts while this returns true (e.g. every output chunk is rendered). */
  isSettled?: () => boolean;
  /** Called with a listener; the listener is invoked after each output of the program, to poll at once. Returns the unsubscribe function. */
  subscribe?: (listener: () => void) => () => void;
  /** When this returns true no more output can come (the program ended): the wait ends after reading the screen once more. */
  isClosed?: () => boolean;
  /** Injectable clock (ms) and sleep, for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitResult {
  matched: boolean;
  elapsedMs: number;
  polls: number;
  /** The last lines of the last screen read; only when the wait timed out. */
  screenExcerpt?: string;
}

/**
 * Poll the rendered screen until the pattern condition holds. It evaluates at once, then after every
 * output notification and every `pollMs`, and returns as soon as the condition is satisfied. On timeout it
 * returns `matched: false` with an excerpt of the last screen (the caller removes secrets before showing it).
 */
export async function waitForPattern(
  readScreen: () => string | Promise<string>,
  compiled: CompiledScreenPattern,
  options: WaitOptions
): Promise<WaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, options.pollMs ?? DEFAULT_POLL_MS));
  const startedAt = now();
  const deadline = startedAt + Math.max(0, options.timeoutMs);

  let wake: (() => void) | undefined;
  const notified = (): void => {
    wake?.();
  };
  const unsubscribe = options.subscribe?.(notified);

  let polls = 0;
  let last = '';
  try {
    for (; ;) {
      last = await readScreen();
      polls += 1;
      if (matchesScreen(last, compiled) && (options.isSettled?.() ?? true)) {
        return { matched: true, elapsedMs: now() - startedAt, polls };
      }
      const remaining = deadline - now();
      if (remaining <= 0 || options.isClosed?.() === true) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        void sleep(Math.min(pollMs, remaining)).then(resolve);
      });
      wake = undefined;
    }
  } finally {
    unsubscribe?.();
  }
  return { matched: false, elapsedMs: now() - startedAt, polls, screenExcerpt: screenExcerpt(last) };
}
