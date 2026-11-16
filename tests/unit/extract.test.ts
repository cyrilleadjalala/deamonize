import { describe, it, expect } from 'vitest';
import {
  collapseText,
  cropRect,
  extractRegex,
  extractTerminalZone,
  finishWebZone,
  listToStrings,
  normalizeHeaders,
  pairsToObject,
  parseJsonText,
  pickResultZone,
  redactDeep,
  regexGroupNames,
  tableToObjects,
  zoneFailureResult,
} from '../../src/replay/runtime/extract.js';
import { dataSchemaFor } from '../../src/schema/data-schema.js';
import { describeOutput } from '../../src/compiler/tool-description.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';

describe('table extraction', () => {
  it('turns a header row and body rows into objects keyed by header', () => {
    expect(tableToObjects(['ID', 'Customer'], [['1', 'Ada'], ['2', 'Bob']])).toEqual([
      { ID: '1', Customer: 'Ada' },
      { ID: '2', Customer: 'Bob' },
    ]);
  });

  it('takes the first row as the header when the table has none', () => {
    expect(tableToObjects(null, [['id', 'name'], ['1', 'Ada']])).toEqual([{ id: '1', name: 'Ada' }]);
  });

  it('gives [] for a table without rows, with or without header', () => {
    expect(tableToObjects(['A', 'B'], [])).toEqual([]);
    expect(tableToObjects(null, [])).toEqual([]);
    expect(tableToObjects(null, [['A', 'B']])).toEqual([]);
  });

  it('normalises header names: spaces collapsed, empty ones numbered, duplicates suffixed', () => {
    expect(normalizeHeaders(['  Unit \n price ', '', 'Qty', 'Qty', 'Qty', ''])).toEqual([
      'Unit price',
      'column_2',
      'Qty',
      'Qty_2',
      'Qty_3',
      'column_6',
    ]);
  });

  it('keeps cells of a table with duplicate headers apart', () => {
    expect(tableToObjects(['Name', 'Name'], [['Ada', 'Lovelace']])).toEqual([{ Name: 'Ada', Name_2: 'Lovelace' }]);
  });

  it('pads short rows, names extra cells, drops empty rows and collapses cell text', () => {
    expect(tableToObjects(['A', 'B'], [['1'], ['x', 'y', 'z'], ['', ' '], ['a\n  b', ' c ']])).toEqual([
      // Every row has the same keys: a cell beyond the header widens them all
      { A: '1', B: '', column_3: '' },
      { A: 'x', B: 'y', column_3: 'z' },
      { A: 'a b', B: 'c', column_3: '' },
    ]);
  });

  it('keeps a header called __proto__ as a key', () => {
    const [row] = tableToObjects(['__proto__'], [['x']]);
    expect(Object.keys(row)).toEqual(['__proto__']);
  });
});

describe('other web kinds', () => {
  it('collapses visible text', () => {
    expect(collapseText('  a \t b \n\n  c  \r\n')).toBe('a b\nc');
  });

  it('lists items as strings, dropping empty ones', () => {
    expect(listToStrings([' one ', '', 'two\nlines'])).toEqual(['one', 'two lines']);
  });

  it('turns label/value pairs into an object, without colon, with repeated labels numbered', () => {
    expect(pairsToObject([['Name :', ' Ada '], ['Name', 'Bob'], ['', 'ignored'], ['City:', 'Paris']])).toEqual({
      Name: 'Ada',
      Name_2: 'Bob',
      City: 'Paris',
    });
  });

  it('parses JSON text, and explains when it is not JSON', () => {
    expect(parseJsonText('\n {"a": [1, 2]} ')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(parseJsonText('not json')).toMatchObject({ ok: false });
    expect(parseJsonText('  ')).toMatchObject({ ok: false });
  });

  it('finishes a raw reading according to the extractor and reports what cannot be read', () => {
    const zone = { selector: '#t', extractor: { kind: 'table' as const } };
    const done = finishWebZone({ text: 'ID Name\n1 Ada', header: ['ID', 'Name'], rows: [['1', 'Ada']] }, zone);
    expect(done).toEqual({ ok: true, text: 'ID Name\n1 Ada', data: [{ ID: '1', Name: 'Ada' }] });

    expect(finishWebZone(undefined, zone)).toMatchObject({ ok: false, error: 'result_zone_not_found' });
    expect(finishWebZone({ text: 'x', problem: 'no table' }, zone)).toMatchObject({ ok: false, error: 'result_extraction_failed' });
    expect(finishWebZone({ text: 'oops', json: 'oops' }, { selector: '#p', extractor: { kind: 'json' } })).toMatchObject({
      ok: false,
      error: 'result_extraction_failed',
    });
    expect(finishWebZone({ text: 'v', attr: null }, { selector: '#i', extractor: { kind: 'attribute', name: 'data-x' } })).toMatchObject({
      ok: false,
    });
    expect(finishWebZone({ text: 'v', attr: 'abc' }, { selector: '#i', extractor: { kind: 'attribute' } })).toMatchObject({ ok: true, data: 'abc' });
  });

  it('says in the failure that the action itself already ran', () => {
    const outcome = finishWebZone(undefined, { selector: '#missing' });
    if (outcome.ok) throw new Error('expected a failure');
    const result = zoneFailureResult(outcome, 12);

    expect(result).toMatchObject({
      success: false,
      drifted: true,
      error: 'result_zone_not_found',
      failure: { zone: { selector: '#missing' } },
      elapsedMs: 12,
    });
    expect(result.message).toMatch(/already ran/);
  });
});

describe('regex and rectangle (terminal)', () => {
  const screen = ['Inventory report', 'ID  NAME    QTY', '1   Widget  5', '2   Gadget  12', 'Status: OK (2 items)'].join('\n');

  it('crops a rectangle of the rendered screen', () => {
    expect(cropRect(screen, { row: 2, col: 4, rows: 2, cols: 6 })).toBe('Widget\nGadget');
    expect(cropRect(screen, { row: 40, col: 0, rows: 2, cols: 6 })).toBe('');
  });

  it('returns the named groups of the first match as an object', () => {
    expect(extractRegex(screen, 'Status: (?<state>\\w+) \\((?<count>\\d+) items\\)')).toEqual({ state: 'OK', count: '2' });
  });

  it('returns every match as an array with the g flag, and null without a match', () => {
    expect(extractRegex(screen, '^(?<id>\\d)\\s+(?<name>\\w+)\\s+(?<qty>\\d+)$', 'gm')).toEqual([
      { id: '1', name: 'Widget', qty: '5' },
      { id: '2', name: 'Gadget', qty: '12' },
    ]);
    expect(extractRegex(screen, 'Total: (?<n>\\d+)')).toBeNull();
  });

  it('gives { match } when the pattern has no named group, and rejects unsupported flags', () => {
    expect(extractRegex(screen, 'Widget')).toEqual({ match: 'Widget' });
    expect(() => extractRegex(screen, 'x', 'y!')).toThrow(/flags/);
  });

  it('lists the named groups of a pattern, ignoring escaped parentheses and classes', () => {
    expect(regexGroupNames('\\(?<no>x\\) [(?<no2>] (?<a>1) (?<b_2>2)')).toEqual(['a', 'b_2']);
  });

  it('extracts a terminal zone, and fails strictly when the pattern or the rectangle matches nothing', () => {
    const regex = { kind: 'regex' as const, pattern: 'Status: (?<state>\\w+)' };
    expect(extractTerminalZone(screen, { rect: { row: 4, col: 0, rows: 1, cols: 40 }, extractor: regex })).toEqual({
      ok: true,
      text: 'Status: OK (2 items)',
      data: { state: 'OK' },
    });
    expect(extractTerminalZone(screen, { rect: { row: 0, col: 0, rows: 3, cols: 40 }, extractor: regex })).toMatchObject({
      ok: false,
      error: 'result_zone_not_found',
    });
    expect(extractTerminalZone(screen, { rect: { row: 30, col: 0, rows: 3, cols: 10 } })).toMatchObject({
      ok: false,
      error: 'result_zone_not_found',
    });
    expect(extractTerminalZone(screen, { extractor: { kind: 'table' } })).toMatchObject({ ok: false, error: 'result_extraction_failed' });
    expect(extractTerminalZone(screen, { rect: { row: 1, col: 0, rows: 1, cols: 40 } })).toEqual({
      ok: true,
      text: 'ID  NAME    QTY',
      data: 'ID  NAME    QTY',
    });
  });
});

describe('redaction and zone choice', () => {
  it('removes secret values from every string of data', () => {
    const redact = (s: string): string => s.split('hunter2').join('***');
    expect(redactDeep({ a: 'x hunter2', b: ['hunter2', 1, null], c: { d: 'ok' } }, redact)).toEqual({
      a: 'x ***',
      b: ['***', 1, null],
      c: { d: 'ok' },
    });
  });

  it('uses the zone of the workflow, else the one of its last step', () => {
    const step = (id: string) => ({ resultZone: { selector: id } });
    expect(pickResultZone({ resultZone: { selector: 'w' }, steps: [step('a')] })).toEqual({ selector: 'w' });
    expect(pickResultZone({ steps: [step('a'), {}, step('b'), {}] })).toEqual({ selector: 'b' });
    expect(pickResultZone({ steps: [{}] })).toBeUndefined();
  });
});

describe('schema of data', () => {
  it('describes each kind', () => {
    expect(dataSchemaFor({ kind: 'text' })).toMatchObject({ type: 'string' });
    expect(dataSchemaFor({ kind: 'list' })).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(dataSchemaFor({ kind: 'table' }, [{ ID: '1', Name: 'Ada' }, { ID: '2', Qty: '5' }])).toMatchObject({
      type: 'array',
      items: { type: 'object', properties: { ID: { type: 'string' }, Name: { type: 'string' }, Qty: { type: 'string' } }, additionalProperties: { type: 'string' } },
    });
    expect(dataSchemaFor({ kind: 'fields' }, { Name: 'Ada' })).toMatchObject({ type: 'object', properties: { Name: { type: 'string' } } });
    expect(dataSchemaFor({ kind: 'regex', pattern: '(?<a>x)' })).toMatchObject({ type: 'object', properties: { a: { type: 'string' } } });
    expect(dataSchemaFor({ kind: 'regex', pattern: '(?<a>x)', flags: 'g' })).toMatchObject({ type: 'array', items: { type: 'object' } });
    expect(dataSchemaFor({ kind: 'json' }, { ok: true, n: 1.5, ids: [1, 2], who: { name: 'x' } })).toMatchObject({
      type: 'object',
      properties: { ok: { type: 'boolean' }, n: { type: 'number' }, ids: { type: 'array', items: { type: 'integer' } }, who: { type: 'object' } },
    });
  });

  it('adds `data` to the output schema, and to the tool description, only when the workflow has a zone', () => {
    const workflow = (resultZone?: Workflow['resultZone']): Workflow => ({
      id: '11111111-1111-4111-8111-111111111111',
      label: 'List orders',
      steps: [{ actionType: 'click', selectors: ['#go'] }],
      variables: [],
      observedPayloads: [],
      resultZone,
    });
    const set = (w: Workflow): WorkflowSet => ({ version: '1', targetType: 'web', targetName: 'Shop', startUrl: 'http://x/', workflows: [w] });

    const without = new SchemaInferencer().inferWorkflows(set(workflow())).workflows[0];
    expect(without.outputSchema?.['properties']).not.toHaveProperty('data');
    expect(describeOutput(without)).toBeUndefined();

    const zoned = new SchemaInferencer().inferWorkflows(
      set(workflow({ selector: '#orders', extractor: { kind: 'table' }, schema: dataSchemaFor({ kind: 'table' }, [{ ID: '1', Total: '2' }]) }))
    ).workflows[0];
    expect(zoned.outputSchema?.['properties']).toHaveProperty('data.items.properties.Total');
    expect(describeOutput(zoned)).toContain('array of objects');
    expect(describeOutput(zoned)).toContain('ID, Total');
  });
});
