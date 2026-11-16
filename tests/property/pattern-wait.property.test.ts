import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  MAX_PATTERN_LENGTH,
  MAX_POLL_MS,
  MAX_EXCERPT_LINES,
  MIN_POLL_MS,
  PatternError,
  compileScreenPattern,
  escapeRegex,
  matchesScreen,
  waitForPattern,
  type CompiledScreenPattern,
  type ScreenPatternSpec,
  type ScreenRegion,
  type WaitResult,
} from '../../src/replay/runtime/pattern-wait.js';

// Feature: daemonize, Property 16: a pattern wait returns as soon as the pattern appears
// **Validates: Requirements 17.2, 17.3, 17.4, 17.5**

const RUNS = { numRuns: 200 };
// Real-time bound of one match on a 100,000 character screen. The matcher caps one regex run at about
// 50 ms (twice with the retry), so a catastrophic expression is stopped long before this. The bound is
// generous on purpose: a linear expression took 435 ms once when the whole suite ran in parallel, and
// the property only has to tell a bounded match from an unbounded one.
const SLOW_MATCH_MS = 1500;

// ---------------------------------------------------------------------------------------------
// Fake terminal on a virtual clock
// ---------------------------------------------------------------------------------------------

interface Snapshot {
  at: number;
  screen: string;
}

const clampPoll = (pollMs: number): number => Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, pollMs));

interface Simulation {
  result: WaitResult;
  /** Virtual time at which waitForPattern returned. */
  endTime: number;
  /** The screen the fake terminal showed at the end. */
  lastScreen: string;
}

/**
 * Run waitForPattern against a scripted timeline. The clock only moves to the next sleep deadline or the
 * next output event, so a run is exact and instant. With `notify`, every snapshot after time 0 is also an
 * output event that calls the listener given to `subscribe`.
 */
async function simulate(
  snapshots: Snapshot[],
  wait: CompiledScreenPattern,
  options: { timeoutMs: number; pollMs: number; notify: boolean }
): Promise<Simulation> {
  const sorted = [...snapshots].sort((a, b) => a.at - b.at);
  let t = 0;
  const timers: Array<{ at: number; resolve: () => void }> = [];
  const events = options.notify ? sorted.map((s) => s.at).filter((at) => at > 0) : [];
  const listeners = new Set<() => void>();
  let lastScreen = '';
  const readScreen = (): string => {
    let screen = '';
    for (const snapshot of sorted) if (snapshot.at <= t) screen = snapshot.screen;
    lastScreen = screen;
    return screen;
  };

  let result: WaitResult | undefined;
  let endTime = -1;
  const waiting = waitForPattern(readScreen, wait, {
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
    now: () => t,
    sleep: (ms) => new Promise<void>((resolve) => { timers.push({ at: t + ms, resolve }); }),
    ...(options.notify
      ? { subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } }
      : {}),
  }).then((r) => {
    result = r;
    endTime = t;
  });

  for (let guard = 0; result === undefined; guard++) {
    if (guard > 200_000) throw new Error('the simulation does not end');
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (result !== undefined) break;
    timers.sort((a, b) => a.at - b.at);
    const timer = timers[0];
    const event = events[0];
    if (timer === undefined && event === undefined) throw new Error('deadlock: nothing is scheduled');
    if (event !== undefined && (timer === undefined || event <= timer.at)) {
      events.shift();
      t = Math.max(t, event);
      for (const listener of [...listeners]) listener();
    } else if (timer !== undefined) {
      timers.shift();
      t = Math.max(t, timer.at);
      timer.resolve();
    }
  }
  await waiting;
  return { result: result as WaitResult, endTime, lastScreen };
}

/** What the silence heuristic does: return once the program has been silent for `silenceMs`. */
function silenceReturnTime(outputTimes: number[], silenceMs: number): number {
  const times = [...outputTimes].sort((a, b) => a - b);
  for (let i = 0; i < times.length; i++) {
    const next = times[i + 1];
    if (next === undefined || next - (times[i] as number) >= silenceMs) return (times[i] as number) + silenceMs;
  }
  return silenceMs;
}

// ---------------------------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------------------------

/** A text with regular expression characters, to be sure they are taken literally. */
const TOKEN = 'ok(1.5)+[x]';
const NEAR_MISSES = [
  'ok(1x5)+[x]',
  'OK(1.5)+[x]',
  'ok(1.5)+[x',
  'k(1.5)+[x]',
  'ok(1.5)[x]',
  'ok(1.5)++[x]',
  'ok 1.5 + x',
  'ok(1.5)+',
  '[x]',
  'ok\\(1\\.5\\)\\+\\[x\\]',
];
const FILLER_CHARS = [...'abc XYZ019.*+?^${}()|[]\\'];

const fillerLine = fc.array(fc.constantFrom(...FILLER_CHARS), { maxLength: 25 }).map((chars) => chars.join('').trimEnd());
const nearMissLine = fc.oneof(fc.constantFrom(...NEAR_MISSES), fillerLine);

/** A screen of up to `maxLines` lines that never contains TOKEN. */
const staleScreen = (maxLines = 6): fc.Arbitrary<string> =>
  fc.array(nearMissLine, { minLength: 1, maxLength: maxLines }).map((lines) => lines.join('\n'));

/** A screen that contains TOKEN on one of its lines. */
const matchingScreen: fc.Arbitrary<string> = fc
  .tuple(fc.array(nearMissLine, { maxLength: 5 }), fillerLine, fillerLine, fc.array(nearMissLine, { maxLength: 5 }))
  .map(([before, left, right, after]) => [...before, `${left}${TOKEN}${right}`.trimEnd(), ...after].join('\n'));

const patternSpec: fc.Arbitrary<ScreenPatternSpec> = fc.constantFrom<ScreenPatternSpec>({ text: TOKEN }, { regex: escapeRegex(TOKEN) });

const pollMsArb = fc.integer({ min: 1, max: 100 });
const timeoutArb = fc.integer({ min: 50, max: 3000 });

/** A moment inside the wait together with the timeout: 0 <= T <= timeout. */
const momentArb = fc
  .tuple(timeoutArb, fc.double({ min: 0, max: 1, noNaN: true }))
  .map(([timeoutMs, fraction]) => ({ timeoutMs, appearsAt: Math.floor(fraction * timeoutMs) }));

/**
 * Snapshots that show only stale text up to `appearsAt` (exclusive) and `final` from `appearsAt` on.
 * `staleTimes` are the moments of the stale outputs; the first snapshot is at time 0.
 */
function timeline(stale: string[], staleTimes: number[], appearsAt: number, final: string): Snapshot[] {
  const times = [0, ...staleTimes.filter((at) => at > 0 && at < appearsAt)];
  const snapshots: Snapshot[] = times.map((at, i) => ({ at, screen: stale[i % stale.length] as string }));
  if (appearsAt === 0) return [{ at: 0, screen: final }];
  snapshots.push({ at: appearsAt, screen: final });
  return snapshots;
}

const staleArb = fc.array(staleScreen(), { minLength: 1, maxLength: 5 });
const staleTimesArb = fc.array(fc.integer({ min: 1, max: 3000 }), { maxLength: 8 });

// ---------------------------------------------------------------------------------------------
// 1. Latency bound
// ---------------------------------------------------------------------------------------------

describe('Property 16: a pattern wait returns as soon as the pattern appears', () => {
  it('returns at the first poll at or after the moment the pattern appears (never before, at most one poll later)', async () => {
    await fc.assert(
      fc.asyncProperty(patternSpec, momentArb, pollMsArb, staleArb, staleTimesArb, matchingScreen, async (spec, moment, pollMs, stale, staleTimes, final) => {
        const wait = compileScreenPattern(spec);
        const p = clampPoll(pollMs);
        const snapshots = timeline(stale, staleTimes, moment.appearsAt, final);
        const { result, endTime } = await simulate(snapshots, wait, { timeoutMs: moment.timeoutMs, pollMs, notify: false });
        expect(result.matched).toBe(true);
        expect(endTime).toBeGreaterThanOrEqual(moment.appearsAt);
        expect(endTime).toBeLessThanOrEqual(moment.appearsAt + p);
        // The polls are at 0, p, 2p, ...: the first one at or after the moment the pattern is shown
        expect(endTime).toBe(Math.min(Math.ceil(moment.appearsAt / p) * p, moment.timeoutMs));
        expect(result.elapsedMs).toBe(endTime);
      }),
      RUNS
    );
  });

  it('returns at exactly the moment of the output that shows the pattern when output events are notified', async () => {
    await fc.assert(
      fc.asyncProperty(patternSpec, momentArb, pollMsArb, staleArb, staleTimesArb, matchingScreen, async (spec, moment, pollMs, stale, staleTimes, final) => {
        const wait = compileScreenPattern(spec);
        const snapshots = timeline(stale, staleTimes, moment.appearsAt, final);
        const { result, endTime } = await simulate(snapshots, wait, { timeoutMs: moment.timeoutMs, pollMs, notify: true });
        expect(result.matched).toBe(true);
        expect(endTime).toBe(moment.appearsAt);
        expect(result.elapsedMs).toBe(moment.appearsAt);
      }),
      RUNS
    );
  });

  // -------------------------------------------------------------------------------------------
  // 2. Never later than the silence rule
  // -------------------------------------------------------------------------------------------

  it('never returns later than one poll after the silence rule would (silence of silenceMs after the last output)', async () => {
    await fc.assert(
      fc.asyncProperty(
        patternSpec,
        fc.integer({ min: 2, max: 400 }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 8 }),
        fc.integer({ min: 0, max: 500 }),
        pollMsArb,
        fc.boolean(),
        staleArb,
        matchingScreen,
        async (spec, silenceMs, gapFractions, extraMs, pollMs, notify, stale, final) => {
          const wait = compileScreenPattern(spec);
          const p = clampPoll(pollMs);
          // Outputs at 0 and then gaps shorter than silenceMs; the last output shows the pattern
          const gaps = gapFractions.map((f) => 1 + Math.floor(f * (silenceMs - 2)));
          const outputTimes = [0];
          for (const gap of gaps) outputTimes.push((outputTimes[outputTimes.length - 1] as number) + gap);
          const appearsAt = outputTimes[outputTimes.length - 1] as number;
          const snapshots: Snapshot[] = outputTimes.slice(0, -1).map((at, i) => ({ at, screen: stale[i % stale.length] as string }));
          snapshots.push({ at: appearsAt, screen: final });
          const silenceAt = silenceReturnTime(outputTimes, silenceMs);
          expect(silenceAt).toBe(appearsAt + silenceMs);

          const { result, endTime } = await simulate(snapshots, wait, { timeoutMs: appearsAt + extraMs, pollMs, notify });
          expect(result.matched).toBe(true);
          expect(endTime).toBeLessThanOrEqual(silenceAt + p);
          expect(endTime).toBeLessThanOrEqual(appearsAt + p);
        }
      ),
      RUNS
    );
  });

  // -------------------------------------------------------------------------------------------
  // 3. Timeout
  // -------------------------------------------------------------------------------------------

  it('fails at the timeout, with the last 30 lines of the screen, when the pattern never shows up', async () => {
    await fc.assert(
      fc.asyncProperty(
        patternSpec,
        timeoutArb,
        pollMsArb,
        fc.boolean(),
        fc.array(staleScreen(80), { minLength: 1, maxLength: 4 }),
        staleTimesArb,
        async (spec, timeoutMs, pollMs, notify, stale, staleTimes) => {
          const wait = compileScreenPattern(spec);
          const p = clampPoll(pollMs);
          const times = [0, ...staleTimes.filter((at) => at < timeoutMs)];
          const snapshots = times.map((at, i) => ({ at, screen: stale[i % stale.length] as string }));
          const { result, endTime, lastScreen } = await simulate(snapshots, wait, { timeoutMs, pollMs, notify });
          expect(result.matched).toBe(false);
          expect(endTime).toBe(timeoutMs);
          expect(result.elapsedMs).toBe(timeoutMs);
          expect(result.elapsedMs).toBeLessThanOrEqual(timeoutMs + p);
          // Bounded polling: no busy loop, one poll more per notified output at most
          const eventCount = notify ? times.filter((at) => at > 0).length : 0;
          expect(result.polls).toBeLessThanOrEqual(Math.floor(timeoutMs / p) + 2 + eventCount);
          const excerpt = result.screenExcerpt as string;
          expect(excerpt.split('\n').length).toBeLessThanOrEqual(MAX_EXCERPT_LINES);
          expect(excerpt).toBe(lastScreen.split('\n').slice(-MAX_EXCERPT_LINES).join('\n'));
        }
      ),
      RUNS
    );
  });

  // -------------------------------------------------------------------------------------------
  // 4. Disappear, region, and a pattern that comes and goes between two polls
  // -------------------------------------------------------------------------------------------

  it('disappear mode: returns at the first poll at or after the pattern is gone, never before', async () => {
    await fc.assert(
      fc.asyncProperty(
        patternSpec,
        momentArb,
        pollMsArb,
        fc.boolean(),
        fc.array(matchingScreen, { minLength: 1, maxLength: 4 }),
        staleTimesArb,
        staleScreen(),
        async (spec, moment, pollMs, notify, shown, shownTimes, gone) => {
          const wait = compileScreenPattern({ ...spec, mode: 'disappear' });
          const p = clampPoll(pollMs);
          // The pattern is on screen until `appearsAt` (here: the moment it goes away)
          const snapshots = timeline(shown, shownTimes, moment.appearsAt, gone);
          const { result, endTime } = await simulate(snapshots, wait, { timeoutMs: moment.timeoutMs, pollMs, notify });
          expect(result.matched).toBe(true);
          expect(endTime).toBeGreaterThanOrEqual(moment.appearsAt);
          expect(endTime).toBe(notify ? moment.appearsAt : Math.min(Math.ceil(moment.appearsAt / p) * p, moment.timeoutMs));
        }
      ),
      RUNS
    );
  });

  describe('region', () => {
    const WIDTH = 40;
    const HEIGHT = 12;
    const L = TOKEN.length;

    interface Placed { row: number; col: number }
    const render = (placed: Placed[]): string => {
      const rows = Array.from({ length: HEIGHT }, () => '_'.repeat(WIDTH).split(''));
      for (const { row, col } of placed) TOKEN.split('').forEach((ch, i) => { (rows[row] as string[])[col + i] = ch; });
      return rows.map((r) => r.join('')).join('\n');
    };

    const regionArb: fc.Arbitrary<{ region: ScreenRegion; inside: Placed; decoys: Placed[] }> = fc
      .record({
        row: fc.integer({ min: 0, max: HEIGHT - 2 }),
        col: fc.integer({ min: 0, max: 20 }),
        extraCols: fc.integer({ min: 0, max: 9 }),
        extraRows: fc.integer({ min: 0, max: 5 }),
        insideRow: fc.nat(),
        insideCol: fc.nat(),
        outsideRow: fc.nat(),
        outsideCol: fc.nat(),
      })
      .map((r) => {
        const rows = Math.min(1 + r.extraRows, HEIGHT - r.row);
        const cols = L + r.extraCols;
        const region: ScreenRegion = { row: r.row, col: r.col, rows, cols };
        const inside: Placed = { row: region.row + (r.insideRow % rows), col: region.col + (r.insideCol % (cols - L + 1)) };
        const decoys: Placed[] = [];
        // Whole token on a row outside the region
        const outsideRows = Array.from({ length: HEIGHT }, (_, i) => i).filter((i) => i < region.row || i >= region.row + rows);
        if (outsideRows.length > 0) decoys.push({ row: outsideRows[r.outsideRow % outsideRows.length] as number, col: r.outsideCol % (WIDTH - L + 1) });
        // Token on a row of the region but sticking out of it on the right or on the left
        const rightCol = region.col + cols - L + 1;
        if (rightCol + L <= WIDTH) decoys.push({ row: region.row, col: rightCol });
        if (region.col >= 1) decoys.push({ row: region.row + rows - 1, col: region.col - 1 });
        return { region, inside, decoys };
      });

    it('only the region counts: text outside it never matches, text inside it matches at the first poll after it appears', async () => {
      await fc.assert(
        fc.asyncProperty(patternSpec, regionArb, momentArb, pollMsArb, fc.boolean(), async (spec, geometry, moment, pollMs, notify) => {
          const wait = compileScreenPattern({ ...spec, region: geometry.region });
          const p = clampPoll(pollMs);
          const decoyScreen = render(geometry.decoys);
          // Decoys alone never satisfy the wait
          expect(matchesScreen(decoyScreen, wait)).toBe(false);
          const withToken = render([...geometry.decoys, geometry.inside]);
          expect(matchesScreen(withToken, wait)).toBe(true);

          const snapshots = moment.appearsAt === 0
            ? [{ at: 0, screen: withToken }]
            : [{ at: 0, screen: decoyScreen }, { at: moment.appearsAt, screen: withToken }];
          const { result, endTime } = await simulate(snapshots, wait, { timeoutMs: moment.timeoutMs, pollMs, notify });
          expect(result.matched).toBe(true);
          expect(endTime).toBe(notify ? moment.appearsAt : Math.min(Math.ceil(moment.appearsAt / p) * p, moment.timeoutMs));

          // Without the token inside the region the wait runs to its timeout
          const never = await simulate([{ at: 0, screen: decoyScreen }], wait, { timeoutMs: moment.timeoutMs, pollMs, notify });
          expect(never.result.matched).toBe(false);
          expect(never.endTime).toBe(moment.timeoutMs);
        }),
        RUNS
      );
    });
  });

  it('what counts is the screen at a poll instant: a pattern that comes and goes between two polls is missed, unless an output notification polls in between', async () => {
    await fc.assert(
      fc.asyncProperty(
        patternSpec,
        pollMsArb,
        fc.nat({ max: 20 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        matchingScreen,
        staleScreen(),
        async (spec, pollMs, k, f1, f2, shown, stale) => {
          const wait = compileScreenPattern(spec);
          const p = clampPoll(pollMs);
          // Two instants strictly inside (k*p, (k+1)*p), t1 < t2: no poll falls in [t1, t2)
          const a = 1 + Math.floor(f1 * (p - 3));
          const b = a + 1 + Math.floor(f2 * (p - 2 - a));
          expect(a).toBeLessThan(b);
          expect(b).toBeLessThan(p);
          const t1 = k * p + a;
          const t2 = k * p + b;
          const timeoutMs = (k + 3) * p;
          const snapshots: Snapshot[] = [
            { at: 0, screen: stale },
            { at: t1, screen: shown },
            { at: t2, screen: stale },
          ];

          const polled = await simulate(snapshots, wait, { timeoutMs, pollMs, notify: false });
          expect(polled.result.matched).toBe(false);
          expect(polled.endTime).toBe(timeoutMs);

          const notified = await simulate(snapshots, wait, { timeoutMs, pollMs, notify: true });
          expect(notified.result.matched).toBe(true);
          expect(notified.endTime).toBe(t1);
        }
      ),
      RUNS
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Safety of the regular expressions
// ---------------------------------------------------------------------------------------------

describe('Property 16 (safety): invalid and catastrophic expressions are refused, accepted ones are cheap to match', () => {
  const letters = fc.array(fc.constantFrom(...'abcxyz'), { maxLength: 4 }).map((c) => c.join(''));

  // Expressions that are invalid wherever they are put in a longer expression
  const invalidCore = fc.constantFrom('(', ')', '[abc', 'a{2,1}', '\\', '(?<n>a)(?<n>b)', '(?', 'a**');
  // Expressions with a repeated group that holds a repetition
  const catastrophic: fc.Arbitrary<string> = fc
    .tuple(
      fc.constantFrom('a', '\\w', '.', '[ab]', '\\d', '\\s'),
      fc.constantFrom('+', '*', '{2,}'),
      fc.constantFrom('+', '*', '{1,}'),
      fc.boolean()
    )
    .map(([atom, inner, outer, capture]) => `${capture ? '(' : '(?:'}${atom}${inner})${outer}`);

  const refusedSpec: fc.Arbitrary<ScreenPatternSpec> = fc.oneof(
    fc.tuple(letters, invalidCore).map(([pre, core]): ScreenPatternSpec => ({ regex: `${pre}${core}` })),
    fc.constantFrom('+', '?', '*', '{2}').map((core): ScreenPatternSpec => ({ regex: core })),
    fc.tuple(letters, catastrophic, letters).map(([pre, core, post]): ScreenPatternSpec => ({ regex: `${pre}${core}${post}$` })),
    fc.integer({ min: MAX_PATTERN_LENGTH + 1, max: 900 }).map((n): ScreenPatternSpec => ({ regex: 'a'.repeat(n) })),
    fc.integer({ min: MAX_PATTERN_LENGTH + 1, max: 900 }).map((n): ScreenPatternSpec => ({ text: 'a'.repeat(n) })),
    fc.constantFrom('g', 'y', 'd', 'x', 'imm', 'ss').map((flags): ScreenPatternSpec => ({ regex: 'a', flags })),
    fc.constantFrom<ScreenPatternSpec>({}, { text: '' }, { regex: '' }, { text: 'a', regex: 'a' })
  );

  it('refuses invalid, catastrophic, oversized and ambiguous patterns before any matching', () => {
    fc.assert(
      fc.property(refusedSpec, (spec) => {
        expect(() => compileScreenPattern(spec)).toThrow(PatternError);
      }),
      RUNS
    );
  });

  // Atoms and quantifiers of expressions that compile: some are slow on purpose (alternations that overlap,
  // several unbounded repetitions in a row)
  const atoms = ['a', 'b', '.', '\\w', '\\s', '\\d', '[ab]', '[^x]', '(ab)', '(a|aa)', '(a|b)', '(?:a|a)', '(\\w|\\d)', 'x?'];
  const quantifiers = ['', '+', '*', '?', '{2}', '{1,3}', '{2,}'];
  const piece = fc.tuple(fc.constantFrom(...atoms), fc.constantFrom(...quantifiers)).map(([atom, q]) => `${atom}${q}`);
  const candidate: fc.Arbitrary<ScreenPatternSpec> = fc
    .tuple(fc.boolean(), fc.array(piece, { minLength: 1, maxLength: 7 }), fc.boolean(), fc.constantFrom('', 'i', 'm', 's', 'ms', 'is'))
    .map(([anchorStart, pieces, anchorEnd, flags]) => ({
      regex: `${anchorStart ? '^' : ''}${pieces.join('')}${anchorEnd ? '$' : ''}`,
      flags,
    }));

  const hugeScreens: string[] = [
    `${'a'.repeat(99_999)}b`,
    'a'.repeat(100_000),
    'ab'.repeat(50_000),
    `${'a '.repeat(49)}\n`.repeat(2_000).slice(0, 100_000),
    `${'a'.repeat(99_999)}\n`,
    ' '.repeat(100_000),
  ];

  /**
   * Real time of one match, the best of up to 3 tries: a slow expression is slow every time, while a
   * busy machine (the whole suite runs in parallel) can stall any single try.
   */
  const matchTime = (screen: string, wait: CompiledScreenPattern): number => {
    let best = Infinity;
    for (let i = 0; i < 3 && best >= SLOW_MATCH_MS; i++) {
      const started = performance.now();
      matchesScreen(screen, wait);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  it('matches a 100,000 character screen within the time bound for every pattern that is accepted', () => {
    let accepted = 0;
    fc.assert(
      fc.property(candidate, fc.constantFrom<'appear' | 'disappear'>('appear', 'disappear'), (spec, mode) => {
        let wait: CompiledScreenPattern;
        try {
          wait = compileScreenPattern({ ...spec, mode });
        } catch (err) {
          expect(err).toBeInstanceOf(PatternError);
          return;
        }
        accepted += 1;
        for (const screen of hugeScreens) {
          const took = matchTime(screen, wait);
          expect(took, `${wait.source} (${wait.flags}) took ${Math.round(took)} ms`).toBeLessThan(SLOW_MATCH_MS);
        }
      }),
      RUNS
    );
    expect(accepted).toBeGreaterThan(20);
  }, 180_000);

  it('matches known slow accepted expressions on adversarial screens within the time bound', () => {
    for (const regex of ['(a|aa)+$', '(a|a)*b', 'a*a*a*a*b', '.*.*.*x', '.*a.*b.*c', '(\\d+|\\w+)*x'.replace('*x', '{2,}x')]) {
      let wait: CompiledScreenPattern;
      try {
        wait = compileScreenPattern({ regex });
      } catch (err) {
        expect(err).toBeInstanceOf(PatternError);
        continue;
      }
      for (const screen of hugeScreens) {
        expect(matchTime(screen, wait), regex).toBeLessThan(SLOW_MATCH_MS);
      }
    }
  }, 60_000);
});
