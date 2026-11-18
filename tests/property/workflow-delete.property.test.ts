// Feature: user-journey-improvements, Property 28: Delete keeps the rest
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDelete, cleanAssets, referencedAssets, writeWorkflowFileAtomic } from '../../src/studio/workflow-editor.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { removeDir } from '../helpers/cleanup.js';
import { workflowSetArb } from '../helpers/workflow-arbitraries.js';
import type { WorkflowSet } from '../../src/types.js';

/** Every workflow gets one step with a thumbnail of its own. */
function withThumbnails(set: WorkflowSet): WorkflowSet {
  const next = structuredClone(set);
  next.workflows.forEach((workflow, i) => {
    workflow.steps.push({
      actionType: 'click',
      selectors: ['role=button'],
      visual: { thumbnailPath: `daemonize.workflows.json.assets/shot-${i}.png`, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, intent: 'the button' },
    });
  });
  return next;
}

describe('Property 28: Delete keeps the rest', () => {
  it('removes only the named workflow, keeps every other field, and cleans only unreferenced thumbnails', async () => {
    await fc.assert(
      fc.asyncProperty(workflowSetArb(), fc.nat(), fc.boolean(), async (generated, pick, extraFolder) => {
        const set = withThumbnails(generated);
        const index = pick % set.workflows.length;
        const removed = set.workflows[index];
        const dir = await mkdtemp(join(tmpdir(), 'wf-delete-prop-'));
        try {
          const file = join(dir, 'daemonize.workflows.json');
          await writeWorkflowFileAtomic(file, set);
          const assets = `${file}.assets`;
          await mkdir(assets);
          for (let i = 0; i < set.workflows.length; i += 1) await writeFile(join(assets, `shot-${i}.png`), 'png');
          await writeFile(join(assets, 'notes.txt'), 'keep me');
          if (extraFolder) await mkdir(join(assets, 'folder.png'));
          const before = structuredClone(set);

          const result = applyDelete(set, removed.id);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(set).toEqual(before);
          expect(result.value.removed).toEqual(removed);
          const rest = result.value.set;
          expect(rest.workflows).toEqual(before.workflows.filter((_, i) => i !== index));
          const { workflows: _a, ...restBefore } = before;
          const { workflows: _b, ...restAfter } = rest;
          expect(restAfter).toEqual(restBefore);

          await writeWorkflowFileAtomic(file, rest);
          expect(deserializeWorkflowSet(await readFile(file, 'utf-8'))).toEqual(rest);
          expect(await cleanAssets(file, rest)).toBe('ok');
          const left = new Set(await readdir(assets));
          const referenced = referencedAssets(rest);
          for (let i = 0; i < set.workflows.length; i += 1) expect(left.has(`shot-${i}.png`)).toBe(i !== index);
          expect([...referenced].every((name) => left.has(name))).toBe(true);
          expect(left.has('notes.txt')).toBe(true);
          if (extraFolder) expect(left.has('folder.png')).toBe(true);
          expect((await readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
        } finally {
          await removeDir(dir);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('keeps a loadable file with no workflows after the last one is deleted, and an unknown id changes nothing', () => {
    fc.assert(
      fc.property(workflowSetArb(), (set) => {
        let current = structuredClone(set);
        expect(applyDelete(current, `${current.workflows[0].id}-nope`)).toMatchObject({ ok: false, status: 404 });
        while (current.workflows.length > 0) {
          const result = applyDelete(current, current.workflows[0].id);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          current = result.value.set;
        }
        expect(deserializeWorkflowSet(JSON.stringify(current)).workflows).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
