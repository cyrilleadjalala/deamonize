import { describe, it, expect } from 'vitest';
import { buildRequest, withRecordedDefaults, planSteps, type HttpRecipeLike } from '../../src/replay/runtime/http-replay.js';
import { buildRowLocator, RowResolutionError } from '../../src/replay/runtime/row-resolver.js';
import { planLocators, healEligible, type StepLike } from '../../src/replay/runtime/step-plan.js';

const recipe: HttpRecipeLike = {
  method: 'POST',
  url: 'https://api.example.com/users/{{id}}/items',
  query: { q: '{{term}}', page: '1' },
  headers: { 'x-trace': 'abc', authorization: { $secret: 'TOKEN' } },
  body: { name: { $var: 'name' }, nested: { tags: ['a', { $var: 'tag' }] }, fixed: 1 },
  bodyFormat: 'json',
};
const variables = { id: 'u 1', term: 'hello world', name: 'Ada', tag: 'x' };
const env = { DAEMONIZE_SECRET_TOKEN: 'tok-123456' };

describe('replay runtime compatibility (no skipped set)', () => {
  it('buildRequest gives the same request with no, undefined or empty skipped set', () => {
    const old = buildRequest(recipe, variables, env);
    expect(old.url).toBe('https://api.example.com/users/u%201/items?q=hello+world&page=1');
    expect(old.headers['authorization']).toBe('tok-123456');
    expect(old.headers['content-type']).toBe('application/json');
    expect(old.body).toBe(JSON.stringify({ name: 'Ada', nested: { tags: ['a', 'x'] }, fixed: 1 }));
    expect(buildRequest(recipe, variables, env, undefined)).toEqual(old);
    expect(buildRequest(recipe, variables, env, new Set())).toEqual(old);
  });

  it('withRecordedDefaults gives the same defaults with no or empty skipped set', () => {
    const steps = [{ variable: 'a', value: '1' }, { variable: 'b', value: '2' }, { value: 'z' }];
    const old = withRecordedDefaults(steps, { b: 'given', c: 3 });
    expect(old).toEqual({ a: '1', b: 'given', c: 3 });
    expect(withRecordedDefaults(steps, { b: 'given', c: 3 }, new Set())).toEqual(old);
  });

  it('a click on a checkbox and a radio click without a Variable plan and locate as before', () => {
    const checkbox: StepLike = { actionType: 'click', selectors: ['#news'], anchor: { role: 'checkbox', name: 'Newsletter' } };
    const radio: StepLike = { actionType: 'click', selectors: ['#s'], anchor: { role: 'radio', name: 'Small' } };
    expect(planLocators(checkbox)[0].description).toBe("getByRole('checkbox', { name: 'Newsletter', exact: true })");
    expect(planLocators(radio)[0].description).toBe("getByRole('radio', { name: 'Small', exact: true })");
    expect(planLocators(radio).map((c) => c.description)).toContain('#s');
    expect(healEligible(checkbox, 'heal')).toBe(true);
    expect(planSteps([{ actionType: 'click' }, { actionType: 'type' }])).toEqual(['ui', 'ui']);
  });

  it('a row binding with a Variable still uses its value and still fails when it has none and no recorded key', () => {
    const binding = { container: { kind: 'row' as const }, key: { text: 'Ada' }, variable: 'customer' };
    expect(buildRowLocator(binding, { customer: 'Grace' }).hasText).toBe('Grace');
    expect(() => buildRowLocator({ ...binding, key: undefined }, {})).toThrow(RowResolutionError);
    expect(() => buildRowLocator({ ...binding, key: { text: '  ' } }, {})).toThrow(/ROW_VARIABLE_MISSING/);
  });
});
