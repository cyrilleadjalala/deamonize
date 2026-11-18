import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MissingSecretError,
  StepExecutionError,
  decideCandidate,
  describeFailure,
  failureResult,
  frameHintSelector,
  missingSecrets,
  planLocators,
  resolveStepValue,
  runStepsStrict,
  type StepLike,
} from '../../src/replay/runtime/step-plan.js';

const dialogSave: StepLike = {
  actionType: 'click',
  selectors: ['role=dialog[name="Edit customer details"] >> role=button[name="Save"]', 'role=button[name="Save"]', '#dialog-save', 'body > div > button'],
  anchor: { role: 'button', name: 'Save', parent: { kind: 'dialog', name: 'Edit customer details' }, frame: [] },
  risk: 'write',
};

describe('planLocators', () => {
  it('puts the role and name scoped by the parent first, then the recorded selectors in order, css last', () => {
    const plan = planLocators(dialogSave);
    expect(plan.map((c) => c.description)).toEqual([
      "getByRole('button', { name: 'Save', exact: true }) in dialog 'Edit customer details'",
      'role=dialog[name="Edit customer details"] >> role=button[name="Save"]',
      'role=button[name="Save"]',
      '#dialog-save',
      'css: body > div > button',
    ]);
    expect(plan[0]).toMatchObject({ kind: 'role', scope: { kind: 'dialog', name: 'Edit customer details' } });
    expect(plan.at(-1)?.kind).toBe('css');
  });

  it('uses an unscoped role locator only for a control with no parent context', () => {
    const plan = planLocators({ actionType: 'click', selectors: ['role=button[name="Go"]'], anchor: { role: 'button', name: 'Go', frame: [] } });
    expect(plan[0].description).toBe("getByRole('button', { name: 'Go', exact: true })");
    expect(plan[0].scope).toBeUndefined();
  });

  it('never emits first() or nth, and keeps a step without anchor to its selectors', () => {
    const plan = planLocators({ actionType: 'click', selectors: ['#a', 'text="B"'] });
    expect(plan.map((c) => c.description)).toEqual(['#a', 'text="B"']);
    expect(JSON.stringify(plan)).not.toMatch(/\.first|nth\(/);
  });

  it('applies the selectors inside the row found by the Variable, never the recorded row text', () => {
    const step: StepLike = {
      actionType: 'click',
      selectors: ['role=button[name="Delete"]', 'table > tbody > tr:nth-of-type(2) > td > button'],
      anchor: { role: 'button', name: 'Delete', parent: { kind: 'region', name: 'Ada Lovelace ada@example.com' }, frame: [] },
      rowBinding: { container: { kind: 'row' }, key: { text: 'Ada' }, variable: 'customer' },
    };
    const plan = planLocators(step, { customer: 'Grace' });
    expect(plan.every((c) => c.inRow === true)).toBe(true);
    expect(plan.map((c) => c.description)).toEqual([
      "getByRole('button', { name: 'Delete', exact: true }) in the row containing 'Grace'",
      "role=button[name=\"Delete\"] in the row containing 'Grace'",
    ]);
    expect(JSON.stringify(plan)).not.toContain('Ada');
  });

  it('refuses to guess the row when the Variable that selects it has no value and the binding has no recorded key', () => {
    const plan = planLocators(
      { actionType: 'click', selectors: ['role=button[name="Delete"]'], rowBinding: { container: {}, variable: 'customer' } },
      {}
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].unusable).toMatch(/ROW_VARIABLE_MISSING/);
  });

  it('names the option from the Payload value and drops the recorded selectors that embed the old name', () => {
    const step: StepLike = {
      actionType: 'click',
      variable: 'plan',
      selectors: ['role=listbox[name="Plan options"] >> role=option[name="Pro"]'],
      anchor: { role: 'option', name: 'Pro', parent: { kind: 'region', name: 'Plan options' }, frame: [] },
    };
    const plan = planLocators(step, { plan: 'Free' });
    expect(plan).toHaveLength(1);
    expect(plan[0].role).toEqual({ role: 'option', name: 'Free', exact: true });
    expect(planLocators(step, {})[0].role?.name).toBe('Pro');
  });

  it('plans nothing for a page switch', () => {
    expect(planLocators({ actionType: 'switch_page', selectors: [], anchor: { role: 'document', name: 'x', frame: [], popup: { page: 1, opens: true } } })).toEqual([]);
  });
});

describe('decideCandidate', () => {
  it('takes the first candidate that matches exactly one element', () => {
    expect(decideCandidate([{ count: 1 }, { count: 1 }], 0)).toBe(0);
  });
  it('waits for a better candidate before falling back, then takes the lower one', () => {
    expect(decideCandidate([{ count: 0 }, { count: 1 }], 0)).toBeUndefined();
    expect(decideCandidate([{ count: 0 }, { count: 1 }], 1000)).toBe(1);
  });
  it('never takes an ambiguous, failed or unusable candidate', () => {
    expect(decideCandidate([{ count: 2 }, { count: 1, failed: true }, { count: 1, unusable: true }], 5000)).toBeUndefined();
  });
});

describe('secrets and values', () => {
  const step: StepLike = { actionType: 'type', selectors: [], secretRef: 'PASSWORD' };
  it('reads the secret from DAEMONIZE_SECRET_<NAME>', () => {
    expect(resolveStepValue(step, {}, { DAEMONIZE_SECRET_PASSWORD: 's3cret' })).toBe('s3cret');
  });
  it('names the missing variable and never a value', () => {
    expect(missingSecrets([step], {})).toEqual(['DAEMONIZE_SECRET_PASSWORD']);
    expect(() => resolveStepValue(step, {}, {})).toThrow(MissingSecretError);
    expect(() => resolveStepValue(step, {}, { DAEMONIZE_SECRET_PASSWORD: '' })).toThrow(/DAEMONIZE_SECRET_PASSWORD/);
  });
  it('takes a Variable from the Payload, else the recorded value', () => {
    const v: StepLike = { actionType: 'type', selectors: [], variable: 'q', value: 'cats' };
    expect(resolveStepValue(v, { q: 'dogs' }, {})).toBe('dogs');
    expect(resolveStepValue(v, {}, {})).toBe('cats');
  });
});

describe('describeFailure', () => {
  it('reports the step, the locators tried, the risk and the reason, without the secret or the call log', () => {
    const failure = describeFailure({
      stepIndex: 2,
      step: { actionType: 'type', selectors: [], label: 'type Password', risk: 'write' },
      tried: ['getByRole(...)', 'css: input'],
      reason: 'locator.fill("hunter2") timed out\nCall log:\n  - fill("hunter2")',
      screenshot: '/tmp/x.png',
      secrets: ['hunter2'],
    });
    expect(failure).toEqual({
      stepIndex: 2,
      label: 'type Password',
      action: 'type',
      risk: 'write',
      tried: ['getByRole(...)', 'css: input'],
      reason: 'locator.fill("***") timed out',
      screenshot: '/tmp/x.png',
    });
    expect(failureResult(failure, 5)).toMatchObject({ success: false, drifted: true, error: 'step_failed', elapsedMs: 5 });
  });
});

describe('runStepsStrict', () => {
  it('stops at the first failing step and starts no later one', async () => {
    const ran: number[] = [];
    const steps: StepLike[] = [0, 1, 2, 3].map(() => ({ actionType: 'click', selectors: ['#a'] }));
    const outcome = await runStepsStrict(steps, async (_s, i) => {
      ran.push(i);
      if (i === 1) throw new StepExecutionError(['#a'], 'no element matched');
    });
    expect(ran).toEqual([0, 1]);
    expect(outcome).toMatchObject({ ok: false, stepIndex: 1, tried: ['#a'], reason: 'no element matched' });
  });
});

describe('frameHintSelector', () => {
  it('prefers the name, then the title, then the source', () => {
    expect(frameHintSelector({ name: 'child', title: 't' })).toBe('iframe[name="child"], frame[name="child"]');
    expect(frameHintSelector({ title: 'Search "frame"' })).toBe('iframe[title="Search \\"frame\\""], frame[title="Search \\"frame\\""]');
    expect(frameHintSelector({ src: '/a.html' })).toContain('[src="/a.html"]');
    expect(frameHintSelector({})).toBeUndefined();
  });
});

describe('step-plan.ts as a generated file', () => {
  it('imports no src/ module, only its sibling runtime module', () => {
    const source = readFileSync(new URL('../../src/replay/runtime/step-plan.ts', import.meta.url), 'utf-8');
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['./row-resolver.js', './totp.js']);
  });
});
