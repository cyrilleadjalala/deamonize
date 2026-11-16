// Feature: daemonize, Property 9: run-time hash equals ScreenHasher
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fc from 'fast-check';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ScreenHasher } from '../../src/state/screen-hasher.js';
import * as rt from '../../src/replay/runtime/screen-hash.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { ScreenContent, WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
const word = fc.stringMatching(/^[a-z]{1,8}$/);
const uuid = fc.uuid();

const attrArb: fc.Arbitrary<string> = fc.oneof(
  fc.tuple(word, word).map(([n, v]) => `data-${n}="${v}"`),
  fc.tuple(word, word).map(([n, v]) => `${n}='${v}'`),
  word.map((n) => `${n}`),
  uuid.map((u) => `id="item-${u}"`),
  word.map((w) => `id="${w}"`),
  word.map((w) => `nonce="${w}"`),
  fc.nat(999).map((n) => `data-reactid=".0.${n}"`),
  fc.constantFrom('csrf_token', '_token', 'authenticity_token').map((n) => `name="${n}"`),
  word.map((w) => `class="${w}"`),
);

const elementArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('div', 'input', 'span', 'form', 'button'),
    fc.array(attrArb, { maxLength: 5 }), // array order is random
    fc.constantFrom('', ' ', '\n  ', '\t', 'text'),
    fc.boolean(),
  )
  .map(([tag, attrs, inner, selfClose]) => {
    const a = attrs.length ? ' ' + attrs.join(' ') : '';
    return selfClose ? `<${tag}${a}/>` : `<${tag}${a}>${inner}</${tag}>`;
  });

const domArb = fc
  .array(fc.tuple(elementArb, fc.constantFrom('', ' ', '\n', '\r\n  ')), { maxLength: 8 })
  .map((parts) => parts.map(([e, ws]) => e + ws).join(''));

const ansiArb = fc.constantFrom('\x1b[0m', '\x1b[31;1m', '\x1b[2J', '\x1b[10;5H', '\x1b[K', '\x1b]0;t', '\x1b');
const termLineArb = fc
  .array(fc.oneof(fc.stringMatching(/^[ -~]{0,12}$/), ansiArb), { maxLength: 5 })
  .chain((parts) => fc.constantFrom('', ' ', '   ', '\t').map((tail) => parts.join('') + tail));
const terminalArb = fc.array(termLineArb, { maxLength: 8 }).map((l) => l.join('\n'));

const plainTermArb = fc
  .array(fc.stringMatching(/^[ -~]{0,20}$/), { minLength: 1, maxLength: 10 })
  .map((l) => l.join('\n'));

const screenArb: fc.Arbitrary<ScreenContent> = fc.oneof(
  domArb.map((raw) => ({ type: 'dom' as const, raw, normalized: '', capturedAt: 0 })),
  terminalArb.map((raw) => ({ type: 'terminal' as const, raw, normalized: '', capturedAt: 0 })),
);

describe('Property 9: runtime screen hash equals ScreenHasher', () => {
  const hasher = new ScreenHasher();

  it('src runtime module equals ScreenHasher for DOM and terminal screens', () => {
    fc.assert(
      fc.property(screenArb, (s) => {
        expect(rt.screenId(s.type, s.raw)).toBe(hasher.computeId(s));
        expect(rt.normalizedHash(s.type, s.raw)).toBe(hasher.normalizedHash(s));
        expect(rt.normalizedHash(s.type, s.raw)).toHaveLength(64);
        expect(rt.screenId(s.type, s.raw)).toHaveLength(16);
      }),
      { numRuns: 200 },
    );
  });

  describe('nodes and markers injected by the recorder or the replayer', () => {
    const ui =
      '<div data-daemonize-ui="" style="position:fixed"><button data-daemonize-action="make-variable">Make variable</button>' +
      '<div><input data-daemonize-ui></div><span>x</span></div>';

    it('are ignored by ScreenHasher and the runtime module alike', () => {
      fc.assert(
        fc.property(domArb, domArb, fc.boolean(), (a, b, rowMarked) => {
          const clean = `<body>${a}<table><tr><td>Ada</td></tr></table>${b}</body>`;
          const row = rowMarked ? ' data-daemonize-row="r1"' : '';
          const dirty = `<body>${a}<table><tr${row}><td>Ada</td></tr></table>${ui}${b}</body><div data-daemonize-ui>late</div>`;
          const screen = (raw: string): ScreenContent => ({ type: 'dom', raw, normalized: '', capturedAt: 0 });
          expect(rt.screenId('dom', dirty)).toBe(rt.screenId('dom', clean));
          expect(hasher.computeId(screen(dirty))).toBe(hasher.computeId(screen(clean)));
          expect(hasher.computeId(screen(dirty))).toBe(rt.screenId('dom', dirty));
        }),
        { numRuns: 100 },
      );
      expect(rt.normalizeDom('<p data-daemonize-ui><p>in</p></p><i>k</i>')).toBe('<i>k</i>');
    });
  });

  describe('compiled copy in the output directory', () => {
    let dir: string;
    let copy: typeof rt;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'daemonize-p9-'));
      const set: WorkflowSet = {
        version: '1',
        targetType: 'web',
        targetName: 'P9',
        startUrl: 'http://localhost:8080/',
        workflows: [
          {
            id: 'd1111111-1111-4111-8111-111111111111',
            label: 'Go',
            steps: [{ actionType: 'click', selectors: ['#go'] }],
            variables: [],
            observedPayloads: [],
          },
        ],
      };
      const log = console.log;
      console.log = () => { };
      try {
        await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
      } finally {
        console.log = log;
      }
      copy = (await import(pathToFileURL(join(dir, 'screen-hash.js')).href)) as typeof rt;
    }, 60_000);

    afterAll(async () => {
      await removeDir(dir);
    });

    it('copied screen-hash.js equals ScreenHasher', () => {
      fc.assert(
        fc.property(screenArb, (s) => {
          expect(copy.screenId(s.type, s.raw)).toBe(hasher.computeId(s));
          expect(copy.normalizedHash(s.type, s.raw)).toBe(hasher.normalizedHash(s));
        }),
        { numRuns: 30 },
      );
    });
  });

  describe('idempotence', () => {
    it('normalize(normalize(x)) == normalize(x) for terminal text', () => {
      fc.assert(
        fc.property(terminalArb, (t) => {
          const once = rt.normalizeTerminal(t);
          expect(rt.normalizeTerminal(once)).toBe(once);
        }),
        { numRuns: 200 },
      );
    });

    it('normalize(normalize(x)) == normalize(x) for DOM', () => {
      fc.assert(
        fc.property(domArb, (h) => {
          const once = rt.normalizeDom(h);
          expect(rt.normalizeDom(once)).toBe(once);
        }),
        { numRuns: 200 },
      );
      expect(rt.normalizeDom('<div/>')).toBe('<div />');
      expect(rt.normalizeDom('<div />')).toBe('<div />');
    });
  });

  describe('terminal zone', () => {
    const rectArb = fc.record({
      row: fc.nat(6),
      col: fc.nat(10),
      rows: fc.integer({ min: 1, max: 6 }),
      cols: fc.integer({ min: 1, max: 12 }),
    });
    const zoneHash = (t: string, r: rt.HashZone['rect'] & object) =>
      rt.normalizedHash('terminal', rt.cropTerminal(t, r));

    it('is deterministic', () => {
      fc.assert(
        fc.property(plainTermArb, rectArb, (t, r) => {
          expect(zoneHash(t, r)).toBe(zoneHash(t, r));
          expect(rt.cropTerminal(t, r)).toBe(rt.cropTerminal(t, r));
        }),
        { numRuns: 100 },
      );
    });

    it('is unchanged by edits outside the rectangle', () => {
      fc.assert(
        fc.property(
          fc.array(fc.stringMatching(/^[a-z]{20}$/), { minLength: 10, maxLength: 10 }),
          rectArb,
          fc.nat(9),
          fc.nat(19),
          (lines, r, er, ec) => {
            fc.pre(er < r.row || er >= r.row + r.rows || ec < r.col || ec >= r.col + r.cols);
            const edited = lines.map((l, i) =>
              i === er ? l.slice(0, ec) + (l[ec] === 'Z' ? 'Y' : 'Z') + l.slice(ec + 1) : l,
            );
            expect(zoneHash(edited.join('\n'), r)).toBe(zoneHash(lines.join('\n'), r));
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
