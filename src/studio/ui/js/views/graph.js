// @ts-check
import { h, s, clip } from '../dom.js';
import { api } from '../api.js';
import { announce, chip, copyButton, emptyState } from '../components.js';
import { layoutGraph, pathForWorkflow } from '../layout.js';
import { href } from '../router.js';

/** Above this many screens the picture is not drawn: a list is more useful than a hairball. */
export const MAX_DRAWN_NODES = 200;
const MIN_SCALE = 0.12;
const MAX_SCALE = 6;

const KIND_LABEL = { start: 'Start', step: 'Step', final: 'Final screen', screen: 'Screen' };

/** @param {any} graph @param {any[]} workflows */
function drawnGraph(graph, workflows) {
  const layout = layoutGraph(graph.nodes, graph.edges);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const placedById = new Map(layout.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  /** @type {{ x: number, y: number, w: number, h: number }} */
  let vb = { x: 0, y: 0, w: layout.width, h: layout.height };
  /** @type {string | undefined} */
  let selected;
  /** @type {{ nodeIds: string[], edgeIds: string[], found: boolean } | null} */
  let path = null;

  // --- SVG -----------------------------------------------------------------
  const svg = s('svg', { class: 'graph-svg', viewBox: `0 0 ${layout.width} ${layout.height}`, role: 'group', 'aria-label': `Graph of ${graph.nodes.length} screens and ${graph.edges.length} transitions` },
    s('defs', null,
      s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' }, s('path', { class: 'arrow', d: 'M0 0 L10 5 L0 10 z' })),
      s('marker', { id: 'arrow-hot', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' }, s('path', { class: 'arrow hot', d: 'M0 0 L10 5 L0 10 z' }))));
  const edgeLayer = s('g', { class: 'edges' });
  const nodeLayer = s('g', { class: 'nodes' });
  svg.append(edgeLayer, nodeLayer);

  /** @type {Map<string, SVGElement>} */
  const edgeEls = new Map();
  /** @type {Map<string, SVGElement>} */
  const nodeEls = new Map();

  for (const pe of layout.edges) {
    const raw = edgeById.get(pe.id);
    const label = raw?.label ?? '';
    const g = s('g', { class: `edge ${pe.kind}`, dataset: { edge: pe.id, from: pe.from, to: pe.to } },
      s('path', { class: 'edge-line', d: pe.d, 'marker-end': 'url(#arrow)' }),
      label ? s('text', { class: 'edge-label', x: pe.labelX, y: pe.labelY, 'text-anchor': 'middle' }, clip(label, 22)) : null);
    edgeEls.set(pe.id, g);
    edgeLayer.appendChild(g);
  }

  const ordered = [...layout.nodes].sort((a, b) => a.layer - b.layer || a.order - b.order);
  for (const pn of ordered) {
    const n = nodeById.get(pn.id);
    const kind = n.kind ?? 'screen';
    const meta = [n.type, n.observations === undefined ? undefined : `${n.observations} seen`].filter(Boolean).join(' \u00B7 ') || KIND_LABEL[kind];
    const g = s('g', {
      class: `node kind-${kind}`,
      tabindex: '0',
      role: 'button',
      'aria-pressed': 'false',
      'aria-label': `${KIND_LABEL[kind] ?? 'Screen'}: ${n.label}. ${meta}.`,
      transform: `translate(${pn.x} ${pn.y})`,
      dataset: { node: pn.id, layer: pn.layer },
    },
      s('title', null, n.label),
      s('rect', { class: 'node-box', width: pn.w, height: pn.h, rx: 11 }),
      s('text', { class: 'node-label', x: 14, y: 22 }, clip(n.label, 24)),
      s('text', { class: 'node-meta', x: 14, y: 40 }, clip(meta, 28)),
      s('g', { class: 'path-badge', transform: `translate(${pn.w - 4} -4)`, 'aria-hidden': 'true' }, s('circle', { r: 11 }), s('text', { class: 'path-index', 'text-anchor': 'middle', y: 4 }, '')));
    nodeEls.set(pn.id, g);
    nodeLayer.appendChild(g);
  }

  // --- view box: pan and zoom --------------------------------------------------
  const apply = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const fit = () => {
    vb = { x: 0, y: 0, w: layout.width, h: layout.height };
    apply();
  };
  /** Pixel to view-box scale and offset, honouring the letterboxing of preserveAspectRatio="meet". */
  const metrics = () => {
    const r = svg.getBoundingClientRect();
    const scale = Math.max(vb.w / Math.max(1, r.width), vb.h / Math.max(1, r.height));
    return { r, scale, offX: (r.width - vb.w / scale) / 2, offY: (r.height - vb.h / scale) / 2 };
  };
  const toVb = (clientX, clientY) => {
    const m = metrics();
    return { x: vb.x + (clientX - m.r.left - m.offX) * m.scale, y: vb.y + (clientY - m.r.top - m.offY) * m.scale };
  };
  const zoom = (factor, cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2) => {
    const current = layout.width / vb.w;
    const real = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor)) / current;
    vb = { x: cx - (cx - vb.x) / real, y: cy - (cy - vb.y) / real, w: vb.w / real, h: vb.h / real };
    apply();
  };
  const pan = (dx, dy) => {
    vb = { ...vb, x: vb.x + dx, y: vb.y + dy };
    apply();
  };
  const centreOn = (id) => {
    const p = placedById.get(id);
    if (!p) return;
    const inside = p.x >= vb.x && p.y >= vb.y && p.x + p.w <= vb.x + vb.w && p.y + p.h <= vb.y + vb.h;
    if (!inside) pan(p.x + p.w / 2 - (vb.x + vb.w / 2), p.y + p.h / 2 - (vb.y + vb.h / 2));
  };

  const canvas = h('div', {
    class: 'graph-canvas',
    tabindex: '0',
    role: 'group',
    'aria-label': 'Graph canvas. Arrow keys pan, plus and minus zoom, zero fits the graph. Tab moves between screens.',
  }, svg);

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = toVb(ev.clientX, ev.clientY);
    zoom(ev.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
  }, { passive: false });

  let drag = null;
  let moved = false;
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY };
    moved = false;
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (drag === null) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) canvas.setPointerCapture(ev.pointerId);
    moved = true;
    canvas.classList.add('panning');
    const { scale } = metrics();
    pan(-dx * scale, -dy * scale);
    drag = { x: ev.clientX, y: ev.clientY };
  });
  const endDrag = () => {
    drag = null;
    canvas.classList.remove('panning');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  // A drag must not count as a click on a node
  canvas.addEventListener('click', (ev) => {
    if (moved) {
      ev.stopPropagation();
      moved = false;
    }
  }, true);

  canvas.addEventListener('keydown', (ev) => {
    if (ev.target !== canvas) return;
    const step = 0.1;
    switch (ev.key) {
      case 'ArrowLeft': pan(-vb.w * step, 0); break;
      case 'ArrowRight': pan(vb.w * step, 0); break;
      case 'ArrowUp': pan(0, -vb.h * step); break;
      case 'ArrowDown': pan(0, vb.h * step); break;
      case '+': case '=': zoom(1.25); break;
      case '-': case '_': zoom(1 / 1.25); break;
      case '0': fit(); break;
      default: return;
    }
    ev.preventDefault();
  });

  // --- selection, highlight and the focus panel -----------------------------------------
  const panelBody = h('div', { class: 'focus-body' });
  const panelEl = h('aside', { class: 'focus-panel', 'aria-label': 'Selected screen', 'aria-live': 'polite' }, h('h3', { class: 'panel-title', text: 'Screen details' }), panelBody);

  const nodeButton = (id) => {
    const n = nodeById.get(id);
    return h('button', { type: 'button', class: 'link-btn', onclick: () => select(id, true), text: n?.label ?? id });
  };

  const renderPanel = () => {
    panelBody.replaceChildren();
    const n = selected === undefined ? undefined : nodeById.get(selected);
    if (n === undefined) {
      panelBody.append(h('p', { class: 'muted', text: 'Select a screen (click it, or focus it and press Enter) to see where it leads and which workflows end there.' }));
      return;
    }
    const outgoing = graph.edges.filter((e) => e.from === n.id);
    const incoming = graph.edges.filter((e) => e.to === n.id);
    const finals = workflows.filter((w) => w.finalScreenId === n.id || (n.workflowId && w.id === n.workflowId));
    const transition = (e, other) =>
      h('li', null, e.label ? h('span', { class: 'edge-chip', text: e.label }) : null, h('span', { class: 'muted', 'aria-hidden': 'true', text: ' \u2192 ' }), nodeButton(other));
    panelBody.append(
      h('h4', { class: 'focus-name', text: n.label }),
      h('p', { class: 'chips' }, chip(KIND_LABEL[n.kind] ?? 'Screen', 'role'), n.type ? chip(n.type, 'plain') : null, n.observations !== undefined ? chip(`${n.observations} observations`, 'plain') : null),
      h('p', { class: 'id-line' }, h('code', { text: n.id }), copyButton(n.id, `Copy screen id ${n.id}`)),
      h('h5', { class: 'mini-title', text: `Leads to (${outgoing.length})` }),
      outgoing.length ? h('ul', { class: 'plain-list' }, ...outgoing.map((e) => transition(e, e.to))) : h('p', { class: 'muted', text: 'Nothing: a dead end or a final screen.' }),
      h('h5', { class: 'mini-title', text: `Reached from (${incoming.length})` }),
      incoming.length ? h('ul', { class: 'plain-list' }, ...incoming.map((e) => transition(e, e.from))) : h('p', { class: 'muted', text: 'Nothing: an entry point.' }),
      finals.length
        ? h('div', null, h('h5', { class: 'mini-title', text: 'Workflows ending here' }),
            h('ul', { class: 'plain-list' }, ...finals.map((w) => h('li', null, h('a', { href: href('workflows', w.id), text: w.label })))))
        : null
    );
  };

  const paint = () => {
    const hot = new Set(path?.nodeIds ?? []);
    const hotEdges = new Set(path?.edgeIds ?? []);
    const active = path !== null && path.found;
    svg.classList.toggle('has-path', active);
    for (const [id, el] of nodeEls) {
      const index = (path?.nodeIds ?? []).indexOf(id);
      el.classList.toggle('on-path', hot.has(id));
      el.classList.toggle('selected', id === selected);
      el.setAttribute('aria-pressed', String(id === selected));
      const idx = el.querySelector('.path-index');
      if (idx) idx.textContent = index >= 0 ? String(index + 1) : '';
    }
    for (const [id, el] of edgeEls) {
      el.classList.toggle('on-path', hotEdges.has(id));
      el.querySelector('.edge-line')?.setAttribute('marker-end', hotEdges.has(id) ? 'url(#arrow-hot)' : 'url(#arrow)');
    }
  };

  /** @param {string | undefined} id @param {boolean} [focus] */
  function select(id, focus = false) {
    selected = id;
    paint();
    renderPanel();
    if (id !== undefined && focus) {
      const el = nodeEls.get(id);
      centreOn(id);
      /** @type {any} */ (el)?.focus?.({ preventScroll: true });
    }
  }

  for (const [id, el] of nodeEls) {
    el.addEventListener('click', () => select(id));
    el.addEventListener('keydown', (ev) => {
      const k = /** @type {KeyboardEvent} */ (ev).key;
      if (k === 'Enter' || k === ' ') {
        ev.preventDefault();
        select(id);
      }
    });
    el.addEventListener('focus', () => centreOn(id));
  }

  /** @param {string | undefined} workflowId @returns {string} message */
  function highlight(workflowId) {
    const wf = workflows.find((w) => w.id === workflowId);
    if (wf === undefined) {
      path = null;
      paint();
      return 'Showing the whole graph.';
    }
    path = pathForWorkflow(graph, wf);
    paint();
    if (!path.found) return `The final screen of \u201C${wf.label}\u201D is not part of this graph, so there is no path to show.`;
    return `Highlighting \u201C${wf.label}\u201D: ${path.nodeIds.length} screen${path.nodeIds.length === 1 ? '' : 's'}, ${path.edgeIds.length} transition${path.edgeIds.length === 1 ? '' : 's'}.`;
  }

  const buttons = h('div', { class: 'toolbar-group', role: 'group', 'aria-label': 'Zoom' },
    h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Zoom out', onclick: () => zoom(1 / 1.25), text: '\u2212' }),
    h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Zoom in', onclick: () => zoom(1.25), text: '+' }),
    h('button', { type: 'button', class: 'btn btn-small', onclick: fit, text: 'Fit' }));

  renderPanel();
  return { canvas, panelEl, buttons, highlight, select, fit, nodeCount: ordered.length };
}

/** @param {any} graph */
function listView(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const rows = graph.nodes.map((n) => {
    const leads = graph.edges.filter((e) => e.from === n.id).map((e) => `${e.label ? `${e.label} \u2192 ` : ''}${byId.get(e.to)?.label ?? e.to}`);
    return h('tr', { dataset: { node: n.id } },
      h('th', { scope: 'row', text: n.label }),
      h('td', { text: n.type ?? KIND_LABEL[n.kind] ?? 'Screen' }),
      h('td', { text: n.observations === undefined ? '\u2013' : String(n.observations) }),
      h('td', { text: leads.length ? leads.join('; ') : '\u2013' }));
  });
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'table', 'aria-label': 'Screens and transitions' },
      h('thead', null, h('tr', null, ...['Screen', 'Type', 'Seen', 'Leads to'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', null, ...rows)));
}

/** @param {{ query: URLSearchParams }} route */
export async function renderGraph(route) {
  const [graph, wfData] = await Promise.all([api.graph(), api.workflows()]);
  const workflows = wfData.workflows ?? [];
  const root = h('div', { class: 'view view-graph' });
  root.appendChild(h('h1', { class: 'view-title', tabindex: '-1', text: 'Graph' }));
  root.appendChild(h('p', { class: 'view-lead', text: graph.source === 'state-graph'
    ? 'Screens the recorder saw, and the actions that move between them.'
    : 'No State_Graph file was found, so this graph is derived from the steps of each workflow.' }));
  if (graph.nodes.length === 0) {
    root.appendChild(emptyState('Nothing to draw yet', 'Record a workflow to see its screens here.'));
    return root;
  }
  if (graph.truncated) root.appendChild(h('p', { class: 'notice', role: 'note', text: 'This graph is large: only the first screens and transitions are shown.' }));

  const tooBig = graph.nodes.length > MAX_DRAWN_NODES;
  const status = h('p', { class: 'muted graph-status', role: 'status', text: '' });
  const select = h('select', { id: 'graph-wf', class: 'input' }, h('option', { value: '', text: 'None: whole graph' }),
    ...workflows.map((w) => h('option', { value: w.id, text: w.toolName ? `${w.label} (${w.toolName})` : w.label })));
  const stage = h('div', { class: 'graph-stage' });
  const toolbar = h('div', { class: 'graph-toolbar' }, h('label', { class: 'field-label inline', for: 'graph-wf', text: 'Highlight workflow' }), select);
  root.append(toolbar, status, stage);

  const drawn = tooBig ? null : drawnGraph(graph, workflows);
  const list = listView(graph);
  let mode = tooBig ? 'list' : 'graph';

  const toggle = h('div', { class: 'toolbar-group', role: 'group', 'aria-label': 'View' });
  const showMode = (next) => {
    mode = next;
    stage.replaceChildren();
    if (mode === 'graph' && drawn !== null) {
      stage.append(h('div', { class: 'graph-wrap' }, drawn.canvas, drawn.panelEl));
      stage.append(h('ul', { class: 'graph-legend' },
        h('li', null, h('span', { class: 'sw node-sw', 'aria-hidden': 'true' }), 'Screen'),
        h('li', null, h('span', { class: 'sw edge-sw', 'aria-hidden': 'true' }), 'Action'),
        h('li', null, h('span', { class: 'sw hot-sw', 'aria-hidden': 'true' }), 'Path of the selected workflow'),
        h('li', { class: 'muted', text: 'Drag or use arrow keys to pan. Wheel, + and \u2212 to zoom.' })));
    } else stage.append(list);
    for (const b of toggle.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode));
  };
  const modeBtn = (id, label, disabled) => h('button', { type: 'button', class: 'btn btn-small', 'data-mode': id, 'aria-pressed': 'false', disabled, onclick: () => showMode(id), text: label });
  toggle.append(modeBtn('graph', 'Graph', tooBig), modeBtn('list', 'List', false));
  toolbar.append(toggle);
  if (drawn !== null) toolbar.append(drawn.buttons);
  if (tooBig) status.textContent = `${graph.nodes.length} screens is too many to draw legibly (limit ${MAX_DRAWN_NODES}). Showing the list view.`;
  showMode(mode);

  const apply = () => {
    const id = /** @type {HTMLSelectElement} */ (select).value || undefined;
    if (drawn === null) {
      status.textContent = `${tooBig ? status.textContent : ''}`;
      return;
    }
    const message = drawn.highlight(id);
    status.textContent = message;
    announce(message);
  };
  select.addEventListener('change', () => {
    const id = /** @type {HTMLSelectElement} */ (select).value;
    // Keep the address in step so the view can be shared
    const q = id ? `?wf=${encodeURIComponent(id)}` : '';
    history.replaceState(null, '', `#/graph${q}`);
    apply();
  });
  const wanted = route.query.get('wf');
  if (wanted && workflows.some((w) => w.id === wanted)) /** @type {HTMLSelectElement} */ (select).value = wanted;
  if (drawn !== null) apply();
  else if (!tooBig) status.textContent = '';
  return root;
}
