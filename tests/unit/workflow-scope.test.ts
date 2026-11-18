/**
 * The pure helpers of src/workflow/workflow-scope.ts.
 * The path-binding cases carry:
 * Feature: user-journey-improvements, Property 8: A skipped Variable in a path is refused (helper part)
 */
import { describe, expect, it } from 'vitest';
import {
  SKIP_IN_PATH_MESSAGE,
  findSkippedPathBinding,
  originOf,
  skipListOf,
  startUrlOf,
  storageStateOf,
  usesWorkflowCall,
  validateWorkflowScopes,
} from '../../src/workflow/workflow-scope.js';
import type { Workflow, WorkflowSet, WorkflowVariable } from '../../src/types.js';

const ID = '77777777-7777-4777-8777-777777777777';

function workflow(variables: WorkflowVariable[] = [], extra: Partial<Workflow> = {}): Workflow {
  return { id: ID, label: 'Action', steps: [{ actionType: 'click', selectors: ['button'] }], variables, observedPayloads: [], ...extra };
}

function set(workflows: Workflow[], extra: Partial<WorkflowSet> = {}): WorkflowSet {
  return { version: '1', targetType: 'web', targetName: 'app', startUrl: 'https://app.test/start', workflows, ...extra };
}

describe('skipListOf', () => {
  it('lists optional Variables that skip, once each, in workflow order', () => {
    const list = skipListOf(
      workflow([
        { name: 'b', optional: true, whenOmitted: 'skip' },
        { name: 'a', optional: true, whenOmitted: 'useRecorded' },
        { name: 'c', optional: true },
        { name: 'd' },
        { name: 'a2', optional: true, whenOmitted: 'skip' },
        { name: 'b', optional: true, whenOmitted: 'skip' },
      ]),
    );
    expect(list).toEqual(['b', 'a2']);
  });

  it('is empty for no Variable', () => {
    expect(skipListOf(workflow())).toEqual([]);
  });
});

describe('findSkippedPathBinding (Requirements 3.7, helper part)', () => {
  const recipe = (variable: string, where: 'path' | 'query') => ({
    method: 'GET' as const,
    url: 'https://app.test/items/{{x}}',
    query: {},
    bindings: [{ variable, in: where, name: '2' }],
    redacted: [],
  });

  it('reports the first Skip_List Variable bound in a path, with its step index', () => {
    const w = workflow([{ name: 'id', optional: true, whenOmitted: 'skip' }], {
      steps: [
        { actionType: 'click', selectors: ['a'] },
        { actionType: 'click', selectors: ['b'], http: recipe('id', 'path') },
      ],
    });
    expect(findSkippedPathBinding(w)).toEqual({ stepIndex: 1, variable: 'id' });
  });

  it('ignores a required Variable, a useRecorded Variable and a query binding', () => {
    const steps = [{ actionType: 'click' as const, selectors: ['b'], http: recipe('id', 'path') }];
    expect(findSkippedPathBinding(workflow([{ name: 'id' }], { steps }))).toBeUndefined();
    expect(findSkippedPathBinding(workflow([{ name: 'id', optional: true, whenOmitted: 'useRecorded' }], { steps }))).toBeUndefined();
    const query = [{ actionType: 'click' as const, selectors: ['b'], http: recipe('id', 'query') }];
    expect(findSkippedPathBinding(workflow([{ name: 'id', optional: true, whenOmitted: 'skip' }], { steps: query }))).toBeUndefined();
  });

  it('words the refusal with the workflow and the Variable, and no value', () => {
    const text = SKIP_IN_PATH_MESSAGE(ID, 'id');
    expect(text).toContain(ID);
    expect(text).toContain('"id"');
  });
});

describe('startUrlOf and storageStateOf', () => {
  it('use the workflow value, else the set value', () => {
    expect(startUrlOf({ startUrl: 'https://a.test/' }, {})).toBe('https://a.test/');
    expect(startUrlOf({ startUrl: 'https://a.test/' }, { startUrl: 'https://a.test/b' })).toBe('https://a.test/b');
    expect(startUrlOf({}, {})).toBeUndefined();
    expect(storageStateOf({ storageState: 'set.json' }, {})).toBe('set.json');
    expect(storageStateOf({ storageState: 'set.json' }, { storageState: 'own.json' })).toBe('own.json');
    expect(storageStateOf({}, {})).toBeUndefined();
  });

  it('treats null as no login even when the set has one', () => {
    expect(storageStateOf({ storageState: 'set.json' }, { storageState: null })).toBeUndefined();
  });
});

describe('originOf', () => {
  it('gives the origin, with a default port equal to none, and undefined for text that is not an address', () => {
    expect(originOf('https://app.test:443/x?y=1#z')).toBe('https://app.test');
    expect(originOf('http://app.test:8080/x')).toBe('http://app.test:8080');
    expect(originOf('not an address')).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
  });
});

describe('validateWorkflowScopes (Requirements 10.10, 10.11)', () => {
  it('accepts a set whose workflows keep the origin of the set, or have no startUrl', () => {
    expect(validateWorkflowScopes(set([workflow(), workflow([], { id: 'other', startUrl: 'https://app.test:443/b' })]))).toBeUndefined();
  });

  it('names the workflow id and both origins when a startUrl is on another origin', () => {
    const text = validateWorkflowScopes(set([workflow([], { startUrl: 'https://elsewhere.test/b' })]));
    expect(text).toContain(ID);
    expect(text).toContain('https://elsewhere.test');
    expect(text).toContain('https://app.test');
  });

  it('refuses a startUrl in a terminal set and says it applies to a web target only', () => {
    const terminal: WorkflowSet = { version: '1', targetType: 'tui', targetName: 't', startCommand: ['sh'], workflows: [workflow([], { startUrl: 'https://app.test/b' })] };
    const text = validateWorkflowScopes(terminal);
    expect(text).toContain(ID);
    expect(text).toContain('web target only');
  });
});

describe('usesWorkflowCall', () => {
  it('is false for an old set and true with a Skip_List, a startUrl or a storageState (even null)', () => {
    expect(usesWorkflowCall(set([workflow([{ name: 'a', optional: true }])]))).toBe(false);
    expect(usesWorkflowCall(set([workflow([{ name: 'a', optional: true, whenOmitted: 'useRecorded' }])]))).toBe(false);
    expect(usesWorkflowCall(set([workflow([{ name: 'a', optional: true, whenOmitted: 'skip' }])]))).toBe(true);
    expect(usesWorkflowCall(set([workflow([], { startUrl: 'https://app.test/b' })]))).toBe(true);
    expect(usesWorkflowCall(set([workflow([], { storageState: null })]))).toBe(true);
    expect(usesWorkflowCall(set([workflow([], { storageState: 'x.json' })]))).toBe(true);
  });
});
