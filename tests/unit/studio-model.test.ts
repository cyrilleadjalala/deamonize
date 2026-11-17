import { describe, it, expect } from 'vitest';
import {
  buildGraph,
  buildOverview,
  buildPbtView,
  buildSchemas,
  buildWorkflows,
  classifyStep,
  displayUrl,
  urlPath,
  NO_OUTPUTS,
  MAX_GRAPH_NODES,
  type StudioTarget,
} from '../../src/studio/model.js';
import { sampleStudioData } from '../../src/studio/sample-data.js';
import { summarizeVitestJson, normalizePbtResult } from '../../src/studio/pbt-result.js';
import type { WorkflowSet, WorkflowStep } from '../../src/types.js';

const web = (steps: WorkflowStep[], extra: Partial<WorkflowSet> = {}): StudioTarget => ({
  set: {
    version: '1',
    targetType: 'web',
    targetName: 'App',
    startUrl: 'https://user:pw@app.example.test/start?token=abc#frag',
    workflows: [{ id: '11111111-1111-4111-8111-111111111111', label: 'Do it', steps, variables: [], observedPayloads: [] }],
    ...extra,
  },
  outputs: NO_OUTPUTS,
});

describe('classifyStep', () => {
  it('marks every level a step supports and picks the first as primary', () => {
    const step: WorkflowStep = {
      actionType: 'click',
      selectors: ['#go'],
      anchor: { role: 'button', name: 'Go', frame: [] },
      http: { method: 'POST', url: 'https://a.test/x', query: {}, bindings: [], redacted: [] },
      visual: { rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, intent: 'the Go button' },
    };
    expect(classifyStep(step, 'web')).toEqual({
      levels: { http: true, accessibility: true, vision: true, coordinates: true },
      primaryLevel: 'http',
    });
  });

  it('classifies an accessibility-only step', () => {
    const r = classifyStep({ actionType: 'click', selectors: [], anchor: { role: 'button', name: 'Save', frame: [] } }, 'web');
    expect(r.levels).toEqual({ http: false, accessibility: true, vision: false, coordinates: false });
    expect(r.primaryLevel).toBe('accessibility');
  });

  it('classifies a canvas step as vision and coordinates only', () => {
    const r = classifyStep(
      { actionType: 'click', selectors: [], anchor: { role: 'canvas', name: '', frame: [] }, visual: { rect: { x: 0.4, y: 0.5, w: 0.1, h: 0.1 }, intent: 'a bar' } },
      'web'
    );
    expect(r.levels).toEqual({ http: false, accessibility: false, vision: true, coordinates: true });
    expect(r.primaryLevel).toBe('vision');
  });

  it('gives a visual anchor without picture or intent coordinates only', () => {
    const r = classifyStep({ actionType: 'click', selectors: [], visual: { rect: { x: 0, y: 0, w: 1, h: 1 }, intent: ' ' } }, 'web');
    expect(r.levels).toEqual({ http: false, accessibility: false, vision: false, coordinates: true });
    expect(r.primaryLevel).toBe('coordinates');
  });

  it('has no web level for a terminal step', () => {
    const r = classifyStep({ actionType: 'keypress', selectors: [], value: 'Enter' }, 'tui');
    expect(r.levels).toEqual({ http: false, accessibility: false, vision: false, coordinates: false });
    expect(r.primaryLevel).toBe('terminal');
  });

  it('reports none for a web step with nothing to replay it with', () => {
    expect(classifyStep({ actionType: 'click', selectors: [] }, 'web').primaryLevel).toBe('none');
  });
});

describe('workflow view models', () => {
  it('lists secrets by name only and never carries typed values', () => {
    const target = web([
      { actionType: 'type', selectors: ['#password'], secretRef: 'APP_PASSWORD', value: 'hunter2-literal', label: 'Password' },
      { actionType: 'type', selectors: ['#name'], variable: 'name', value: 'recorded-constant-value' },
    ]);
    target.set.workflows[0].secrets = [{ name: 'APP_PASSWORD', kind: 'password' }, 'OTHER_SECRET'];
    const { workflows } = buildWorkflows([target]);
    expect(workflows[0].secrets).toEqual([
      { name: 'APP_PASSWORD', kind: 'password', envVariable: 'DAEMONIZE_SECRET_APP_PASSWORD' },
      { name: 'OTHER_SECRET', envVariable: 'DAEMONIZE_SECRET_OTHER_SECRET' },
    ]);
    expect(workflows[0].steps[0].usesSecret).toBe(true);
    const json = JSON.stringify(workflows);
    expect(json).not.toContain('hunter2-literal');
    expect(json).not.toContain('recorded-constant-value');
  });

  it('summarises an http step without query values, headers or credentials of the URL', () => {
    const target = web([
      {
        actionType: 'click',
        selectors: ['#go'],
        http: {
          method: 'GET',
          url: 'https://admin:s3cr3t@app.example.test/api/customers/{{id}}?apikey=QUERYSECRET#x',
          query: { apikey: 'QUERYSECRET' },
          headers: { 'x-api-key': { $secret: 'API_KEY' } },
          bindings: [{ variable: 'id', in: 'path', name: '3' }],
          redacted: [{ in: 'header', name: 'x-api-key', secret: 'API_KEY' }],
        },
      },
    ]);
    const { workflows } = buildWorkflows([target]);
    expect(workflows[0].steps[0].http).toMatchObject({ method: 'GET', path: '/api/customers/{{id}}', queryKeys: ['apikey'], bindings: 1, redacted: 1 });
    // Not compiled: nothing reads the recipe, so the name is recorded but not required
    expect(workflows[0].secrets).toEqual([]);
    expect(workflows[0].unusedSecrets).toEqual([{ name: 'API_KEY', envVariable: 'DAEMONIZE_SECRET_API_KEY' }]);
    expect(workflows[0].secretsBasis).toBe('not-compiled');
    const json = JSON.stringify(workflows);
    expect(json).not.toContain('QUERYSECRET');
    expect(json).not.toContain('s3cr3t');
  });

  it('summarises risk, variables, row binding, waits and a thumbnail url', () => {
    const target = web([
      { actionType: 'click', selectors: ['#a'], risk: 'write', rowBinding: { container: { kind: 'row' }, variable: 'who', key: { text: 'Ada', column: 'Name' } }, visual: { rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, intent: 'row action', thumbnailPath: 'f.json.assets/step-1-2.png' } },
      { actionType: 'keypress', selectors: [], risk: 'delete', waitFor: { pattern: 'ok\\$', timeoutMs: 500 }, timeoutMs: 900 },
    ]);
    target.set.workflows[0].variables = [{ name: 'who', type: 'string', description: 'Customer' }];
    const [w] = buildWorkflows([target]).workflows;
    expect(w.risk).toEqual({ read: 0, write: 1, delete: 1, highest: 'delete' });
    expect(w.variables).toEqual([{ name: 'who', type: 'string', description: 'Customer', optional: false }]);
    expect(w.steps[0].rowBinding).toEqual({ kind: 'row', variable: 'who', keyColumn: 'Name' });
    expect(w.steps[0].thumbnailUrl).toBe('/api/assets/step-1-2.png');
    expect(w.steps[1].waitFor).toMatchObject({ kind: 'pattern', timeoutMs: 500, mode: 'appear' });
    expect(w.steps[1].timeoutMs).toBe(900);
  });

  it('offers no thumbnail for a secret step or an unsafe name', () => {
    const target = web([
      { actionType: 'type', selectors: ['input[type=password]'], visual: { rect: { x: 0, y: 0, w: 1, h: 1 }, intent: 'x', thumbnailPath: 'a.assets/step-1-0.png' } },
      { actionType: 'click', selectors: ['#a'], visual: { rect: { x: 0, y: 0, w: 1, h: 1 }, intent: 'x', thumbnailPath: '../../etc/pass.wd.png' } },
    ]);
    const [w] = buildWorkflows([target]).workflows;
    expect(w.steps[0].thumbnailUrl).toBeUndefined();
    expect(w.steps[1].thumbnailUrl).toBeUndefined();
  });

  it('takes the tool name from the name map', () => {
    const target = web([{ actionType: 'click', selectors: ['#a'] }]);
    target.outputs = { ...NO_OUTPUTS, nameMap: { '11111111-1111-4111-8111-111111111111': 'do_it' } };
    expect(buildWorkflows([target]).workflows[0].toolName).toBe('do_it');
  });
});

describe('secrets of the compiled mode and write steps', () => {
  const recipe = (name: string) => ({ method: 'POST', url: 'https://a.test/x', query: {}, headers: { 'x-t': { $secret: name } }, bindings: [], redacted: [] });
  const steps: WorkflowStep[] = [
    { actionType: 'type', selectors: ['#pw'], secretRef: 'PW', label: 'Password', risk: 'read' },
    { actionType: 'click', selectors: ['#verify'], label: 'Verify', risk: 'write', http: recipe('TOTP') },
    { actionType: 'click', selectors: ['#next'] },
    { actionType: 'click', selectors: ['#search'], http: recipe('SEARCH_KEY') },
  ];
  const compiled = (http: boolean): StudioTarget => {
    const target = web(steps);
    target.outputs = { ...NO_OUTPUTS, flags: { compiled: true, healSupport: false, http, pbtGenerated: false } };
    return target;
  };

  it('requires only the typed secrets and the HTTP-planned recipe names, and reports the others as unused', () => {
    const http = buildWorkflows([compiled(true)]).workflows[0];
    expect(http.secretsBasis).toBe('http');
    expect(http.secrets.map((s) => s.name)).toEqual(['PW', 'SEARCH_KEY']);
    expect(http.unusedSecrets.map((s) => s.name)).toEqual(['TOTP']);
    const ui = buildWorkflows([compiled(false)]).workflows[0];
    expect(ui.secretsBasis).toBe('ui-only');
    expect(ui.secrets.map((s) => s.name)).toEqual(['PW']);
    expect(ui.unusedSecrets.map((s) => s.name)).toEqual(['SEARCH_KEY', 'TOTP']);
  });

  it('gives each required secret a status from the names that are configured, never a value', () => {
    const { workflows } = buildWorkflows([compiled(true)], { configured: new Set(['DAEMONIZE_SECRET_PW']) });
    expect(workflows[0].secrets).toEqual([
      { name: 'PW', envVariable: 'DAEMONIZE_SECRET_PW', status: 'configured' },
      { name: 'SEARCH_KEY', envVariable: 'DAEMONIZE_SECRET_SEARCH_KEY', status: 'missing' },
    ]);
    // Without a source the status is unknown
    expect(buildWorkflows([compiled(true)]).workflows[0].secrets.every((s) => s.status === undefined)).toBe(true);
  });

  it('lists the write steps and says when the only write is the login', () => {
    const [w] = buildWorkflows([compiled(true)]).workflows;
    expect(w.writeSteps).toEqual([{ index: 1, label: 'Verify', risk: 'write', kind: 'login' }]);
    expect(w.writeSummary).toBe('login-only');
    expect(w.risk.highest).toBe('write');
    const more = web([...steps, { actionType: 'click', selectors: ['#save'], risk: 'delete' }]);
    const [m] = buildWorkflows([more]).workflows;
    expect(m.writeSteps.map((x) => [x.index, x.kind, x.label])).toEqual([[1, 'login', 'Verify'], [4, 'action', 'click 5']]);
    expect(m.writeSummary).toBe('actions');
  });

  it('reports none for a read-only workflow', () => {
    const [w] = buildWorkflows([web([{ actionType: 'click', selectors: ['#a'] }])]).workflows;
    expect(w.writeSteps).toEqual([]);
    expect(w.writeSummary).toBe('none');
  });
});

describe('overview', () => {
  it('reports the target, counts, mode flags and sandbox, without credentials or command arguments', () => {
    const target = web([{ actionType: 'click', selectors: ['#a'] }], { storageState: 'C:\\secret-dir\\auth\\state.json', sandbox: { packages: ['curl'], install: ['echo TOPSECRET'] } });
    target.outputs = { ...NO_OUTPUTS, flags: { compiled: true, healSupport: true, http: false, pbtGenerated: true } };
    const o = buildOverview([target], false);
    expect(o).toMatchObject({ sample: false, targetType: 'web', targetName: 'App' });
    expect(o.targets[0]).toMatchObject({
      start: 'https://app.example.test/start',
      storageState: 'state.json',
      workflows: 1,
      steps: 1,
      modes: { compiled: true, strict: true, healSupport: true, http: false },
      sandbox: { network: 'bridge', packages: ['curl'], installCommands: 1 },
    });
    const json = JSON.stringify(o);
    expect(json).not.toContain('TOPSECRET');
    expect(json).not.toContain('secret-dir');
    expect(json).not.toContain('pw@');
  });

  it('shows a terminal command as the program and a count of arguments', () => {
    const o = buildOverview(
      [{ set: { version: '1', targetType: 'tui', targetName: 't', startCommand: ['/usr/bin/tool', '--password', 'hunter2'], workflows: [] }, outputs: NO_OUTPUTS }],
      false
    );
    expect(o.targets[0].start).toBe('tool (+2 arguments)');
    expect(o.targets[0].sandbox.network).toBe('none');
    expect(JSON.stringify(o)).not.toContain('hunter2');
  });

  it('strips userinfo and query from a start url', () => {
    expect(displayUrl('http://a:b@h.test:8080/p?q=1')).toBe('http://h.test:8080/p');
    expect(urlPath('https://h.test/a/%7B%7Bid%7D%7D?x=1')).toBe('/a/{{id}}');
  });
});

describe('graph', () => {
  it('derives a graph from the workflow steps when there is no State_Graph', () => {
    const target = web([{ actionType: 'click', selectors: ['#a'], label: 'First' }, { actionType: 'click', selectors: ['#b'], label: 'Second' }]);
    target.set.workflows[0].finalScreenId = 'abcdef0123456789' as never;
    const g = buildGraph([target]);
    expect(g.source).toBe('workflows');
    expect(g.nodes.map((n) => n.kind)).toEqual(['start', 'step', 'final']);
    expect(g.nodes[2].id).toBe('screen:abcdef0123456789');
    expect(g.edges).toHaveLength(2);
    expect(g.edges[0].level).toBe('accessibility');
  });

  it('uses a State_Graph without its snapshots', () => {
    const g = buildGraph([], {
      screens: { a: { id: 'a', type: 'dom', snapshot: '<p>SNAPSHOT-TEXT</p>', label: 'A', observationCount: 2 }, b: { id: 'b', type: 'dom', snapshot: 'x', observationCount: 1 } },
      transitions: [{ id: 't', sourceScreenId: 'a', destinationScreenId: 'b', actionType: 'click', label: 'go', observedPayloads: [{ secret: 'PAYLOAD' }] }, { id: 'u', sourceScreenId: 'a', destinationScreenId: 'missing', actionType: 'click', label: 'bad' }],
    });
    expect(g.source).toBe('state-graph');
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(JSON.stringify(g)).not.toMatch(/SNAPSHOT-TEXT|PAYLOAD/);
  });

  it('caps the size', () => {
    const steps: WorkflowStep[] = Array.from({ length: 450 }, (_, i) => ({ actionType: 'click', selectors: [`#b${i}`] }));
    const g = buildGraph([web(steps)]);
    expect(g.nodes.length).toBeLessThanOrEqual(MAX_GRAPH_NODES);
    expect(g.truncated).toBe(true);
  });
});

describe('schemas and pbt', () => {
  it('prefers the compiled OpenAPI schemas and lists its paths', () => {
    const { targets } = sampleStudioData();
    const s = buildSchemas(targets);
    expect(s.tools.map((t) => t.toolName)).toEqual(['search_customers', 'create_customer', 'open_sales_chart', 'count_customers_in_a_table']);
    expect(s.tools[0].inputSchema).toMatchObject({ type: 'object', required: ['query'] });
    expect(s.openapi[0].paths[0]).toMatchObject({ method: 'POST', operationId: 'search_customers' });
  });

  it('summarises a vitest report per tool with the shrunk counterexample', () => {
    const report = {
      testResults: [
        {
          name: 'C:\\out\\tests\\create_customer.property.test.ts',
          status: 'failed',
          assertionResults: [
            { status: 'passed', fullName: 'a accepts' },
            { status: 'failed', fullName: 'a rejects', failureMessages: ['Error: Property "invalid payloads are rejected" failed after 3 runs (shrunk 2 times). Counterexample: {"x":1}\n at stack'] },
            { status: 'skipped', fullName: 'c' },
          ],
        },
        { name: '/out/tests/broken.property.test.ts', status: 'failed', message: 'Cannot find module', assertionResults: [] },
        { name: '/out/tests/schema-arbitrary.ts', status: 'passed', assertionResults: [] },
      ],
    };
    const r = summarizeVitestJson(report, '2025-01-01T00:00:00.000Z', 10);
    expect(r.status).toBe('failed');
    expect(r.totals).toEqual({ passing: 1, failing: 2, skipped: 1 });
    expect(r.tools.find((t) => t.tool === 'create_customer')?.counterexamples).toEqual([{ property: 'invalid payloads are rejected', counterexample: '{"x":1}' }]);
    expect(r.tools.find((t) => t.tool === 'broken')?.error).toBe('Cannot find module');
  });

  it('rejects a stored result that is not one and bounds a valid one', () => {
    expect(normalizePbtResult({ nope: true })).toBeUndefined();
    expect(normalizePbtResult({ status: 'weird', tools: [] })).toBeUndefined();
    const ok = normalizePbtResult({ status: 'passed', tools: [{ tool: 't', passing: 2, failing: -1, skipped: 'x', counterexamples: [] }] });
    expect(ok?.tools[0]).toMatchObject({ passing: 2, failing: 0, skipped: 0 });
  });

  it('builds the pbt view with generated tools and the running flag', () => {
    const { targets, pbt } = sampleStudioData();
    const v = buildPbtView(pbt, targets, true);
    expect(v).toMatchObject({ available: true, running: true });
    expect(v.generatedTools).toContain('search_customers');
    expect(buildPbtView(undefined, targets, false).available).toBe(false);
  });
});
