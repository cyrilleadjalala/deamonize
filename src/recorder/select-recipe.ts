/**
 * Choice of the Level 1 recipe of a step among the requests captured after its action.
 * Pure (no Playwright), so it can be unit tested.
 */

/** The part of a recipe attempt the choice needs. */
export interface RecipeCandidate {
  recipe?: { method: string };
  /** Variables found in the request. */
  bound: readonly string[];
}

export function isWrite(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD';
}

/** Candidates that have a recipe and carry every variable the step used. */
function eligible<T extends RecipeCandidate>(attempts: readonly T[], used: readonly string[]): T[] {
  return attempts.filter((a) => a.recipe !== undefined && used.every((name) => a.bound.includes(name)));
}

/** A GET/HEAD that binds no variable, seen after a submit step: a refresh of the next screen, not the action. */
export function isFollowUpRead(a: RecipeCandidate, submit: boolean): boolean {
  return submit && a.recipe !== undefined && !isWrite(a.recipe.method) && a.bound.length === 0;
}

/** The attempts dropped as follow-up reads of a submit step. */
export function followUpReads<T extends RecipeCandidate>(
  attempts: readonly T[],
  opts: { submit: boolean; used?: readonly string[] },
): T[] {
  return eligible(attempts, opts.used ?? []).filter((a) => isFollowUpRead(a, opts.submit));
}

/**
 * Pick the recipe of a step. Order: a write method first (submit steps only), then more bound variables,
 * then the earliest request. A GET/HEAD binding nothing is dropped for a submit step.
 */
export function selectRecipe<T extends RecipeCandidate>(
  attempts: readonly T[],
  opts: { submit: boolean; used?: readonly string[] },
): T | undefined {
  const { submit } = opts;
  const candidates = eligible(attempts, opts.used ?? []).filter((a) => !isFollowUpRead(a, submit));
  let best: T | undefined;
  for (const a of candidates) {
    if (best === undefined) {
      best = a;
      continue;
    }
    const aw = isWrite(a.recipe!.method);
    const bw = isWrite(best.recipe!.method);
    if (submit && aw !== bw) {
      if (aw) best = a;
      continue;
    }
    if (a.bound.length > best.bound.length) best = a;
  }
  return best;
}
