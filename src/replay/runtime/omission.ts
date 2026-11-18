/**
 * Which steps a call leaves out because the caller omitted an optional Variable.
 * Standalone runtime file: it imports nothing and is copied next to the generated code.
 */
export type SkipList = readonly string[] | undefined;

export interface SkippableStep {
  actionType: string;
  variable?: string;
  secretRef?: string;
  totp?: boolean;
  rowBinding?: { variable?: string };
  http?: unknown;
}

/** `undefined` and `null` only. '' , 0 and false are supplied values. */
export function isOmitted(value: unknown): boolean {
  return value === undefined || value === null;
}

/** The Skip_List names whose argument is omitted. */
export function omittedSkips(args: Record<string, unknown>, skip: SkipList): ReadonlySet<string> {
  const omitted = new Set<string>();
  for (const name of skip ?? []) {
    if (isOmitted((args ?? {})[name])) omitted.add(name);
  }
  return omitted;
}

/**
 * Ascending, unique indexes. A step is skipped when its `variable` or its `rowBinding.variable` is in omittedSkips,
 * unless it has `secretRef`, `totp` or `http` (a step that carries a recipe handles omission through the bindings).
 * Names that no step uses are ignored.
 */
export function planSkips(steps: readonly SkippableStep[], args: Record<string, unknown>, skip: SkipList): number[] {
  const omitted = omittedSkips(args, skip);
  const indexes: number[] = [];
  if (omitted.size === 0) return indexes;
  steps.forEach((step, index) => {
    if (step.secretRef !== undefined || step.totp === true || step.http !== undefined) return;
    const names = [step.variable, step.rowBinding?.variable];
    if (names.some((name) => name !== undefined && omitted.has(name))) indexes.push(index);
  });
  return indexes;
}
