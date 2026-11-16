import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  boxesIntersect,
  buildIntent,
  fitSize,
  normalizeRect,
  padClip,
  pruneAssets,
  thumbnailRelativePath,
} from '../../src/recorder/visual-anchor.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const viewport = { width: 1000, height: 500 };

describe('buildIntent', () => {
  it('describes a click with its role, name and enclosing dialog', () => {
    const anchor = { role: 'button', name: 'Save', parent: { kind: 'dialog' as const, name: 'Edit customer' }, frame: [] };
    expect(buildIntent({ actionType: 'click', anchor })).toBe("Click the button 'Save' in the dialog 'Edit customer'");
  });

  it('describes typing, selecting and hovering', () => {
    expect(buildIntent({ actionType: 'type', anchor: { role: 'textbox', name: 'Email', frame: [] } })).toBe("Type into the field 'Email'");
    expect(buildIntent({ actionType: 'select', anchor: { role: 'combobox', name: 'Plan', frame: [] } })).toBe(
      "Select an option in the combobox 'Plan'"
    );
    expect(buildIntent({ actionType: 'hover', anchor: { role: 'link', name: 'Docs', frame: [] } })).toBe("Hover over the link 'Docs'");
  });

  it('falls back to the label when the step has no anchor, and never mentions a value', () => {
    expect(buildIntent({ actionType: 'click', label: 'click Save' })).toBe('Click the element (click Save)');
  });

  it('shortens a long name', () => {
    const text = buildIntent({ actionType: 'click', anchor: { role: 'button', name: 'x'.repeat(200), frame: [] } });
    expect(text.length).toBeLessThan(100);
  });
});

describe('normalizeRect', () => {
  it('gives fractions of the viewport', () => {
    expect(normalizeRect({ x: 100, y: 50, width: 200, height: 100 }, viewport)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it('cuts the part outside the viewport', () => {
    const rect = normalizeRect({ x: 900, y: -20, width: 300, height: 100 }, viewport);
    expect(rect).toEqual({ x: 0.9, y: 0, w: 0.1, h: 0.16 });
    expect(rect.x + rect.w).toBeLessThanOrEqual(1);
  });

  it('gives a zero size to a box fully outside', () => {
    const rect = normalizeRect({ x: 2000, y: 900, width: 10, height: 10 }, viewport);
    expect(rect).toEqual({ x: 1, y: 1, w: 0, h: 0 });
  });

  it('survives a degenerate viewport', () => {
    expect(normalizeRect({ x: 1, y: 1, width: 1, height: 1 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('thumbnail geometry', () => {
  it('pads the clip and keeps it inside the viewport', () => {
    expect(padClip({ x: 2, y: 100, width: 50, height: 20 }, viewport, 6)).toEqual({ x: 0, y: 94, width: 58, height: 32 });
    expect(padClip({ x: 990, y: 495, width: 50, height: 20 }, viewport, 6)).toEqual({ x: 984, y: 489, width: 16, height: 11 });
  });

  it('fits a clip in 160x120 without enlarging it', () => {
    expect(fitSize(320, 120)).toEqual({ width: 160, height: 60 });
    expect(fitSize(80, 40)).toEqual({ width: 80, height: 40 });
    expect(fitSize(160, 240, 0.5)).toEqual({ width: 40, height: 60 });
  });

  it('detects overlapping boxes', () => {
    expect(boxesIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 5, height: 5 })).toBe(true);
    expect(boxesIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
  });
});

describe('thumbnail paths and pruning', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await removeDir(dir);
    dir = undefined;
  });

  it('builds a path relative to the workflow file', () => {
    expect(thumbnailRelativePath(join('some', 'dir', 'workflows.json'), 'abc', 3)).toBe('workflows.json.assets/step-abc-3.png');
  });

  it('deletes the thumbnails no step references', async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-assets-'));
    const file = join(dir, 'workflows.json');
    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'App',
      startUrl: 'http://localhost/',
      workflows: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          label: 'One',
          steps: [{ actionType: 'click', selectors: ['#a'], visual: { thumbnailPath: 'workflows.json.assets/step-11111111-1111-4111-8111-111111111111-0.png', rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, intent: 'Click' } }],
          variables: [],
          observedPayloads: [],
        },
      ],
    };
    await writeFile(file, serializeWorkflowSet(set));
    await mkdir(join(dir, 'workflows.json.assets'));
    await writeFile(join(dir, 'workflows.json.assets', 'step-11111111-1111-4111-8111-111111111111-0.png'), 'kept');
    await writeFile(join(dir, 'workflows.json.assets', 'step-old-0.png'), 'orphan');

    expect(await pruneAssets(file)).toEqual(['step-old-0.png']);
    expect(await readdir(join(dir, 'workflows.json.assets'))).toEqual(['step-11111111-1111-4111-8111-111111111111-0.png']);
    expect(await readFile(file, 'utf-8')).toContain('step-11111111-1111-4111-8111-111111111111-0.png');
  });
});
