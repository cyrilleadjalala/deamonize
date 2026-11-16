// Feature: daemonize, Property 13: row resolution is independent of row order
//
// **Validates: Requirements 14.5, 14.6, 14.7**
//
// Model: a table is a list of rows, each with a hidden unique `id` and 2-5 cells of text.
// Whatever the order of the rows, a relational locator must resolve the row of the target
// key (identified by its hidden id), report ROW_NOT_FOUND for 0 matches and AMBIGUOUS_ROW
// for several exact matches, never pick one of them arbitrarily.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fc from 'fast-check';
import { chromium, type Browser, type Page } from 'playwright';
import {
  buildRowLocator,
  matchRows,
  resolveRowStep,
  RowResolutionError,
  type RowKind,
} from '../../src/replay/runtime/row-resolver.js';

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

interface ModelRow {
  id: number;
  cells: string[];
}
type Outcome = { kind: 'row'; id: number } | { kind: 'error'; code: string };

// ---------- generators ----------

// Accents, quotes, regex characters, extra whitespace, NFC/NFD forms; several share text on purpose
const POOL = [
  'Ada', 'Bob', 'Grace', 'José', 'Jose\u0301', 'Zoë  Müller', "O'Brien \"Q\"", 'A+B (x) [y]', '^$.*?|\\',
  'a   b', ' padded ', 'Straße', 'ÉCOLE', 'école', '<b>tag</b> & co', '日本語', '50%', 'x',
];
const cellText = fc.oneof(
  { arbitrary: fc.constantFrom(...POOL), weight: 3 },
  // visible text only: the DOM (textContent) must be able to carry it unchanged
  { arbitrary: fc.fullUnicodeString({ minLength: 1, maxLength: 8 }).filter((s) => s.trim() !== '' && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)), weight: 1 },
);
const rowsArb = fc.integer({ min: 2, max: 8 }).chain((n) =>
  fc.array(fc.array(cellText, { minLength: 2, maxLength: 5 }), { minLength: n, maxLength: n }).map((all) =>
    all.map((cells, id) => ({ id, cells }) as ModelRow)
  )
);
/** Same text, written differently: case flipped, accents decomposed, whitespace padded/doubled. */
const variant = (s: string, how: number): string => {
  switch (how % 4) {
    case 0: return s;
    case 1: return `  ${s.replace(/ /g, '   ')}\t`;
    case 2: return s.toUpperCase();
    default: return s.normalize('NFD');
  }
};
const permutationOf = (n: number) => fc.shuffledSubarray([...Array(n).keys()], { minLength: n, maxLength: n });
const permute = <T>(items: T[], perm: number[]): T[] => perm.map((i) => items[i]);

// ---------- independent oracle (not the resolver code) ----------
const norm = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
function oracle(rows: ModelRow[], key: string): Outcome {
  const target = norm(key);
  const exact = rows.filter((r) => r.cells.some((c) => norm(c) === target));
  const hits = exact.length > 0 ? exact : rows.filter((r) => r.cells.some((c) => norm(c).includes(target)));
  if (hits.length === 0) return { kind: 'error', code: 'ROW_NOT_FOUND' };
  if (hits.length > 1) return { kind: 'error', code: 'AMBIGUOUS_ROW' };
  return { kind: 'row', id: hits[0].id };
}

/** Pure resolution: the same decision as the in-page resolver, through the exported pure functions. */
function resolvePure(rows: ModelRow[], key: string): Outcome {
  const locator = buildRowLocator({ container: { kind: 'row' }, variable: 'k' }, { k: key });
  const { matches } = matchRows(rows, locator.hasText);
  if (matches.length === 0) return { kind: 'error', code: 'ROW_NOT_FOUND' };
  if (matches.length > 1) return { kind: 'error', code: 'AMBIGUOUS_ROW' };
  return { kind: 'row', id: rows[matches[0]].id };
}

describe('Property 13 (pure level): matchRows / buildRowLocator', () => {
  it('resolves the same row (by hidden id) for every permutation of the rows, as the oracle says', () => {
    fc.assert(
      fc.property(
        rowsArb, fc.nat(), fc.nat(), fc.nat(),
        fc.boolean(),
        (rows, rowPick, cellPick, how, fresh) => {
          const source = rows[rowPick % rows.length];
          const base = fresh ? `no-such-${source.id}` : source.cells[cellPick % source.cells.length];
          const key = variant(base, how);
          fc.pre(norm(key) !== '');
          const expected = oracle(rows, key);
          return fc.check(
            fc.property(permutationOf(rows.length), (perm) => {
              expect(resolvePure(permute(rows, perm), key)).toEqual(expected);
            }),
            { numRuns: 6 }
          ).failed === false;
        }
      ),
      { numRuns: 250 }
    );
  });

  it('a key unique to one row (exact, whatever its case, accents form and spacing) selects exactly that row', () => {
    fc.assert(
      fc.property(rowsArb, fc.nat(), fc.nat(), fc.nat(), permutationOf(8), (rows, rowPick, cellPick, how, perm8) => {
        const target = rows[rowPick % rows.length];
        // Restriction: the key is made unique by construction (a token holding the row id);
        // rows that are intentionally ambiguous are covered by the AMBIGUOUS_ROW property below.
        const token = `key-${target.id}-Ünïque`;
        const cells = target.cells.slice();
        cells[cellPick % cells.length] = token;
        const model = rows.map((r) => (r.id === target.id ? { id: r.id, cells } : r));
        const perm = perm8.filter((i) => i < model.length);
        const found = resolvePure(permute(model, perm), variant(token, how));
        expect(found).toEqual({ kind: 'row', id: target.id });
      }),
      { numRuns: 250 }
    );
  });

  it('a key that matches no row is ROW_NOT_FOUND in every order', () => {
    fc.assert(
      fc.property(rowsArb, permutationOf(8), (rows, perm8) => {
        const key = 'absent-key-\u2603-777';
        fc.pre(rows.every((r) => r.cells.every((c) => !norm(c).includes(norm(key)))));
        const perm = perm8.filter((i) => i < rows.length);
        expect(resolvePure(permute(rows, perm), key)).toEqual({ kind: 'error', code: 'ROW_NOT_FOUND' });
      }),
      { numRuns: 200 }
    );
  });

  it('a key equal to a cell of several rows is AMBIGUOUS_ROW, never an arbitrary pick, in every order', () => {
    fc.assert(
      fc.property(rowsArb, fc.nat(), fc.nat(), fc.nat(), fc.nat(), permutationOf(8), (rows, a, b, c, how, perm8) => {
        const first = a % rows.length;
        const second = (first + 1 + (b % (rows.length - 1))) % rows.length;
        const token = 'Twin  Karl';
        const model = rows.map((r) =>
          r.id === first || r.id === second
            ? { id: r.id, cells: r.cells.map((cell, i) => (i === c % r.cells.length ? (r.id === first ? token : token.toLowerCase()) : cell)) }
            : r
        );
        const perm = perm8.filter((i) => i < model.length);
        expect(resolvePure(permute(model, perm), variant(token, how))).toEqual({ kind: 'error', code: 'AMBIGUOUS_ROW' });
      }),
      { numRuns: 200 }
    );
  });

  it('refuses an empty key and a missing variable instead of choosing a row', () => {
    expect(() => buildRowLocator({ container: { kind: 'row' }, variable: 'k' }, { k: '  ' })).toThrow(RowResolutionError);
    expect(() => buildRowLocator({ container: { kind: 'row' }, variable: 'k' }, {})).toThrow(/ROW_VARIABLE_MISSING/);
  });
});

describe('Property 13 (browser level): the in-page resolver', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
    page = await browser.newPage();
  }, 60000);
  afterAll(async () => {
    await browser?.close();
  }, 30000);

  /** Render the rows in the given order as a table or as cards; DOM built from text, no HTML parsing of the data. */
  async function render(shape: 'table' | 'cards', rows: ModelRow[]): Promise<void> {
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    await page.evaluate(
      ({ shape, rows }) => {
        const body = document.body;
        if (shape === 'table') {
          const table = document.createElement('table');
          const head = table.createTHead().insertRow();
          for (const h of ['Col A', 'Col B']) { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); }
          const tbody = table.createTBody();
          for (const row of rows) {
            const tr = tbody.insertRow();
            tr.setAttribute('data-id', String(row.id));
            for (const cell of row.cells) tr.insertCell().textContent = cell;
          }
          body.appendChild(table);
        } else {
          for (const row of rows) {
            const card = document.createElement('article');
            card.setAttribute('data-id', String(row.id));
            for (const cell of row.cells) { const s = document.createElement('span'); s.textContent = cell; card.appendChild(s); s.after(document.createTextNode(' ')); }
            body.appendChild(card);
          }
        }
      },
      { shape, rows }
    );
  }

  async function resolveInPage(kind: RowKind, key: string): Promise<Outcome> {
    try {
      const resolved = await resolveRowStep(page, { selectors: ['css=button'], rowBinding: { container: { kind }, variable: 'k' } }, { k: key });
      const id = await page.locator('[data-daemonize-row="1"]').first().getAttribute('data-id');
      expect(resolved).toBeDefined();
      return { kind: 'row', id: Number(id) };
    } catch (e) {
      const m = /^(?:Error: )?(ROW_NOT_FOUND|AMBIGUOUS_ROW)/.exec(String((e as Error).message).replace(/^.*?(ROW_NOT_FOUND|AMBIGUOUS_ROW)/s, '$1'));
      if (m) return { kind: 'error', code: m[1] };
      throw e;
    }
  }

  it('resolves the same hidden row id for any order, in an HTML table and in cards', async () => {
    await fc.assert(
      fc.asyncProperty(
        rowsArb, fc.nat(), fc.nat(), fc.nat(), fc.boolean(), permutationOf(8), permutationOf(8),
        async (rows, rowPick, cellPick, how, fresh, permA8, permB8) => {
          const source = rows[rowPick % rows.length];
          const key = variant(fresh ? `no-such-${source.id}` : source.cells[cellPick % source.cells.length], how);
          // Restriction: a key whose text is blank once whitespace is collapsed is an ROW_KEY_EMPTY case, not a row key
          fc.pre(norm(key) !== '');
          const expected = oracle(rows, key);
          for (const shape of ['table', 'cards'] as const) {
            for (const perm8 of [permA8, permB8]) {
              const ordered = permute(rows, perm8.filter((i) => i < rows.length));
              await render(shape, ordered);
              expect(await resolveInPage(shape === 'table' ? 'row' : 'card', key)).toEqual(expected);
            }
          }
        }
      ),
      { numRuns: 25 }
    );
  });
});
