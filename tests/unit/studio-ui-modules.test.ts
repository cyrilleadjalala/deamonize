import { describe, it, expect } from 'vitest';
// The UI modules are plain browser JavaScript; the pure ones run in Node too
// @ts-expect-error no type declarations for the browser modules
import { layoutGraph, pathForWorkflow } from '../../src/studio/ui/js/layout.js';
// @ts-expect-error no type declarations for the browser modules
import { flattenSchema } from '../../src/studio/ui/js/schema-table.js';

const ids = (xs: Array<{ id: string }>): string[] => xs.map((x) => x.id);

describe('Studio UI graph layout', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const edges = [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'a', to: 'c' },
    { id: 'e3', from: 'b', to: 'd' },
    { id: 'e4', from: 'c', to: 'd' },
    { id: 'e5', from: 'd', to: 'a' }, // a cycle
    { id: 'e6', from: 'b', to: 'b' }, // a self loop
  ];

  it('is deterministic and puts successors in later layers, also with cycles and self loops', () => {
    const one = layoutGraph(nodes, edges);
    const two = layoutGraph(nodes, edges);
    expect(two).toEqual(one);
    const layer = Object.fromEntries(one.nodes.map((n: { id: string; layer: number }) => [n.id, n.layer]));
    expect(layer).toEqual({ a: 0, b: 1, c: 1, d: 2 });
    expect(ids(one.edges)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
    expect(one.edges.find((e: { id: string }) => e.id === 'e5').kind).toBe('back');
    expect(one.edges.find((e: { id: string }) => e.id === 'e6').kind).toBe('self');
    for (const e of one.edges) expect(e.d).toMatch(/^M [\d.-]+ [\d.-]+ C/);
  });

  it('never overlaps two nodes of a layer', () => {
    const l = layoutGraph(nodes, edges);
    const sameLayer = l.nodes.filter((n: { layer: number }) => n.layer === 1);
    expect(new Set(sameLayer.map((n: { y: number }) => n.y)).size).toBe(sameLayer.length);
  });

  it('handles an empty graph and edges to unknown nodes', () => {
    expect(layoutGraph([], []).nodes).toEqual([]);
    expect(layoutGraph([{ id: 'x' }], [{ id: 'bad', from: 'x', to: 'nope' }]).edges).toEqual([]);
  });

  it('finds the path to a final screen in a state graph and the tagged edges in a derived graph', () => {
    const state = { source: 'state-graph', nodes, edges: edges.slice(0, 4) };
    const p = pathForWorkflow(state, { id: 'w', finalScreenId: 'd' });
    expect(p.found).toBe(true);
    expect(p.nodeIds[0]).toBe('a');
    expect(p.nodeIds.at(-1)).toBe('d');
    expect(p.edgeIds).toHaveLength(p.nodeIds.length - 1);
    expect(pathForWorkflow(state, { id: 'w', finalScreenId: 'zzz' }).found).toBe(false);
    const derived = { source: 'workflows', nodes, edges: [{ id: 'x1', from: 'a', to: 'b', workflowId: 'w' }, { id: 'x2', from: 'b', to: 'c', workflowId: 'other' }] };
    expect(pathForWorkflow(derived, { id: 'w' })).toEqual({ nodeIds: ['a', 'b'], edgeIds: ['x1'], found: true });
  });
});

describe('Studio UI schema table', () => {
  it('flattens properties with required, format and constraints, and nested arrays of objects', () => {
    const rows = flattenSchema({
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', format: 'email', description: 'Where to write' },
        age: { type: 'integer', minimum: 0, maximum: 150 },
        kind: { enum: ['a', 'b'] },
        items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } },
      },
    });
    const byPath = Object.fromEntries(rows.map((r: { path: string }) => [r.path, r]));
    expect(byPath.email).toMatchObject({ type: 'string', required: true, format: 'email', description: 'Where to write' });
    expect(byPath.age).toMatchObject({ required: false, constraints: ['min 0', 'max 150'] });
    expect(byPath.kind.constraints[0]).toContain('one of');
    expect(byPath['items[].sku']).toMatchObject({ type: 'string' });
  });

  it('returns no rows for an empty object schema', () => {
    expect(flattenSchema({ type: 'object' })).toEqual([]);
    expect(flattenSchema(undefined)).toEqual([]);
  });
});
