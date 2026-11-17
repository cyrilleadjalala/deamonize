import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { selectRecipe, isWrite, type RecipeCandidate } from '../../src/recorder/select-recipe.js';
import { isDevInternalUrl, isStaticUrl } from '../../src/recorder/network-capture.js';

interface A extends RecipeCandidate {
  idx: number;
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const VARS = ['a', 'b', 'c'];

const attemptsArb = fc
  .array(
    fc.record({
      method: fc.constantFrom(...METHODS),
      bound: fc.subarray(VARS),
      hasRecipe: fc.boolean(),
    }),
    { maxLength: 8 },
  )
  .map((list): A[] =>
    list.map((x, idx) => ({ idx, bound: x.bound, ...(x.hasRecipe ? { recipe: { method: x.method } } : {}) })),
  );

/** The original reduce of finalizeNetwork. */
function originalPick(attempts: A[], used: string[]): A | undefined {
  return attempts
    .filter((a) => a.recipe !== undefined && used.every((n) => a.bound.includes(n)))
    .reduce<A | undefined>((best, a) => (best === undefined || a.bound.length >= best.bound.length ? a : best), undefined);
}

const devUrlArb = fc.oneof(
  fc.hexaString({ minLength: 1, maxLength: 12 }).map((h) => `http://localhost:3000/_next/static/webpack/${h}.webpack.hot-update.json`),
  fc.constantFrom('/_next/webpack-hmr', '/__nextjs_original-stack-frame', '/__webpack_hmr', '/@vite/client', '/sockjs-node/info').map(
    (p) => `http://localhost:3000${p}`,
  ),
);

describe('nextjs-spa-replay-fixes: recipe selection', () => {
  // Feature: nextjs-spa-replay-fixes, Property 5: Bug Condition - The recorded recipe is the right request
  it('Property 5: first of the best group, write preferred and no unbound GET for a submit step', () => {
    fc.assert(
      fc.property(attemptsArb, (attempts) => {
        const picked = selectRecipe(attempts, { submit: true });
        const cands = attempts.filter((a) => a.recipe !== undefined && (isWrite(a.recipe.method) || a.bound.length > 0));
        if (cands.length === 0) return picked === undefined;
        if (picked === undefined) return false;
        const writes = cands.filter((a) => isWrite(a.recipe!.method));
        const pool = writes.length > 0 ? writes : cands;
        const max = Math.max(...pool.map((a) => a.bound.length));
        const first = pool.find((a) => a.bound.length === max);
        return picked.idx === first!.idx;
      }),
    );
  });

  // Feature: nextjs-spa-replay-fixes, Property 5: Bug Condition - dev URLs are never captured
  it('Property 5: dev/HMR urls are filtered', () => {
    fc.assert(fc.property(devUrlArb, (url) => isDevInternalUrl(url) && isStaticUrl(url)));
  });

  // Feature: nextjs-spa-replay-fixes, Property 6: Preservation - Other requests and risks are recorded as before
  it('Property 6: non-submit steps without a tie pick like the original', () => {
    fc.assert(
      fc.property(attemptsArb, fc.subarray(VARS), (attempts, used) => {
        const qualifying = attempts.filter((a) => a.recipe !== undefined && used.every((n) => a.bound.includes(n)));
        const ranks = qualifying.map((a) => a.bound.length);
        const max = Math.max(...ranks, -1);
        fc.pre(ranks.filter((r) => r === max).length <= 1);
        expect(selectRecipe(attempts, { submit: false, used })?.idx).toBe(originalPick(attempts, used)?.idx);
      }),
    );
  });

  // Feature: nextjs-spa-replay-fixes, Property 6: Preservation - one qualifying request is chosen
  it('Property 6: a single qualifying request is chosen', () => {
    fc.assert(
      fc.property(fc.constantFrom('GET', 'POST'), fc.constantFrom('a', 'b'), (method, v) => {
        const only: A = { idx: 0, bound: [v], recipe: { method } };
        expect(selectRecipe([only], { submit: true, used: [v] })).toBe(only);
        expect(selectRecipe([only], { submit: false, used: [v] })).toBe(only);
      }),
    );
  });
});
