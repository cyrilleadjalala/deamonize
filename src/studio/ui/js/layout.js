// @ts-check
/**
 * A small deterministic layered graph layout (left to right). No dependency, no randomness: the same graph always
 * gives the same picture.
 *
 *   1. Cycles are cut: a DFS from the sources marks back edges, which do not take part in layering.
 *   2. Each node goes to the layer after its deepest predecessor (longest path).
 *   3. Nodes inside a layer are ordered by the barycenter of their neighbours, a few sweeps down and up.
 *   4. Nodes get a grid position; edges get a cubic path (forward edges side to side, back and same-layer edges
 *      loop under the nodes, self loops loop on the right).
 */

/**
 * @typedef {{ id: string }} LayoutNode
 * @typedef {{ id: string, from: string, to: string }} LayoutEdge
 * @typedef {{ id: string, x: number, y: number, w: number, h: number, layer: number, order: number }} PlacedNode
 * @typedef {{ id: string, from: string, to: string, d: string, labelX: number, labelY: number, kind: 'forward' | 'back' | 'self' }} PlacedEdge
 * @typedef {{ nodes: PlacedNode[], edges: PlacedEdge[], width: number, height: number }} Layout
 */

export const DEFAULTS = { nodeW: 184, nodeH: 52, gapX: 96, gapY: 30, margin: 40 };

/**
 * @param {LayoutNode[]} nodes
 * @param {LayoutEdge[]} edges
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {Layout}
 */
export function layoutGraph(nodes, edges, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const usable = edges.filter((e) => index.has(e.from) && index.has(e.to));

  // Adjacency without self loops and duplicates, in a stable order
  /** @type {number[][]} */
  const out = nodes.map(() => []);
  /** @type {number[][]} */
  const inc = nodes.map(() => []);
  const seenPair = new Set();
  for (const e of usable) {
    const a = /** @type {number} */ (index.get(e.from));
    const b = /** @type {number} */ (index.get(e.to));
    const key = `${a}>${b}`;
    if (a === b || seenPair.has(key)) continue;
    seenPair.add(key);
    out[a].push(b);
    inc[b].push(a);
  }

  // 1. Cut cycles: iterative DFS, sources first
  const state = new Array(nodes.length).fill(0); // 0 new, 1 on stack, 2 done
  const back = new Set();
  const roots = nodes.map((_, i) => i).sort((a, b) => inc[a].length - inc[b].length || a - b);
  for (const root of roots) {
    if (state[root] !== 0) continue;
    const stack = [[root, 0]];
    state[root] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const [node, at] = top;
      if (at < out[node].length) {
        top[1] += 1;
        const next = out[node][at];
        if (state[next] === 0) {
          state[next] = 1;
          stack.push([next, 0]);
        } else if (state[next] === 1) back.add(`${node}>${next}`);
      } else {
        state[node] = 2;
        stack.pop();
      }
    }
  }
  /** @type {number[][]} */
  const dagOut = nodes.map(() => []);
  /** @type {number[][]} */
  const dagIn = nodes.map(() => []);
  for (let a = 0; a < nodes.length; a++) {
    for (const b of out[a]) {
      if (back.has(`${a}>${b}`)) continue;
      dagOut[a].push(b);
      dagIn[b].push(a);
    }
  }

  // 2. Longest-path layers (Kahn)
  const layer = new Array(nodes.length).fill(0);
  const pending = dagIn.map((l) => l.length);
  const queue = nodes.map((_, i) => i).filter((i) => pending[i] === 0);
  for (let head = 0; head < queue.length; head++) {
    const n = queue[head];
    for (const m of dagOut[n]) {
      layer[m] = Math.max(layer[m], layer[n] + 1);
      pending[m] -= 1;
      if (pending[m] === 0) queue.push(m);
    }
  }
  const layerCount = nodes.length === 0 ? 0 : Math.max(...layer) + 1;

  // 3. Order inside layers
  /** @type {number[][]} */
  const layers = Array.from({ length: layerCount }, () => []);
  nodes.forEach((_, i) => layers[layer[i]].push(i));
  const position = new Array(nodes.length).fill(0);
  const renumber = () => layers.forEach((l) => l.forEach((n, i) => (position[n] = i)));
  renumber();
  const bary = (n, neighbours) => (neighbours.length === 0 ? position[n] : neighbours.reduce((sum, m) => sum + position[m], 0) / neighbours.length);
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).slice(0, -1).reverse();
    for (const li of order) {
      const keyed = layers[li].map((n) => ({ n, k: bary(n, down ? dagIn[n] : dagOut[n]) }));
      keyed.sort((a, b) => a.k - b.k || a.n - b.n);
      layers[li] = keyed.map((x) => x.n);
      layers[li].forEach((n, i) => (position[n] = i));
    }
  }

  // 4. Coordinates: layers are columns, each column centred on the tallest one
  const tallest = layers.reduce((m, l) => Math.max(m, l.length), 0);
  const columnHeight = tallest * o.nodeH + Math.max(0, tallest - 1) * o.gapY;
  /** @type {PlacedNode[]} */
  const placed = new Array(nodes.length);
  layers.forEach((members, li) => {
    const height = members.length * o.nodeH + Math.max(0, members.length - 1) * o.gapY;
    const top = o.margin + (columnHeight - height) / 2;
    members.forEach((n, i) => {
      placed[n] = {
        id: nodes[n].id,
        x: o.margin + li * (o.nodeW + o.gapX),
        y: top + i * (o.nodeH + o.gapY),
        w: o.nodeW,
        h: o.nodeH,
        layer: li,
        order: i,
      };
    });
  });

  // Parallel edges between the same pair are fanned out
  const pairCount = new Map();
  /** @type {PlacedEdge[]} */
  const placedEdges = [];
  for (const e of usable) {
    const a = /** @type {number} */ (index.get(e.from));
    const b = /** @type {number} */ (index.get(e.to));
    const pair = `${a}>${b}`;
    const nth = pairCount.get(pair) ?? 0;
    pairCount.set(pair, nth + 1);
    const s = placed[a];
    const t = placed[b];
    const fan = nth * 16;
    if (a === b) {
      const x = s.x + s.w;
      const y = s.y + s.h / 2;
      const r = 46 + nth * 12;
      placedEdges.push({
        id: e.id, from: e.from, to: e.to, kind: 'self',
        d: `M ${x} ${y - 10} C ${x + r} ${y - 34 - nth * 8}, ${x + r} ${y + 34 + nth * 8}, ${x} ${y + 10}`,
        labelX: x + r * 0.78 + 4, labelY: y,
      });
    } else if (!back.has(pair) && t.layer > s.layer) {
      const x1 = s.x + s.w;
      const y1 = s.y + s.h / 2 + (nth === 0 ? 0 : fan - 8);
      const x2 = t.x;
      const y2 = t.y + t.h / 2 + (nth === 0 ? 0 : fan - 8);
      const dx = Math.max(32, (x2 - x1) / 2);
      placedEdges.push({
        id: e.id, from: e.from, to: e.to, kind: 'forward',
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 - 7,
      });
    } else {
      // Back edge or same layer: leave from the bottom of the source, come in at the bottom of the target
      const x1 = s.x + s.w / 2 + fan;
      const y1 = s.y + s.h;
      const x2 = t.x + t.w / 2 + fan;
      const y2 = t.y + t.h;
      const drop = 54 + fan + Math.abs(t.layer - s.layer) * 6;
      const bottom = Math.max(y1, y2) + drop;
      placedEdges.push({
        id: e.id, from: e.from, to: e.to, kind: 'back',
        d: `M ${x1} ${y1} C ${x1} ${bottom}, ${x2} ${bottom}, ${x2} ${y2}`,
        labelX: (x1 + x2) / 2, labelY: Math.max(y1, y2) + drop * 0.75 + 4,
      });
    }
  }

  const width = o.margin * 2 + Math.max(0, layerCount) * o.nodeW + Math.max(0, layerCount - 1) * o.gapX + 80;
  const height = o.margin * 2 + columnHeight + 70;
  return { nodes: placed, edges: placedEdges, width, height };
}

/**
 * The nodes and edges a workflow walks, for highlighting.
 * - A graph derived from the workflows (`source: 'workflows'`): the edges tagged with the workflow.
 * - A State_Graph: the shortest path from a screen nobody leads to, up to the workflow's final screen.
 * @param {{ source: string, nodes: any[], edges: any[] }} graph
 * @param {{ id: string, finalScreenId?: string }} workflow
 * @returns {{ nodeIds: string[], edgeIds: string[], found: boolean }}
 */
export function pathForWorkflow(graph, workflow) {
  if (graph.source === 'workflows') {
    const edges = graph.edges.filter((e) => e.workflowId === workflow.id);
    const ids = [];
    for (const e of edges) for (const id of [e.from, e.to]) if (!ids.includes(id)) ids.push(id);
    return { nodeIds: ids, edgeIds: edges.map((e) => e.id), found: edges.length > 0 };
  }
  const target = workflow.finalScreenId;
  if (target === undefined || !graph.nodes.some((n) => n.id === target)) return { nodeIds: [], edgeIds: [], found: false };
  const hasIncoming = new Set(graph.edges.filter((e) => e.from !== e.to).map((e) => e.to));
  let sources = graph.nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
  if (sources.length === 0) sources = graph.nodes.map((n) => n.id);
  /** @type {Map<string, { prev: string | null, edge: string | null }>} */
  const seen = new Map(sources.map((id) => [id, { prev: null, edge: null }]));
  const queue = [...sources];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (cur === target) break;
    for (const e of graph.edges) {
      if (e.from !== cur || seen.has(e.to)) continue;
      seen.set(e.to, { prev: cur, edge: e.id });
      queue.push(e.to);
    }
  }
  if (!seen.has(target)) return { nodeIds: [target], edgeIds: [], found: true };
  const nodeIds = [];
  const edgeIds = [];
  for (let at = target; at !== null;) {
    const step = /** @type {{ prev: string | null, edge: string | null }} */ (seen.get(at));
    nodeIds.unshift(at);
    if (step.edge !== null) edgeIds.unshift(step.edge);
    at = step.prev;
  }
  return { nodeIds, edgeIds, found: true };
}
