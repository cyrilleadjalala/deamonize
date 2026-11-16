import { describe, it, expect } from 'vitest';
import {
  MAX_PATTERN_LENGTH,
  PatternError,
  compileScreenPattern,
  compileStepWait,
  escapeRegex,
  hasNestedQuantifier,
  lineSpec,
  matchesScreen,
  patternTimeoutResult,
  waitForPattern,
} from '../../src/replay/runtime/pattern-wait.js';

/** A clock that only moves when something sleeps. */
function fakeClock() {
  let t = 1000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => (t += ms),
  };
}

describe('compileScreenPattern and matchesScreen', () => {
  it('matches a literal text anywhere on the screen, with regex characters taken literally', () => {
    const compiled = compileScreenPattern({ text: 'sqlite> (1.5)' });
    expect(matchesScreen('x\nsqlite> (1.5)\ny', compiled)).toBe(true);
    expect(matchesScreen('sqlite> (1x5)', compiled)).toBe(false);
  });

  it('ignores the blanks at the end of a literal text', () => {
    expect(matchesScreen('sqlite>', compileScreenPattern({ text: 'sqlite> ' }))).toBe(true);
  });

  it('matches a regular expression with flags, ^ and $ per line by default', () => {
    expect(matchesScreen('a\nDone 12\nb', compileScreenPattern({ regex: '^done \\d+$', flags: 'mi' }))).toBe(true);
    expect(matchesScreen('a\nDone 12\nb', compileScreenPattern({ regex: '^done \\d+$', flags: 'm' }))).toBe(false);
    expect(matchesScreen('x done', compileScreenPattern({ regex: '^done' }))).toBe(false);
  });

  it('only looks inside the region', () => {
    const region = { row: 1, col: 2, rows: 1, cols: 5 };
    const compiled = compileScreenPattern({ text: 'ready', region });
    expect(matchesScreen('ready\n--ready--\nready', compiled)).toBe(true);
    expect(matchesScreen('ready\nready\nready', compiled)).toBe(false);
    expect(matchesScreen('ready\n--rea\nready', compiled)).toBe(false);
  });

  it('waits for the text to go away in disappear mode', () => {
    const compiled = compileScreenPattern({ text: 'Loading', mode: 'disappear' });
    expect(matchesScreen('Loading...', compiled)).toBe(false);
    expect(matchesScreen('Done', compiled)).toBe(true);
  });

  it('matches a line exactly with lineSpec', () => {
    const { regex, flags } = lineSpec('sqlite> ');
    const compiled = compileScreenPattern({ regex, flags });
    expect(matchesScreen('sqlite> select 1\nsqlite>', compiled)).toBe(true);
    expect(matchesScreen('sqlite> select 1', compiled)).toBe(false);
    expect(escapeRegex('a.b')).toBe('a\\.b');
  });

  it('rejects an empty, ambiguous, oversized, malformed or unknown-flag pattern', () => {
    expect(() => compileScreenPattern({})).toThrow(PatternError);
    expect(() => compileScreenPattern({ text: 'a', regex: 'a' })).toThrow(/exactly one/);
    expect(() => compileScreenPattern({ text: '' })).toThrow(/empty/);
    expect(() => compileScreenPattern({ regex: 'a'.repeat(MAX_PATTERN_LENGTH + 1) })).toThrow(/at most 500/);
    expect(() => compileScreenPattern({ text: 'a'.repeat(MAX_PATTERN_LENGTH + 1) })).toThrow(/at most 500/);
    expect(() => compileScreenPattern({ regex: 'a', flags: 'g' })).toThrow(/Flag "g"/);
    expect(() => compileScreenPattern({ regex: '(' })).toThrow(/Invalid regular expression/);
    expect(() => compileScreenPattern({ regex: 'a', timeoutMs: 0 })).toThrow(/timeout/);
    expect(() => compileScreenPattern({ text: 'a', region: { row: 0, col: 0, rows: 0, cols: 1 } })).toThrow(/region/);
    expect(compileScreenPattern({ regex: 'a'.repeat(MAX_PATTERN_LENGTH) }).source).toHaveLength(MAX_PATTERN_LENGTH);
  });

  it('rejects a repeated group that contains a repetition (catastrophic backtracking)', () => {
    for (const regex of ['(a+)+$', '(.*)*x', '(\\w+\\s*)+$', '((a+)b)+', '(a|b+){2,}']) {
      expect(hasNestedQuantifier(regex), regex).toBe(true);
      expect(() => compileScreenPattern({ regex })).toThrow(/repeats a repeated group/);
    }
    for (const regex of ['(ab)+', '(a+)b', '\\(a+\\)+', '[(a+)]+', '^\\w+@\\w+[$#>] ?$', '(a{1,3})+']) {
      expect(hasNestedQuantifier(regex), regex).toBe(false);
    }
  });

  it('keeps one match per poll on a huge screen cheap', () => {
    const compiled = compileScreenPattern({ regex: 'needle$' });
    const started = Date.now();
    expect(matchesScreen('x'.repeat(5_000_000), compiled)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('abandons a slow accepted expression instead of hanging, and then neither mode is satisfied', () => {
    // Accepted by the static checks, yet exponential or polynomial on these screens
    const cases: Array<[string, string]> = [
      ['(a|aa)+$', `${'a'.repeat(99_999)}b`],
      ['.*.*.*x', 'a'.repeat(100_000)],
      ['.*a.*b.*c', 'a'.repeat(100_000)],
      ['a*a*a*a*b', 'a'.repeat(100_000)],
    ];
    for (const [regex, screen] of cases) {
      {
        for (const mode of ['appear', 'disappear'] as const) {
          const compiled = compileScreenPattern({ regex, mode });
          const started = Date.now();
          expect(matchesScreen(screen, compiled), `${regex} ${mode}`).toBe(false);
          expect(Date.now() - started, regex).toBeLessThan(500);
        }
      }
    }
  });

  it('compiles the wait stored on a step', () => {
    const compiled = compileStepWait({ pattern: '^ok$', flags: 'm', mode: 'appear', timeoutMs: 500 });
    expect(compiled).toMatchObject({ kind: 'regex', source: '^ok$', mode: 'appear', timeoutMs: 500 });
    expect(compileStepWait({ text: 'ok', timeoutMs: 500 })).toMatchObject({ kind: 'text', mode: 'appear' });
  });
});

describe('waitForPattern', () => {
  const pattern = compileScreenPattern({ text: 'ready' });

  it('returns at once when the screen already matches', async () => {
    const clock = fakeClock();
    const result = await waitForPattern(() => 'ready', pattern, { timeoutMs: 5000, now: clock.now, sleep: clock.sleep });
    expect(result).toEqual({ matched: true, elapsedMs: 0, polls: 1 });
    expect(clock.sleeps).toEqual([]);
  });

  it('returns at the first poll after the pattern appears, not at the timeout', async () => {
    const clock = fakeClock();
    const appearsAt = clock.now() + 130;
    const result = await waitForPattern(
      () => (clock.now() >= appearsAt ? 'booting\nready' : 'booting'),
      pattern,
      { timeoutMs: 10000, pollMs: 40, now: clock.now, sleep: clock.sleep }
    );
    expect(result.matched).toBe(true);
    // Polls at 0, 40, 80, 120, 160: the first one at or after 130 ms
    expect(result.elapsedMs).toBe(160);
    expect(result.polls).toBe(5);
  });

  it('polls every 25 to 50 ms whatever interval is asked for', async () => {
    for (const [asked, used] of [[1, 25], [40, 40], [500, 50]] as const) {
      const clock = fakeClock();
      await waitForPattern(() => 'nope', pattern, { timeoutMs: 200, pollMs: asked, now: clock.now, sleep: clock.sleep });
      expect(clock.sleeps[0]).toBe(used);
    }
  });

  it('fails at the timeout with an excerpt of the last screen', async () => {
    const clock = fakeClock();
    const screen = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const result = await waitForPattern(() => screen, pattern, { timeoutMs: 200, pollMs: 50, now: clock.now, sleep: clock.sleep });
    expect(result.matched).toBe(false);
    expect(result.elapsedMs).toBe(200);
    expect(result.screenExcerpt?.split('\n')).toHaveLength(30);
    expect(result.screenExcerpt).toContain('line 59');
    expect(result.screenExcerpt).not.toContain('line 0\n');
  });

  it('never sleeps past the deadline', async () => {
    const clock = fakeClock();
    await waitForPattern(() => 'nope', pattern, { timeoutMs: 70, pollMs: 50, now: clock.now, sleep: clock.sleep });
    expect(clock.sleeps).toEqual([50, 20]);
  });

  it('polls again at once after an output notification', async () => {
    const clock = fakeClock();
    let notify: (() => void) | undefined;
    let shown = 'booting';
    // A sleep that never ends by itself: only the notification wakes the wait
    const sleep = () => new Promise<void>(() => { });
    const waiting = waitForPattern(() => shown, pattern, {
      timeoutMs: 10000,
      now: clock.now,
      sleep,
      subscribe: (listener) => {
        notify = listener;
        return () => { notify = undefined; };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    shown = 'ready';
    notify?.();
    const result = await waiting;
    expect(result).toMatchObject({ matched: true, polls: 2 });
    expect(notify).toBeUndefined();
  });

  it('counts a match only when the screen is settled, when a check is given', async () => {
    const clock = fakeClock();
    let settled = false;
    const result = await waitForPattern(() => 'ready', pattern, {
      timeoutMs: 1000,
      pollMs: 25,
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        settled = clock.now() >= 1100;
      },
      isSettled: () => settled,
    });
    expect(result.matched).toBe(true);
    expect(result.elapsedMs).toBe(100);
  });

  it('waits for a pattern to disappear', async () => {
    const clock = fakeClock();
    const gone = compileScreenPattern({ text: 'Loading', mode: 'disappear' });
    const result = await waitForPattern(
      () => (clock.now() < 1100 ? 'Loading...' : 'Result'),
      gone,
      { timeoutMs: 5000, pollMs: 50, now: clock.now, sleep: clock.sleep }
    );
    expect(result).toMatchObject({ matched: true, elapsedMs: 100 });
  });

  it('ends early when the program is gone and the pattern is not there', async () => {
    const clock = fakeClock();
    const result = await waitForPattern(() => 'bye', pattern, { timeoutMs: 10000, now: clock.now, sleep: clock.sleep, isClosed: () => true });
    expect(result).toMatchObject({ matched: false, polls: 1 });
  });
});

describe('patternTimeoutResult', () => {
  it('is a strict, drifted failure naming the pattern and the screen, without secrets', () => {
    const wait = compileScreenPattern({ regex: '^slow> $', timeoutMs: 100 });
    const result = patternTimeoutResult({ stepIndex: 2, wait, elapsedMs: 100, screenExcerpt: 'token=abc123\nbusy', secrets: ['abc123'] }, 140);
    expect(result).toEqual({
      success: false,
      error: 'pattern_timeout',
      drifted: true,
      failure: { stepIndex: 2, pattern: '^slow> $', mode: 'appear', elapsedMs: 100, screenExcerpt: 'token=***\nbusy' },
      elapsedMs: 140,
    });
  });
});
