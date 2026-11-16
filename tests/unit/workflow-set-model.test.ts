import { describe, it, expect } from 'vitest';
import {
  deserializeWorkflowSet,
  findPlainSecrets,
  mergeWorkflowSets,
  serializeWorkflowSet,
} from '../../src/workflow/workflow-set.js';
import type { WorkflowSet, WorkflowStep } from '../../src/types.js';

const ID1 = '3f2a1c4e-0b1d-4a5e-8c7f-123456789abc';
const ID2 = '9a8b7c6d-5e4f-4a3b-8c2d-0123456789ab';

function webSet(steps: WorkflowStep[], extra: Record<string, unknown> = {}): WorkflowSet {
  return {
    version: '1',
    targetType: 'web',
    targetName: 'app',
    startUrl: 'https://app.example.com',
    workflows: [
      { id: ID1, label: 'wf', steps, variables: [], observedPayloads: [], ...extra },
    ],
  };
}

const fullStep: WorkflowStep = {
  actionType: 'click',
  selectors: ['role=button[name="Delete"]'],
  anchor: {
    role: 'button',
    name: 'Delete',
    parent: { kind: 'region', name: 'Customers' },
    frame: [],
    popup: { page: 0 },
  },
  rowBinding: { container: { role: 'row' }, variable: 'customer' },
  http: {
    method: 'DELETE',
    url: 'https://app.example.com/api/customers/{{customer_id}}',
    query: {},
    headers: { Authorization: { $secret: 'APP_TOKEN' } },
    bindings: [{ variable: 'customer_id', in: 'path', name: '4' }],
    redacted: [{ in: 'header', name: 'Authorization', secret: 'APP_TOKEN' }],
  },
  visual: {
    thumbnailPath: 'workflows.thumbs/3f2a-4.png',
    rect: { x: 0.81, y: 0.42, w: 0.06, h: 0.04 },
    intent: 'click the Delete button',
  },
  risk: 'delete',
  allowHeal: true,
  resultZone: { selector: '#out', extractor: { kind: 'text' } },
  timeoutMs: 5000,
};

const fullSet: WorkflowSet = {
  ...webSet([
    fullStep,
    {
      actionType: 'type',
      selectors: [],
      secretRef: 'DB_PASSWORD',
      totp: false,
      label: 'password',
      waitFor: { pattern: '^Password: ?$', timeoutMs: 5000, when: 'before' },
    },
  ], {
    cols: 100,
    rows: 30,
    finalZone: { selector: '#main' },
    secrets: ['APP_TOKEN', { name: 'DB_PASSWORD', kind: 'password' }],
    timeoutMs: 20000,
  }),
  timeoutMs: 15000,
  sandbox: { image: 'node:20', packages: ['git'], install: ['npm i -g x'], network: 'none' },
};

/** Serialize a mutated clone of fullSet through deserialize (skips the serialize guard). */
function loads(mutate: (s: any) => void): void {
  const copy = structuredClone(fullSet) as any;
  mutate(copy);
  deserializeWorkflowSet(JSON.stringify(copy));
}

describe('workflow set model extensions', () => {
  it('loads an old-format file unchanged', () => {
    const old = {
      version: '1',
      targetType: 'web',
      targetName: 'app',
      startUrl: 'https://x.test',
      workflows: [
        {
          id: ID1,
          label: 'old',
          steps: [{ actionType: 'click', selectors: ['#a'] }],
          variables: [],
          observedPayloads: [],
        },
      ],
    };
    expect(deserializeWorkflowSet(JSON.stringify(old))).toEqual(old);
  });

  it('round-trips a fully populated set', () => {
    expect(deserializeWorkflowSet(serializeWorkflowSet(fullSet))).toEqual(fullSet);
  });

  it('accepts valid and rejects invalid values for each new field', () => {
    expect(() => loads(() => {})).not.toThrow();
    const bad: Array<[string, (s: any) => void]> = [
      ['risk', (s) => (s.workflows[0].steps[0].risk = 'destroy')],
      ['rect > 1', (s) => (s.workflows[0].steps[0].visual.rect.x = 1.5)],
      ['rect < 0', (s) => (s.workflows[0].steps[0].visual.rect.h = -0.1)],
      ['network', (s) => (s.sandbox.network = 'host')],
      ['secrets pattern', (s) => (s.workflows[0].secrets = ['lower'])],
      ['secretRef pattern', (s) => (s.workflows[0].steps[1].secretRef = 'bad-name')],
      ['unknown in anchor', (s) => (s.workflows[0].steps[0].anchor.extra = 1)],
      ['unknown in http', (s) => (s.workflows[0].steps[0].http.extra = 1)],
      ['unknown in visual', (s) => (s.workflows[0].steps[0].visual.extra = 1)],
      ['unknown in sandbox', (s) => (s.sandbox.extra = 1)],
      ['unknown in rowBinding', (s) => (s.workflows[0].steps[0].rowBinding.extra = 1)],
      ['anchor frame type', (s) => (s.workflows[0].steps[0].anchor.frame = ['a'])],
      ['http method', (s) => (s.workflows[0].steps[0].http.method = 'TRACE')],
      ['waitFor missing timeout', (s) => delete s.workflows[0].steps[1].waitFor.timeoutMs],
      ['totp type', (s) => (s.workflows[0].steps[1].totp = 'yes')],
      ['allowHeal type', (s) => (s.workflows[0].steps[0].allowHeal = 'yes')],
      ['step timeoutMs type', (s) => (s.workflows[0].steps[0].timeoutMs = '5')],
      ['cols type', (s) => (s.workflows[0].cols = 'wide')],
      ['set timeoutMs type', (s) => (s.timeoutMs = 'long')],
      ['resultZone extractor', (s) => (s.workflows[0].steps[0].resultZone.extractor = { kind: 'x' })],
      ['sandbox packages type', (s) => (s.sandbox.packages = 'git')],
    ];
    for (const [name, mutate] of bad) {
      expect(() => loads(mutate), name).toThrow();
    }
  });

  it('merge keeps the new fields and replaces by workflow id', () => {
    const other: WorkflowSet = {
      ...fullSet,
      workflows: [{ ...fullSet.workflows[0], id: ID2, label: 'other', cols: 120 }],
    };
    const merged = mergeWorkflowSets(fullSet, other);
    expect(merged.workflows.map((w) => w.id)).toEqual([ID1, ID2]);
    expect(merged.workflows[0]).toEqual(fullSet.workflows[0]);
    expect(merged.workflows[1].cols).toBe(120);
    expect(merged.sandbox).toEqual(fullSet.sandbox);
    expect(merged.timeoutMs).toBe(15000);

    const replaced = mergeWorkflowSets(fullSet, {
      ...fullSet,
      workflows: [{ ...fullSet.workflows[0], rows: 50 }],
    });
    expect(replaced.workflows).toHaveLength(1);
    expect(replaced.workflows[0].rows).toBe(50);
  });
});

describe('findPlainSecrets', () => {
  it('accepts secret references and a fully populated set', () => {
    expect(findPlainSecrets(fullSet)).toEqual([]);
  });

  it('flags a literal value on a secretRef step', () => {
    const set = webSet([{ actionType: 'type', selectors: [], secretRef: 'PW', value: 'hunter2' }]);
    expect(findPlainSecrets(set)).toEqual(['$.workflows[0].steps[0].value']);
    expect(() => serializeWorkflowSet(set)).toThrow(/steps\[0\]\.value/);
    expect(() => deserializeWorkflowSet(JSON.stringify(set))).toThrow(/steps\[0\]\.value/);
  });

  it('flags a literal value on a totp step', () => {
    const set = webSet([
      { actionType: 'type', selectors: ['#otp'], totp: true, secretRef: 'OTP', value: '123456' },
    ]);
    expect(findPlainSecrets(set)).toEqual(['$.workflows[0].steps[0].value']);
  });

  it('flags a literal value on a password-typed step', () => {
    const bySelector = webSet([
      { actionType: 'type', selectors: ['input[type="password"]'], value: 'x' },
    ]);
    const byLabel = webSet([{ actionType: 'type', selectors: ['#p'], label: 'Password', value: 'x' }]);
    expect(findPlainSecrets(bySelector)).toHaveLength(1);
    expect(findPlainSecrets(byLabel)).toHaveLength(1);
  });

  it('flags literal authorization, cookie, set-cookie and token keys in http', () => {
    const http = {
      method: 'POST' as const,
      url: 'https://x.test/a',
      query: { token: 'abc' },
      headers: {
        Authorization: 'Bearer abc',
        Cookie: 'sid=1',
        'Set-Cookie': 'sid=1',
        Accept: 'application/json',
      },
      body: { nested: { token: 'abc' } },
      bindings: [],
      redacted: [],
    };
    const paths = findPlainSecrets(webSet([{ actionType: 'click', selectors: [], http }]));
    expect(paths).toEqual([
      '$.workflows[0].steps[0].http.query.token',
      '$.workflows[0].steps[0].http.headers.Authorization',
      '$.workflows[0].steps[0].http.headers.Cookie',
      '$.workflows[0].steps[0].http.headers.Set-Cookie',
      '$.workflows[0].steps[0].http.body.nested.token',
    ]);
  });

  it('accepts {"$secret":"NAME"} references in those places', () => {
    const http = {
      method: 'GET' as const,
      url: 'https://x.test/a',
      query: {},
      headers: { Authorization: { $secret: 'A' }, Cookie: { $secret: 'C' } },
      body: { token: { $secret: 'T' } },
      bindings: [],
      redacted: [],
    };
    expect(findPlainSecrets(webSet([{ actionType: 'click', selectors: [], http }]))).toEqual([]);
  });
});
