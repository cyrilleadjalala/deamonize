import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { applyTemplate, findBindings, templateOf, type Binding, type RequestParts, type Scalar } from '../../src/recorder/http-correlate.js';

// Feature: daemonize, Property 18: Variables bound in a recipe are exactly where the recorded value was
// **Validates: Requirements 13.2, 13.7**

type Node =
  | { t: 'lit'; v: string | number | null }
  | { t: 'var'; i: number }
  | { t: 'arr'; items: Node[] }
  | { t: 'obj'; entries: Array<[string, Node]> };

const NAMES = ['alpha', 'beta', 'gamma'];
const word = fc.stringMatching(/^[a-z0-9]{1,8}$/);
// Fillers can never equal a variable value: strings start with x_, numbers are negative
const litString = word.map((w) => `x_${w}`);
const litLeaf: fc.Arbitrary<Node> = fc.oneof(
  litString.map((v): Node => ({ t: 'lit', v })),
  fc.integer({ min: -999, max: -1 }).map((v): Node => ({ t: 'lit', v })),
  fc.constant<Node>({ t: 'lit', v: null })
);
const varNode = fc.integer({ min: 0, max: 2 }).map((i): Node => ({ t: 'var', i }));
const key = fc.stringMatching(/^k[a-z0-9/~ ]{0,5}$/);

function nodeArb(depth: number): fc.Arbitrary<Node> {
  const leaf = fc.oneof(litLeaf, varNode, varNode);
  if (depth === 0) return leaf;
  return fc.oneof(
    leaf,
    fc.array(nodeArb(depth - 1), { maxLength: 3 }).map((items): Node => ({ t: 'arr', items })),
    fc
      .uniqueArray(fc.tuple(key, nodeArb(depth - 1)), { maxLength: 3, selector: (entry) => entry[0] })
      .map((entries): Node => ({ t: 'obj', entries }))
  );
}

const slot = fc.oneof(litString.map((v): Node => ({ t: 'lit', v })), varNode);

interface Plan {
  path: Node[];
  query: Array<[string, Node]>;
  header: Node;
  body: Node | undefined;
}

const planArb: fc.Arbitrary<Plan> = fc.record({
  path: fc.array(slot, { minLength: 1, maxLength: 4 }),
  query: fc.uniqueArray(fc.tuple(word.map((w) => `q_${w}`), slot), { maxLength: 4, selector: (e) => e[0] }),
  header: slot,
  body: fc.option(
    fc.uniqueArray(fc.tuple(key, nodeArb(2)), { maxLength: 4, selector: (e) => e[0] }).map((entries): Node => ({ t: 'obj', entries })),
    { nil: undefined }
  ),
});

const recordedArb: fc.Arbitrary<Scalar[]> = fc.tuple(word.map((w) => `v_${w}`), fc.integer({ min: 1000, max: 9999 }), fc.boolean());
// Other values have the same types, so the typed leaves stay valid
const otherArb: fc.Arbitrary<Scalar[]> = fc.tuple(
  fc.stringMatching(/^[A-Za-z0-9 _/&=?#é-]{1,12}$/).map((w) => `v_${w}`),
  fc.integer({ min: -50, max: 50 }),
  fc.boolean()
);

const esc = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

/** The request a plan gives for some values, and where it put the Variables. */
function build(plan: Plan, values: Scalar[]): { request: RequestParts; expected: Binding[] } {
  const expected: Binding[] = [];
  const text = (node: Node, where: Binding['in'], name: string): string => {
    if (node.t === 'var') {
      expected.push({ variable: NAMES[node.i], in: where, name });
      return String(values[node.i]);
    }
    return String((node as { v: string }).v);
  };
  const segments = plan.path.map((node, i) => {
    const value = text(node, 'path', String(i + 1));
    return node.t === 'var' ? encodeURIComponent(value) : value;
  });
  const search = new URLSearchParams(plan.query.map(([k, node]) => [k, text(node, 'query', k)])).toString();
  const headers = { 'x-trace': text(plan.header, 'header', 'x-trace') };

  const body = (node: Node, pointer: string): unknown => {
    if (node.t === 'lit') return node.v;
    if (node.t === 'var') {
      expected.push({ variable: NAMES[node.i], in: 'body', name: pointer });
      return values[node.i];
    }
    if (node.t === 'arr') return node.items.map((item, i) => body(item, `${pointer}/${i}`));
    return Object.fromEntries(node.entries.map(([k, item]) => [k, body(item, `${pointer}/${esc(k)}`)]));
  };

  const request: RequestParts = {
    method: 'POST',
    url: `http://example.test/${segments.join('/')}${search === '' ? '' : `?${search}`}`,
    headers,
  };
  if (plan.body !== undefined) {
    request.body = body(plan.body, '');
    request.bodyFormat = 'json';
  }
  return { request, expected };
}

const sortKey = (b: Binding): string => `${b.in}|${b.name}|${b.variable}`;
const sorted = (bindings: Binding[]): Binding[] => [...bindings].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
const named = (values: Scalar[]): Array<{ name: string; value: Scalar }> => values.map((value, i) => ({ name: NAMES[i], value }));
const asRecord = (values: Scalar[]): Record<string, Scalar> => Object.fromEntries(values.map((v, i) => [NAMES[i], v]));

describe('Property 18: Variables bound in a recipe are exactly where the recorded value was', () => {
  it('binds every position where a value was planted, and no other', () => {
    fc.assert(
      fc.property(planArb, recordedArb, (plan, recorded) => {
        const { request, expected } = build(plan, recorded);
        expect(sorted(findBindings(named(recorded), request))).toEqual(sorted(expected));
      }),
      { numRuns: 200 }
    );
  });

  it('applying the bindings with the recorded values gives back the original request', () => {
    fc.assert(
      fc.property(planArb, recordedArb, (plan, recorded) => {
        const { request } = build(plan, recorded);
        const template = templateOf(request, findBindings(named(recorded), request));
        const applied = applyTemplate(template, asRecord(recorded));
        expect(applied.url).toBe(request.url);
        expect(applied.headers).toEqual(request.headers);
        expect(applied.body).toEqual(request.body);
      }),
      { numRuns: 200 }
    );
  });

  it('applying other values changes only the bound positions', () => {
    fc.assert(
      fc.property(planArb, recordedArb, otherArb, (plan, recorded, other) => {
        const { request } = build(plan, recorded);
        const template = templateOf(request, findBindings(named(recorded), request));
        const applied = applyTemplate(template, asRecord(other));
        const expected = build(plan, other).request;
        expect(applied.url).toBe(expected.url);
        expect(applied.headers).toEqual(expected.headers);
        expect(applied.body).toEqual(expected.body);
      }),
      { numRuns: 200 }
    );
  });
});
