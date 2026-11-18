import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildRowLocator,
  matchRows,
  scopeSelectors,
  ROW_RESOLVER_SOURCE,
  RowResolutionError,
} from '../../src/replay/runtime/row-resolver.js';

describe('buildRowLocator', () => {
  it('takes the text from the Variable, not from the recorded key', () => {
    const locator = buildRowLocator(
      { container: { kind: 'row' }, key: { text: 'Ada', column: 'Name' }, variable: 'customer' },
      { customer: 'Bob' }
    );
    expect(locator.hasText).toBe('Bob');
    expect(locator.column).toBe('Name');
    expect(locator.containerSelectorCandidates).toEqual(['tr', '[role=row]']);
  });

  it('uses the recorded key only when the binding has no Variable', () => {
    expect(buildRowLocator({ container: { kind: 'card' }, key: { text: 'Grace' } }, {}).hasText).toBe('Grace');
  });

  it('converts non-string Variable values and puts hint and role first', () => {
    const locator = buildRowLocator(
      { container: { kind: 'card', role: 'article', selectorHint: 'div.card' }, variable: 'id' },
      { id: 42 }
    );
    expect(locator.hasText).toBe('42');
    expect(locator.containerSelectorCandidates.slice(0, 3)).toEqual(['div.card', '[role=article]', 'article']);
  });

  it('falls back to the recorded key (2.11) and otherwise fails when the Variable has no value', () => {
    expect(buildRowLocator({ container: { kind: 'row' }, key: { text: 'Ada' }, variable: 'customer' }, {}).hasText).toBe('Ada');
    expect(() => buildRowLocator({ container: { kind: 'row' }, variable: 'customer' }, {}))
      .toThrow(/ROW_VARIABLE_MISSING/);
    expect(() => buildRowLocator({ container: { kind: 'row' }, variable: 'customer' }, { customer: '  ' }))
      .toThrow(RowResolutionError);
  });

  it('infers the kind from the role of legacy bindings', () => {
    expect(buildRowLocator({ container: { role: 'listitem' }, variable: 'v' }, { v: 'x' }).containerSelectorCandidates)
      .toEqual(['[role=listitem]', 'li']);
  });
});

describe('matchRows', () => {
  const rows = [
    { cells: ['Ada', 'Grace'] },
    { cells: ['Bob', 'Ada'] },
    { cells: ['Grace Hopper', 'Bob'] },
    { cells: ['José', 'Ada'] },
  ];

  it('prefers an equal cell over a containing one, whatever the case and spacing', () => {
    expect(matchRows(rows, '  ada ').matches).toEqual([0, 1, 3]);
    // "Grace Hopper" contains the text but "Grace" equals it
    expect(matchRows(rows, 'GRACE')).toEqual({ matches: [0], mode: 'exact' });
  });

  it('falls back to a substring when no cell is equal', () => {
    expect(matchRows(rows, 'Hopper')).toEqual({ matches: [2], mode: 'contains' });
  });

  it('restricts the search to one column', () => {
    expect(matchRows(rows, 'Ada', 0).matches).toEqual([0]);
    expect(matchRows(rows, 'Ada', 1).matches).toEqual([1, 3]);
  });

  it('is independent of the order of the rows', () => {
    const reversed = [...rows].reverse();
    const names = (list: typeof rows, text: string) => matchRows(list, text, 0).matches.map((i) => list[i].cells[0]);
    expect(names(reversed, 'Bob')).toEqual(names(rows, 'Bob'));
  });

  it('treats quotes, regex characters and composed/decomposed accents as plain text', () => {
    const special = [{ cells: ['A+B (x) [y]'] }, { cells: ['O\'Brien "Q"'] }, { cells: ['Jose\u0301'] }, { cells: ['.*'] }];
    expect(matchRows(special, 'a+b (x) [y]').matches).toEqual([0]);
    expect(matchRows(special, 'O\'Brien "Q"').matches).toEqual([1]);
    expect(matchRows(special, 'Jos\u00e9').matches).toEqual([2]);
    expect(matchRows(special, '.*').matches).toEqual([3]);
  });

  it('matches nothing for an empty text', () => {
    expect(matchRows(rows, '   ').matches).toEqual([]);
  });
});

describe('scopeSelectors', () => {
  it('chains each selector after the row, keeping only the part below a container', () => {
    expect(scopeSelectors('css=[data-daemonize-row="1"]', ['role=button[name="Delete"]', 'tr:has-text("x") >> role=button']))
      .toEqual([
        'css=[data-daemonize-row="1"] >> role=button[name="Delete"]',
        'css=[data-daemonize-row="1"] >> role=button',
      ]);
  });
});

describe('row-resolver.ts as a generated file', () => {
  it('imports nothing, so the compiler can copy it verbatim', () => {
    const source = readFileSync(new URL('../../src/replay/runtime/row-resolver.ts', import.meta.url), 'utf-8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfrom\s*["']/);
  });

  it('embeds matchRows in the in-page function and reports the two errors', () => {
    expect(ROW_RESOLVER_SOURCE).toContain('function matchRows');
    expect(ROW_RESOLVER_SOURCE).toContain('AMBIGUOUS_ROW');
    expect(ROW_RESOLVER_SOURCE).toContain('ROW_NOT_FOUND');
    expect(() => new Function(`return (${ROW_RESOLVER_SOURCE});`)).not.toThrow();
  });
});
