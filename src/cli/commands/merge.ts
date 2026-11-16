import { readFile, writeFile } from 'node:fs/promises';
import {
  deserializeWorkflowSet,
  mergeWorkflowSets,
  serializeWorkflowSet,
} from '../../workflow/workflow-set.js';
import { adoptAssets, pruneAssets } from '../../recorder/visual-anchor.js';

/**
 * Merge two Workflow set files into `out`. When both hold a workflow with
 * the same id, the one from `newerFile` wins. The thumbnails of the workflows
 * kept are copied next to `out`, and those of the replaced ones are removed from it.
 * Returns the number of workflows kept.
 */
export async function merge(baseFile: string, newerFile: string, out: string): Promise<number> {
  const base = deserializeWorkflowSet(await readFile(baseFile, 'utf-8'));
  const newer = deserializeWorkflowSet(await readFile(newerFile, 'utf-8'));
  const merged = mergeWorkflowSets(base, newer);

  const fromNewer = new Set(newer.workflows.map((w) => w.id));
  await adoptAssets(merged.workflows.filter((w) => !fromNewer.has(w.id)), baseFile, out);
  await adoptAssets(merged.workflows.filter((w) => fromNewer.has(w.id)), newerFile, out);

  await writeFile(out, serializeWorkflowSet(merged));
  await pruneAssets(out);
  return merged.workflows.length;
}
