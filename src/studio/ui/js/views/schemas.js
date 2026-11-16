// @ts-check
import { h } from '../dom.js';
import { api } from '../api.js';
import { chip, copyButton, emptyState, panel, toolName } from '../components.js';
import { flattenSchema } from '../schema-table.js';
import { href } from '../router.js';

/** @param {any} schema @param {string} caption */
function propertyTable(schema, caption) {
  const rows = flattenSchema(schema);
  if (rows.length === 0) {
    const t = schema && typeof schema === 'object' && schema.type ? String(schema.type) : 'object';
    return h('p', { class: 'muted', text: `No properties: an empty ${t}.` });
  }
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'table schema-table', dataset: { rows: rows.length } },
      h('caption', { class: 'sr-only', text: caption }),
      h('thead', null, h('tr', null, ...['Property', 'Type', 'Required', 'Format', 'Constraints', 'Description'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', null,
        ...rows.map((r) =>
          h('tr', { dataset: { required: r.depth === 1 ? String(r.required) : undefined } },
            h('th', { scope: 'row', class: 'prop-name' }, h('code', { text: r.path })),
            h('td', null, h('code', { text: r.type })),
            h('td', null, r.depth === 1 ? chip(r.required ? 'required' : 'optional', r.required ? 'required' : 'optional') : h('span', { class: 'muted', text: '\u2013' })),
            h('td', { text: r.format || '\u2013' }),
            h('td', { text: r.constraints.length ? r.constraints.join('; ') : '\u2013' }),
            h('td', { text: r.description || '\u2013' }))))));
}

/** One schema with its table / raw switch and a copy button. @param {string} id @param {string} title @param {any} schema */
function schemaBlock(id, title, schema) {
  const raw = JSON.stringify(schema ?? {}, null, 2);
  const body = h('div', { class: 'schema-body' }, propertyTable(schema, title));
  let showRaw = false;
  const toggle = h('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': 'false', text: 'Raw JSON' });
  const render = () => {
    toggle.setAttribute('aria-pressed', String(showRaw));
    body.replaceChildren(showRaw ? h('pre', { class: 'code-block', tabindex: '0', 'aria-label': `${title} as JSON` }, h('code', { text: raw })) : propertyTable(schema, title));
  };
  toggle.addEventListener('click', () => {
    showRaw = !showRaw;
    render();
  });
  return h('section', { class: 'panel schema-block', 'aria-labelledby': id, dataset: { schema: title.toLowerCase() } },
    h('div', { class: 'panel-head' },
      h('h3', { class: 'panel-title', id, text: title }),
      h('div', { class: 'toolbar-group' }, toggle, copyButton(raw, `Copy ${title.toLowerCase()} as JSON`, { text: 'Copy JSON' }))),
    body);
}

/** @param {any} view */
function openapiSection(view) {
  if (!view.openapi || view.openapi.length === 0) {
    return panel('p-openapi', 'OpenAPI', h('p', { class: 'muted', text: 'No openapi.json next to the compiled output. Run daemonize compile to produce it.' }));
  }
  return h('div', null, ...view.openapi.map((doc, i) =>
    h('section', { class: 'panel', 'aria-labelledby': `oa-${i}` },
      h('h3', { class: 'panel-title', id: `oa-${i}` }, 'OpenAPI ', h('span', { class: 'muted', text: `${doc.title} \u00B7 v${doc.version} \u00B7 OpenAPI ${doc.openapi}` })),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'table compact' },
          h('caption', { class: 'sr-only', text: `Paths of ${doc.title}` }),
          h('thead', null, h('tr', null, ...['Method', 'Path', 'Operation', 'Summary'].map((t) => h('th', { scope: 'col', text: t })))),
          h('tbody', null, ...doc.paths.map((p) =>
            h('tr', null, h('td', null, h('code', { class: 'method', text: p.method })), h('td', null, h('code', { text: p.path })), h('td', { text: p.operationId ?? '\u2013' }), h('td', { text: p.summary ?? '\u2013' })))))))));
}

/** @param {{ parts: string[] }} route */
export async function renderSchemas(route) {
  const view = await api.schemas();
  const tools = view.tools ?? [];
  const root = h('div', { class: 'view view-schemas' });
  root.appendChild(h('h1', { class: 'view-title', tabindex: '-1', text: 'Schemas' }));
  root.appendChild(h('p', { class: 'view-lead', text: 'The input a tool accepts and the output it returns, as JSON Schema.' }));
  if (tools.length === 0) {
    root.appendChild(emptyState('No tools yet', 'Compile a workflow set to get its input and output schemas.'));
    return root;
  }
  const active = tools.find((t) => t.workflowId === route.parts[0]) ?? tools[0];
  const list = h('ul', { class: 'wf-list' }, ...tools.map((t) =>
    h('li', null, h('a', { class: 'wf-link', href: href('schemas', t.workflowId), 'aria-current': t.workflowId === active.workflowId ? 'page' : undefined },
      h('span', { class: 'wf-name', text: t.label || t.toolName || t.workflowId }),
      t.toolName ? h('code', { class: 'wf-tool', text: t.toolName }) : null))));
  const nav = h('nav', { class: 'wf-nav', 'aria-label': 'Tools' }, list);
  const main = h('div', { class: 'wf-main' },
    h('header', { class: 'wf-head' },
      h('h2', { class: 'view-title', text: active.label || active.workflowId }),
      h('div', { class: 'wf-meta' },
        active.toolName ? toolName(active.toolName) : h('span', { class: 'muted', text: 'Not compiled yet: no tool name.' }),
        h('a', { class: 'btn btn-small', href: href('workflows', active.workflowId), text: 'Workflow steps' }),
        active.openapiPath ? h('span', { class: 'muted' }, 'POST ', h('code', { text: active.openapiPath })) : null)),
    schemaBlock('schema-in', 'Input', active.inputSchema),
    schemaBlock('schema-out', 'Output', active.outputSchema),
    openapiSection(view));
  root.appendChild(h('div', { class: 'split' }, nav, main));
  return root;
}
