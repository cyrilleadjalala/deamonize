import type { Workflow, WorkflowSet } from '../types.js';

/**
 * Merge two Workflow sets: keep the union of their Workflows; when both hold a
 * Workflow with the same id, the one from `newer` replaces the one from `base`
 * at the position of the base one, and new Workflows are appended.
 * When at least one base Workflow survives (is not replaced), `targetName`, `startUrl` and `storageState` come
 * from `base` (a field absent from `base` stays absent), so earlier Workflows keep their start page and login.
 * Otherwise they come from `newer`. Neither input is mutated.
 */
export function mergeWorkflowSets(base: WorkflowSet, newer: WorkflowSet): WorkflowSet {
  const replaced = new Set(newer.workflows.map((workflow) => workflow.id));
  const keepsBase = base.workflows.some((workflow) => !replaced.has(workflow.id));

  const byId = new Map<string, Workflow>();
  for (const workflow of [...base.workflows, ...newer.workflows]) {
    byId.set(workflow.id, structuredClone(workflow));
  }
  const merged: WorkflowSet = { ...structuredClone(newer), workflows: [...byId.values()] };

  if (keepsBase) {
    merged.targetName = base.targetName;
    if (base.startUrl === undefined) delete merged.startUrl;
    else merged.startUrl = base.startUrl;
    if (base.storageState === undefined) delete merged.storageState;
    else merged.storageState = base.storageState;
  }
  return merged;
}
