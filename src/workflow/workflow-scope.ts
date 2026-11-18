import type { Workflow, WorkflowSet } from '../types.js';

/** A message for the refusal of 3.7: a Variable that may be skipped cannot be part of a recorded URL path. */
export const SKIP_IN_PATH_MESSAGE = (workflowId: string, variable: string): string =>
  `Workflow ${workflowId}: the optional variable "${variable}" is part of a recorded URL path, so it cannot be skipped. Make it required, or use the recorded value.`;

/** Names with optional: true and whenOmitted: 'skip', once each, in workflow order. */
export function skipListOf(workflow: Pick<Workflow, 'variables'>): string[] {
  const names: string[] = [];
  for (const variable of workflow.variables ?? []) {
    if (variable.optional === true && variable.whenOmitted === 'skip' && !names.includes(variable.name)) names.push(variable.name);
  }
  return names;
}

/** The first Skip_List Variable bound in a recipe path (`bindings[].in === 'path'`), if any. */
export function findSkippedPathBinding(workflow: Workflow): { stepIndex: number; variable: string } | undefined {
  const skip = new Set(skipListOf(workflow));
  if (skip.size === 0) return undefined;
  const steps = workflow.steps ?? [];
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    for (const binding of steps[stepIndex].http?.bindings ?? []) {
      if (binding.in === 'path' && skip.has(binding.variable)) return { stepIndex, variable: binding.variable };
    }
  }
  return undefined;
}

export function startUrlOf(set: Pick<WorkflowSet, 'startUrl'>, workflow: Pick<Workflow, 'startUrl'>): string | undefined {
  return workflow.startUrl ?? set.startUrl;
}

/** undefined: no login. */
export function storageStateOf(set: Pick<WorkflowSet, 'storageState'>, workflow: Pick<Workflow, 'storageState'>): string | undefined {
  if (workflow.storageState === null) return undefined;
  return workflow.storageState ?? set.storageState;
}

/** `new URL(url).origin`, undefined when the text is not an address. */
export function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Compile-time check of 10.10 and 10.11: a message, or undefined when the set is fine. */
export function validateWorkflowScopes(set: WorkflowSet): string | undefined {
  for (const workflow of set.workflows ?? []) {
    if (workflow.startUrl === undefined) continue;
    if (set.startUrl === undefined) {
      return `Workflow ${workflow.id}: a start page applies to a web target only.`;
    }
    const own = originOf(workflow.startUrl);
    const held = originOf(set.startUrl);
    if (own !== held) {
      return `Workflow ${workflow.id}: its start page is on ${own ?? workflow.startUrl} but the file is for ${held ?? set.startUrl}. All actions of a file must be on the same origin.`;
    }
  }
  return undefined;
}

/** True when generated code needs the `call` parameter: some workflow has a Skip_List, a startUrl or a storageState. */
export function usesWorkflowCall(set: WorkflowSet): boolean {
  return (set.workflows ?? []).some(
    (workflow) => skipListOf(workflow).length > 0 || workflow.startUrl !== undefined || workflow.storageState !== undefined,
  );
}
