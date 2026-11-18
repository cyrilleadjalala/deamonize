/** Requirements 1.1, 1.2, 1.3, 1.6, 7.2, 10.1 and 10.2: the rules of the new schema fields, one case each. */
import { describe, expect, it } from 'vitest';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { Workflow } from '../../src/types.js';

const ID = '22222222-2222-4222-8222-222222222222';

function file(patch: { workflow?: Record<string, unknown>; variable?: Record<string, unknown>; step?: Record<string, unknown> } = {}): string {
  const workflow = {
    id: ID,
    label: 'Action',
    steps: [{ actionType: 'type', selectors: ['input'], variable: 'nickname', value: 'x', ...patch.step }],
    variables: [{ name: 'nickname', optional: true, ...patch.variable }],
    observedPayloads: [],
    ...patch.workflow,
  };
  return JSON.stringify({ version: '1', targetType: 'web', targetName: 'app', startUrl: 'https://app.test/', workflows: [workflow] });
}

function load(patch: Parameters<typeof file>[0]): Workflow {
  return deserializeWorkflowSet(file(patch)).workflows[0];
}

function message(patch: Parameters<typeof file>[0]): string {
  try {
    deserializeWorkflowSet(file(patch));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the file was accepted');
}

describe('whenOmitted (Requirements 1.1, 1.2, 1.3)', () => {
  it('accepts useRecorded and skip with optional: true', () => {
    expect(load({ variable: { whenOmitted: 'useRecorded' } }).variables[0].whenOmitted).toBe('useRecorded');
    expect(load({ variable: { whenOmitted: 'skip' } }).variables[0].whenOmitted).toBe('skip');
  });

  for (const bad of [null, '', 'Skip', 'USERECORDED', 'error', 1, true, ['skip']]) {
    it(`refuses whenOmitted ${JSON.stringify(bad)} and names the workflow and the Variable`, () => {
      const text = message({ variable: { whenOmitted: bad } });
      expect(text).toContain(ID);
      expect(text).toContain('nickname');
    });
  }

  it('refuses whenOmitted without optional, or with optional: false', () => {
    const noOptional = message({ variable: { optional: undefined, whenOmitted: 'skip' } });
    expect(noOptional).toContain(ID);
    expect(noOptional).toContain('nickname');
    expect(message({ variable: { optional: false, whenOmitted: 'skip' } })).toContain('nickname');
  });
});

describe('description (Requirement 1.6)', () => {
  it('accepts 0, 1000 characters, and refuses 1001 and a non-string', () => {
    expect(load({ workflow: { description: '' } }).description).toBe('');
    expect(load({ workflow: { description: 'a'.repeat(1000) } }).description).toHaveLength(1000);
    expect(message({ workflow: { description: 'a'.repeat(1001) } })).toContain(ID);
    expect(message({ workflow: { description: 12 } })).toContain(ID);
    expect(message({ workflow: { description: null } })).toContain(ID);
  });
});

describe('check step (Requirement 7.2)', () => {
  it('accepts the values "true" and "false"', () => {
    expect(load({ step: { actionType: 'check', value: 'true', variable: undefined } }).steps[0].actionType).toBe('check');
    expect(load({ step: { actionType: 'check', value: 'false', variable: undefined } }).steps[0].value).toBe('false');
  });

  for (const bad of ['True', 'yes', '', '1']) {
    it(`refuses the check value ${JSON.stringify(bad)}`, () => {
      expect(message({ step: { actionType: 'check', value: bad, variable: undefined } })).toContain(ID);
    });
  }

  it('refuses a check step without value', () => {
    expect(message({ step: { actionType: 'check', value: undefined, variable: undefined } })).toContain('check');
  });
});

describe('workflow startUrl and storageState (Requirements 10.1, 10.2)', () => {
  it('accepts an http or https address, a path and null', () => {
    expect(load({ workflow: { startUrl: 'http://app.test/b' } }).startUrl).toBe('http://app.test/b');
    expect(load({ workflow: { startUrl: 'https://app.test/b?x=1' } }).startUrl).toBe('https://app.test/b?x=1');
    expect(load({ workflow: { storageState: 'login.json' } }).storageState).toBe('login.json');
    expect(load({ workflow: { storageState: null } }).storageState).toBeNull();
  });

  for (const bad of ['', 'ftp://app.test/', '/relative', 'app.test', 'https://', 'javascript:alert(1)', 5, null]) {
    it(`refuses startUrl ${JSON.stringify(bad)} with the workflow id and the field`, () => {
      const text = message({ workflow: { startUrl: bad } });
      expect(text).toContain(ID);
      expect(text).toContain('startUrl');
    });
  }

  for (const bad of ['', 5, true, {}]) {
    it(`refuses storageState ${JSON.stringify(bad)} with the workflow id and the field`, () => {
      const text = message({ workflow: { storageState: bad } });
      expect(text).toContain(ID);
      expect(text).toContain('storageState');
    });
  }

  it('refuses a startUrl of 2049 characters and a storageState of 1025', () => {
    expect(message({ workflow: { startUrl: `https://app.test/${'a'.repeat(2040)}` } })).toContain('startUrl');
    expect(message({ workflow: { storageState: 'a'.repeat(1025) } })).toContain('storageState');
  });

  it('writes back what it loaded', () => {
    const set = deserializeWorkflowSet(file({ workflow: { startUrl: 'https://app.test/b', storageState: null, description: 'Find a customer' } }));
    expect(JSON.parse(serializeWorkflowSet(set)).workflows[0]).toMatchObject({ startUrl: 'https://app.test/b', storageState: null, description: 'Find a customer' });
  });
});
