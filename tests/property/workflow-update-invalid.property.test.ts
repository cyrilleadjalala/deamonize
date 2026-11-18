// Feature: user-journey-improvements, Property 23: An invalid update changes nothing
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyUpdate } from '../../src/studio/workflow-editor.js';
import { variableNamesArb } from '../helpers/workflow-arbitraries.js';
import type { WorkflowSet } from '../../src/types.js';

// A set whose first workflow holds: a (text, payload "abc"), e (text, fixed list), k (check step, true or false),
// p (bound in a recorded URL path). Names are random but distinct.
function baseSet(names: string[]): { set: WorkflowSet; id: string; a: string; e: string; k: string; p: string } {
  const [a, e, k, p] = names;
  const id = '11111111-1111-4111-8111-111111111111';
  const set: WorkflowSet = {
    version: '1',
    targetType: 'web',
    targetName: 'Shop',
    startUrl: 'https://shop.example.com/',
    workflows: [
      {
        id,
        label: 'Find order',
        steps: [
          { actionType: 'type', selectors: ['role=textbox'], variable: a, value: 'abc' },
          { actionType: 'check', selectors: ['role=checkbox'], variable: k, value: 'true' },
          {
            actionType: 'click',
            selectors: ['role=button'],
            http: {
              method: 'GET',
              url: `https://shop.example.com/items/{{${p}}}`,
              query: {},
              bindings: [{ variable: p, in: 'path', name: '2' }],
              redacted: [],
            },
          },
        ],
        variables: [
          { name: a, type: 'string' },
          { name: e, type: 'string', enum: ['x', 'y'] },
          { name: k, type: 'boolean' },
          { name: p, type: 'string' },
        ],
        observedPayloads: [{ [a]: 'abc' }],
      },
    ],
  };
  return { set, id, a, e, k, p };
}

type Case = { name: string; status: 400 | 404; build: (b: ReturnType<typeof baseSet>) => unknown };
const long = (n: number): string => 'x'.repeat(n);
const CASES: Case[] = [
  { name: 'unexpected field', status: 400, build: (b) => ({ id: b.id, label: 'ok', other: 1 }) },
  { name: 'id missing', status: 400, build: () => ({ label: 'ok' }) },
  { name: 'id not a string', status: 400, build: () => ({ id: 5, label: 'ok' }) },
  { name: 'only id', status: 400, build: (b) => ({ id: b.id }) },
  { name: 'unknown id', status: 404, build: () => ({ id: 'no-such-id', label: 'ok' }) },
  { name: 'empty label', status: 400, build: (b) => ({ id: b.id, label: '   ' }) },
  { name: 'label too long', status: 400, build: (b) => ({ id: b.id, label: long(201) }) },
  { name: 'label with control character', status: 400, build: (b) => ({ id: b.id, label: 'a\nb' }) },
  { name: 'label not a string', status: 400, build: (b) => ({ id: b.id, label: 3 }) },
  { name: 'description with markup', status: 400, build: (b) => ({ id: b.id, description: 'use <b>this</b>' }) },
  { name: 'description with a link', status: 400, build: (b) => ({ id: b.id, description: 'see https://evil.example.com now' }) },
  { name: 'description not a string', status: 400, build: (b) => ({ id: b.id, description: null }) },
  { name: 'variables empty', status: 400, build: (b) => ({ id: b.id, variables: [] }) },
  { name: 'variables not an array', status: 400, build: (b) => ({ id: b.id, variables: {} }) },
  { name: 'more than 100 variables', status: 400, build: (b) => ({ id: b.id, variables: Array.from({ length: 101 }, () => ({ name: b.a })) }) },
  { name: 'unknown key in a variable', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, enum: ['x'] }] }) },
  { name: 'wrong JSON type', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, optional: 'yes' }] }) },
  { name: 'unknown variable', status: 400, build: (b) => ({ id: b.id, variables: [{ name: `${b.a}_missing`, optional: true }] }) },
  { name: 'same variable twice', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, optional: true }, { name: b.a, optional: false }] }) },
  { name: 'newName starts with a digit', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, newName: '1abc' }] }) },
  { name: 'newName with a dash', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, newName: 'a-b' }] }) },
  { name: 'newName empty', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, newName: '' }] }) },
  { name: 'newName longer than 60', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, newName: `n${long(60)}` }] }) },
  { name: 'newName equals another variable', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, newName: b.e }] }) },
  {
    name: 'swap of two names',
    status: 400,
    build: (b) => ({ id: b.id, variables: [{ name: b.a, newName: b.e }, { name: b.e, newName: b.a }] }),
  },
  {
    name: 'two objects with the same newName',
    status: 400,
    build: (b) => ({ id: b.id, variables: [{ name: b.a, newName: 'fresh_name' }, { name: b.e, newName: 'fresh_name' }] }),
  },
  { name: 'type not allowed', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, type: 'text' }] }) },
  { name: 'type of a fixed list is not text', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.e, type: 'number' }] }) },
  { name: 'type of a check is not true or false', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.k, type: 'string' }] }) },
  { name: 'whenOmitted not allowed', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, optional: true, whenOmitted: 'ignore' }] }) },
  { name: 'whenOmitted with optional false', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, optional: false, whenOmitted: 'skip' }] }) },
  { name: 'whenOmitted on a required variable', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, whenOmitted: 'skip' }] }) },
  { name: 'variable description with markup', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, description: '<script>x</script>' }] }) },
  { name: 'payload that cannot be coerced', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.a, type: 'number' }] }) },
  { name: 'skip on a variable bound in a URL path (14.15, 3.7)', status: 400, build: (b) => ({ id: b.id, variables: [{ name: b.p, optional: true, whenOmitted: 'skip' }] }) },
  {
    name: 'a valid object followed by an invalid one',
    status: 400,
    build: (b) => ({ id: b.id, label: 'Fine', variables: [{ name: b.a, newName: 'good_name' }, { name: b.e, newName: '9bad' }] }),
  },
];

describe('Property 23: An invalid update changes nothing', () => {
  it('refuses every invalid request with its status and leaves the set as it was', () => {
    fc.assert(
      fc.property(variableNamesArb(4, 4), fc.constantFrom(...CASES), (names, c) => {
        fc.pre(!names.includes('fresh_name'));
        const base = baseSet(names);
        const before = structuredClone(base.set);
        const result = applyUpdate(base.set, c.build(base));
        expect(result.ok, c.name).toBe(false);
        if (result.ok) return;
        expect(result.status, c.name).toBe(c.status);
        expect(result.error.length).toBeGreaterThan(0);
        // No typed value is echoed except a Variable name
        expect(JSON.stringify(result)).not.toContain('evil.example.com');
        expect(base.set).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });
});
