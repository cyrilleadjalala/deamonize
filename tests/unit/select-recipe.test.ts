import { describe, it, expect } from 'vitest';
import { selectRecipe, type RecipeCandidate } from '../../src/recorder/select-recipe.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import type { HttpRecipe } from '../../src/types.js';

interface A extends RecipeCandidate {
  id: string;
}
const a = (id: string, method: string, bound: string[] = [], recipe = true): A => ({
  id,
  bound,
  ...(recipe ? { recipe: { method } } : {}),
});

describe('selectRecipe: bug condition (Property 5)', () => {
  it('keeps the POST of a login verify over a later GET refresh (both bind nothing)', () => {
    const picked = selectRecipe([a('verify', 'POST'), a('settings', 'GET')], { submit: true });
    expect(picked?.id).toBe('verify');
  });

  it('keeps the first of equal ranks for a non-submit step', () => {
    expect(selectRecipe([a('one', 'GET'), a('two', 'GET')], { submit: false })?.id).toBe('one');
  });

  it('prefers a write over a later GET that binds a variable on a submit step', () => {
    const picked = selectRecipe([a('post', 'POST', ['x']), a('get', 'GET', ['x'])], { submit: true });
    expect(picked?.id).toBe('post');
  });

  it('drops an unbound GET for a submit step (no recipe)', () => {
    expect(selectRecipe([a('get', 'GET')], { submit: true })).toBeUndefined();
  });
});

describe('selectRecipe: preservation (Property 6)', () => {
  it('chooses the only qualifying request', () => {
    expect(selectRecipe([a('x', 'GET', ['q']), a('y', 'GET', [], false)], { submit: false })?.id).toBe('x');
  });

  it('chooses a higher rank, even when later or earlier', () => {
    expect(selectRecipe([a('low', 'GET'), a('high', 'GET', ['q', 'r'])], { submit: false })?.id).toBe('high');
    expect(selectRecipe([a('high', 'GET', ['q', 'r']), a('low', 'GET')], { submit: false })?.id).toBe('high');
  });

  it('keeps a GET that binds a variable on a submit step (search form)', () => {
    expect(selectRecipe([a('search', 'GET', ['q'])], { submit: true, used: ['q'] })?.id).toBe('search');
  });

  it('requires the used variables to be bound', () => {
    expect(selectRecipe([a('x', 'GET', ['q'])], { submit: false, used: ['q', 'z'] })).toBeUndefined();
  });
});

describe('setHttp risk', () => {
  const recipe = (method: HttpRecipe['method']): HttpRecipe =>
    ({ method, url: 'http://x/api', expectStatus: 200 }) as HttpRecipe;
  const stepRecorder = (risk: 'read' | 'write') => {
    const r = new WorkflowRecorder('w');
    r.addStep({ actionType: 'click', selectors: ['button'], risk });
    return r;
  };

  it('keeps a write step at write with a GET recipe', () => {
    const r = stepRecorder('write');
    r.setHttp(0, recipe('GET'), 'read');
    expect(r.stepsSoFar()[0].risk).toBe('write');
  });

  it('raises a read step to write for a POST recipe', () => {
    const r = stepRecorder('read');
    r.setHttp(0, recipe('POST'), 'write');
    expect(r.stepsSoFar()[0].risk).toBe('write');
  });
});
