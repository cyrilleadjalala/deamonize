/**
 * Fictitious data for demos and the static export: a legacy CRM web application with three workflows (one per
 * replay level), a terminal workflow around the sqlite3 CLI, a State_Graph, schemas and property-test results.
 * Nothing here comes from a real recording and nothing is secret: the password is a reference by name.
 */
import type { Workflow, WorkflowSet } from '../types.js';
import type { StudioOutputs, StudioTarget } from './model.js';
import type { PbtRunResult } from './pbt-result.js';

const SEARCH_ID = '5a1f0c2e-3b4d-4e6f-8a7b-9c0d1e2f3a4b';
const CREATE_ID = '6b2a1d3f-4c5e-4f70-9b8c-0d1e2f3a4b5c';
const CHART_ID = '7c3b2e40-5d6f-4081-8c9d-1e2f3a4b5c6d';
const SQLITE_ID = '8d4c3f51-6e70-4192-9dae-2f3a4b5c6d7e';

const SCREEN_SEARCH = '1111aaaa2222bbbb';
const SCREEN_CREATED = '3333cccc4444dddd';
const SCREEN_CHART = '5555eeee6666ffff';
const SCREEN_SQLITE = '7777000088881111';

const searchCustomers: Workflow = {
  id: SEARCH_ID,
  label: 'Search customers',
  description: 'Find customers by name and return the matching rows.',
  steps: [
    {
      actionType: 'type', selectors: ['#search'], variable: 'query', label: 'Search box', anchor: { role: 'searchbox', name: 'Search customers', frame: [] },
      http: { method: 'GET', url: 'https://crm.example.test/api/customers?q={{query}}', query: { q: '{{query}}' }, bindings: [{ variable: 'query', in: 'query', name: 'q' }], redacted: [], auth: 'storageState', expectStatus: 200 },
      visual: { rect: { x: 0.1, y: 0.08, w: 0.4, h: 0.05 }, intent: 'the search field above the customer table', thumbnailPath: 'daemonize.workflows.json.assets/sample-search-0.png' }
    },
    { actionType: 'click', selectors: ['#go'], label: 'Search button', anchor: { role: 'button', name: 'Search', frame: [] } },
  ],
  variables: [{ name: 'query', type: 'string', description: 'Part of the customer name' }],
  finalScreenId: SCREEN_SEARCH as Workflow['finalScreenId'],
  resultZone: { selector: '#results', extractor: { kind: 'table' } },
  observedPayloads: [],
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Part of the customer name' } }, required: ['query'] },
  outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, drifted: { type: 'boolean' }, data: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, city: { type: 'string' } } } } } },
};

const createCustomer: Workflow = {
  id: CREATE_ID,
  label: 'Create customer',
  steps: [
    { actionType: 'type', selectors: ['#user'], variable: 'login', label: 'User name', anchor: { role: 'textbox', name: 'User name', frame: [] } },
    { actionType: 'type', selectors: ['#password'], secretRef: 'CRM_PASSWORD', label: 'Password', anchor: { role: 'textbox', name: 'Password', frame: [] } },
    { actionType: 'click', selectors: ['#signin'], label: 'Sign in', anchor: { role: 'button', name: 'Sign in', frame: [] } },
    { actionType: 'type', selectors: ['#name'], variable: 'name', label: 'Customer name', anchor: { role: 'textbox', name: 'Name', parent: { kind: 'dialog', name: 'New customer' }, frame: [] } },
    { actionType: 'select', selectors: ['#country'], variable: 'country', label: 'Country', anchor: { role: 'combobox', name: 'Country', parent: { kind: 'dialog', name: 'New customer' }, frame: [] } },
    {
      actionType: 'click', selectors: ['#save'], label: 'Save', risk: 'write', anchor: { role: 'button', name: 'Save', parent: { kind: 'dialog', name: 'New customer' }, frame: [] },
      visual: { rect: { x: 0.72, y: 0.8, w: 0.12, h: 0.06 }, intent: 'the Save button of the New customer dialog' }
    },
  ],
  variables: [
    { name: 'login', type: 'string', description: 'Account used to sign in' },
    { name: 'name', type: 'string', description: 'Full name of the customer' },
    { name: 'country', type: 'string', description: 'Country code', optional: true },
  ],
  secrets: [{ name: 'CRM_PASSWORD', kind: 'password' }],
  finalScreenId: SCREEN_CREATED as Workflow['finalScreenId'],
  observedPayloads: [],
  inputSchema: { type: 'object', properties: { login: { type: 'string' }, name: { type: 'string' }, country: { type: 'string' } }, required: ['login', 'name'] },
  outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, drifted: { type: 'boolean' } } },
};

const openChart: Workflow = {
  id: CHART_ID,
  label: 'Open sales chart',
  steps: [
    { actionType: 'click', selectors: [], label: 'Reports menu', anchor: { role: 'menuitem', name: 'Reports', frame: [] } },
    {
      actionType: 'click', selectors: [], label: 'Quarter bar', anchor: { role: 'canvas', name: '', frame: [] },
      visual: { rect: { x: 0.44, y: 0.52, w: 0.06, h: 0.3 }, intent: 'the third bar of the quarterly sales chart', thumbnailPath: 'daemonize.workflows.json.assets/sample-chart-1.png' }
    },
  ],
  variables: [],
  finalScreenId: SCREEN_CHART as Workflow['finalScreenId'],
  observedPayloads: [],
  inputSchema: { type: 'object', properties: {} },
  outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, drifted: { type: 'boolean' } } },
};

export const SAMPLE_WEB_SET: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: 'Legacy CRM (sample)',
  startUrl: 'https://crm.example.test/customers',
  storageState: 'auth/crm-state.json',
  sandbox: { network: 'bridge' },
  workflows: [searchCustomers, createCustomer, openChart],
};

const countCustomers: Workflow = {
  id: SQLITE_ID,
  label: 'Count customers in a table',
  steps: [
    { actionType: 'type', selectors: [], variable: 'table', label: 'Query', waitFor: { pattern: 'sqlite> $', timeoutMs: 5000, when: 'after' } },
    { actionType: 'keypress', selectors: [], value: 'Enter', label: 'Run the query', timeoutMs: 8000 },
  ],
  variables: [{ name: 'table', type: 'string', description: 'Table to count' }],
  finalScreenId: SCREEN_SQLITE as Workflow['finalScreenId'],
  resultZone: { rect: { row: 2, col: 0, rows: 1, cols: 20 }, extractor: { kind: 'regex', pattern: '(?<count>\\d+)' } },
  observedPayloads: [],
  cols: 80,
  rows: 24,
  inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
  outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { count: { type: 'string' } } } } },
};

export const SAMPLE_TUI_SET: WorkflowSet = {
  version: '1',
  targetType: 'tui',
  targetName: 'sqlite3 (sample)',
  startCommand: ['sqlite3', 'crm.db'],
  sandbox: { packages: ['sqlite3'], network: 'none' },
  workflows: [countCustomers],
};

function sampleOpenApi(set: WorkflowSet, names: Record<string, string>): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const w of set.workflows) {
    paths[`/actions/${w.id}`] = {
      post: {
        operationId: names[w.id],
        summary: w.label,
        requestBody: { required: true, content: { 'application/json': { schema: w.inputSchema ?? { type: 'object' } } } },
        responses: { '200': { description: 'Result', content: { 'application/json': { schema: w.outputSchema ?? { type: 'object' } } } } },
      },
    };
  }
  return { openapi: '3.1.0', info: { title: set.targetName, version: '1' }, paths };
}

export const SAMPLE_STATE_GRAPH = {
  version: '1',
  screens: {
    [SCREEN_SEARCH]: { id: SCREEN_SEARCH, type: 'dom', label: 'Customer list', observationCount: 12 },
    [SCREEN_CREATED]: { id: SCREEN_CREATED, type: 'dom', label: 'Customer created', observationCount: 4 },
    [SCREEN_CHART]: { id: SCREEN_CHART, type: 'dom', label: 'Sales chart', observationCount: 3 },
    aaaa111122223333: { id: 'aaaa111122223333', type: 'dom', label: 'Sign in', observationCount: 9 },
    bbbb111122223333: { id: 'bbbb111122223333', type: 'dom', label: 'New customer dialog', observationCount: 4 },
  },
  transitions: [
    { id: 't1', sourceScreenId: 'aaaa111122223333', destinationScreenId: SCREEN_SEARCH, actionType: 'click', label: 'Sign in' },
    { id: 't2', sourceScreenId: SCREEN_SEARCH, destinationScreenId: SCREEN_SEARCH, actionType: 'type', label: 'Search' },
    { id: 't3', sourceScreenId: SCREEN_SEARCH, destinationScreenId: 'bbbb111122223333', actionType: 'click', label: 'New customer' },
    { id: 't4', sourceScreenId: 'bbbb111122223333', destinationScreenId: SCREEN_CREATED, actionType: 'click', label: 'Save' },
    { id: 't5', sourceScreenId: SCREEN_SEARCH, destinationScreenId: SCREEN_CHART, actionType: 'click', label: 'Reports' },
  ],
};

export const SAMPLE_PBT_RESULT: PbtRunResult = {
  ranAt: '2025-01-01T10:00:00.000Z',
  durationMs: 4210,
  status: 'failed',
  totals: { passing: 7, failing: 1, skipped: 0 },
  tools: [
    { tool: 'search_customers', passing: 2, failing: 0, skipped: 0, counterexamples: [] },
    { tool: 'create_customer', passing: 1, failing: 1, skipped: 0, counterexamples: [{ property: 'invalid payloads are rejected', counterexample: '{"login":"a","name":""}' }] },
    { tool: 'open_sales_chart', passing: 2, failing: 0, skipped: 0, counterexamples: [] },
    { tool: 'count_customers_in_a_table', passing: 2, failing: 0, skipped: 0, counterexamples: [] },
  ],
};

/** The data of the sample mode: two targets, their outputs, a State_Graph and a property-test result. */
export function sampleStudioData(): { targets: StudioTarget[]; stateGraph: unknown; pbt: PbtRunResult } {
  const webNames = { [SEARCH_ID]: 'search_customers', [CREATE_ID]: 'create_customer', [CHART_ID]: 'open_sales_chart' };
  const tuiNames = { [SQLITE_ID]: 'count_customers_in_a_table' };
  const web: StudioOutputs = {
    nameMap: webNames,
    openapi: sampleOpenApi(SAMPLE_WEB_SET, webNames),
    flags: { compiled: true, healSupport: true, http: true, pbtGenerated: true },
    testTools: Object.values(webNames),
  };
  const tui: StudioOutputs = {
    nameMap: tuiNames,
    openapi: sampleOpenApi(SAMPLE_TUI_SET, tuiNames),
    flags: { compiled: true, healSupport: false, http: false, pbtGenerated: true },
    testTools: Object.values(tuiNames),
  };
  return {
    targets: [
      { set: structuredClone(SAMPLE_WEB_SET), outputs: web },
      { set: structuredClone(SAMPLE_TUI_SET), outputs: tui },
    ],
    stateGraph: structuredClone(SAMPLE_STATE_GRAPH),
    pbt: structuredClone(SAMPLE_PBT_RESULT),
  };
}

/** A 1x1 transparent PNG: the stand-in picture of every sample thumbnail. */
export const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
