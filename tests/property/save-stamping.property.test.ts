// Feature: user-journey-improvements, Property 21: Saving stamps only what differs
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveWorkflow } from '../../src/cli/commands/save-workflow.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { startUrlOf, storageStateOf } from '../../src/workflow/workflow-scope.js';
import { workflowSetArb } from '../helpers/workflow-arbitraries.js';
import type { Workflow } from '../../src/types.js';

const ORIGIN = 'https://app.example.com';
const stateArb = fc.option(fc.constantFrom('a.json', 'b.json'), { nil: undefined });
const pathArb = fc.constantFrom('', 'x', 'y/z');

function fresh(id: string): Workflow {
  return { id, label: 'Recorded', steps: [{ actionType: 'click', selectors: ['role=button[name="Go"]'] }], variables: [], observedPayloads: [] };
}

describe('Property 21: Saving stamps only what differs', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'save-stamping-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stamps startUrl and storageState only when they differ from the base, and refuses another origin', async () => {
    // **Validates: Requirements 11.3, 11.4, 11.5, 11.6, 11.7**
    let n = 0;
    await fc.assert(
      fc.asyncProperty(workflowSetArb(ORIGIN), pathArb, stateArb, stateArb, fc.boolean(), fc.boolean(), async (base, path, baseState, state, foreign, same) => {
        if (baseState === undefined) delete base.storageState;
        else base.storageState = baseState;
        const out = join(dir, `f${n++}.json`);
        const text = serializeWorkflowSet(base);
        await writeFile(out, text);

        const startUrl = foreign ? 'https://other.example.org/' : same ? ORIGIN : `${ORIGIN}/${path}`;
        const recordedState = state;
        const id = '99999999-9999-4999-8999-999999999999';
        const run = saveWorkflow(out, { targetType: 'web', name: 'x', startUrl, storageState: recordedState }, fresh(id));

        if (foreign) {
          await expect(run).rejects.toThrow(/https:\/\/app\.example\.com.*https:\/\/other\.example\.org/);
          await run.catch((e: Error) => expect(e.message).not.toContain(dir));
          expect(await readFile(out, 'utf-8')).toBe(text);
          return;
        }
        await run;
        const after = deserializeWorkflowSet(await readFile(out, 'utf-8'));
        const added = after.workflows.find((w) => w.id === id)!;
        // base workflows never share the fixed id, so a base workflow always survives
        if (startUrl !== base.startUrl) expect(added.startUrl).toBe(startUrl);
        else expect('startUrl' in added).toBe(false);
        if (recordedState !== base.storageState) expect(added.storageState).toBe(recordedState ?? null);
        else expect('storageState' in added).toBe(false);
        expect(startUrlOf(after, added)).toBe(startUrl);
        expect(storageStateOf(after, added)).toBe(recordedState);
      }),
      { numRuns: 100 },
    );
  });
});
