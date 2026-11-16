import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  boxesIntersect,
  buildIntent,
  fitSize,
  normalizeRect,
  padClip,
  thumbnailRelativePath,
  MAX_THUMBNAIL_HEIGHT,
  MAX_THUMBNAIL_WIDTH,
} from '../../src/recorder/visual-anchor.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';

const RUNS = { numRuns: 300 };
const EPS = 1e-9;

const viewportArb = fc.record({ width: fc.integer({ min: 1, max: 8000 }), height: fc.integer({ min: 1, max: 8000 }) });
const coord = fc.double({ min: -20000, max: 20000, noNaN: true });
const sizeArb = fc.double({ min: -20000, max: 20000, noNaN: true });
const boxArb = fc.record({ x: coord, y: coord, width: sizeArb, height: sizeArb });
// Boxes entirely inside a viewport
const insideArb = viewportArb.chain((viewport) =>
  fc
    .record({
      x: fc.double({ min: 0, max: viewport.width, noNaN: true }),
      y: fc.double({ min: 0, max: viewport.height, noNaN: true }),
      fw: fc.double({ min: 0, max: 1, noNaN: true }),
      fh: fc.double({ min: 0, max: 1, noNaN: true }),
    })
    .map(({ x, y, fw, fh }) => ({
      viewport,
      box: { x, y, width: (viewport.width - x) * fw, height: (viewport.height - y) * fh },
    }))
);
const weirdNumber = fc.constantFrom(NaN, Infinity, -Infinity);

describe('Property 17: visual anchor rects stay within [0,1]', () => {
  // Feature: daemonize, Property 17: visual anchor rects stay within [0,1]
  it('normalizeRect always returns coordinates in [0,1] with x+w<=1 and y+h<=1', () => {
    fc.assert(
      fc.property(boxArb, viewportArb, (box, viewport) => {
        const r = normalizeRect(box, viewport);
        for (const v of [r.x, r.y, r.w, r.h]) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        expect(r.x + r.w).toBeLessThanOrEqual(1 + EPS);
        expect(r.y + r.h).toBeLessThanOrEqual(1 + EPS);
      }),
      RUNS
    );
  });

  // Feature: daemonize, Property 17: visual anchor rects stay within [0,1]
  it('NaN, Infinity and non-positive viewports are neutralised to an empty rect', () => {
    fc.assert(
      fc.property(
        boxArb,
        viewportArb,
        weirdNumber,
        fc.constantFrom('x', 'y', 'width', 'height'),
        fc.constantFrom(0, -5, NaN, Infinity),
        (box, viewport, bad, field, badViewport) => {
          const r = normalizeRect({ ...box, [field]: bad }, viewport);
          for (const v of [r.x, r.y, r.w, r.h]) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
          const axisIsX = field === 'x' || field === 'width';
          if (axisIsX) expect(r).toMatchObject({ x: 0, w: 0 });
          else expect(r).toMatchObject({ y: 0, h: 0 });
          const q = normalizeRect(box, { width: badViewport, height: viewport.height });
          expect(q).toMatchObject({ x: 0, w: 0 });
          expect(q.x + q.w).toBeLessThanOrEqual(1);
        }
      ),
      RUNS
    );
  });

  // Feature: daemonize, Property 17: visual anchor rects stay within [0,1]
  it('a box inside the viewport is preserved (4 decimals)', () => {
    fc.assert(
      fc.property(insideArb, ({ viewport, box }) => {
        const r = normalizeRect(box, viewport);
        const tol = 1e-4 * viewport.width + 1e-6;
        const tolY = 1e-4 * viewport.height + 1e-6;
        expect(Math.abs(r.x * viewport.width - box.x)).toBeLessThanOrEqual(tol);
        expect(Math.abs(r.w * viewport.width - box.width)).toBeLessThanOrEqual(tol);
        expect(Math.abs(r.y * viewport.height - box.y)).toBeLessThanOrEqual(tolY);
        expect(Math.abs(r.h * viewport.height - box.height)).toBeLessThanOrEqual(tolY);
      }),
      RUNS
    );
  });

  // Feature: daemonize, Property 17: visual anchor rects stay within [0,1]
  it('the clamped rect is contained in the box clipped to the viewport; outside boxes give an empty rect', () => {
    fc.assert(
      fc.property(boxArb, viewportArb, (box, viewport) => {
        const r = normalizeRect(box, viewport);
        const tx = 1e-4 + EPS;
        const left = Math.max(0, box.x) / viewport.width;
        const right = Math.min(viewport.width, box.x + Math.max(0, box.width)) / viewport.width;
        const top = Math.max(0, box.y) / viewport.height;
        const bottom = Math.min(viewport.height, box.y + Math.max(0, box.height)) / viewport.height;
        if (r.w > 0) {
          expect(r.x).toBeGreaterThanOrEqual(left - tx);
          expect(r.x + r.w).toBeLessThanOrEqual(right + tx);
        }
        if (r.h > 0) {
          expect(r.y).toBeGreaterThanOrEqual(top - tx);
          expect(r.y + r.h).toBeLessThanOrEqual(bottom + tx);
        }
        // Fully outside (or empty) on an axis: zero size on that axis
        if (right <= left) expect(r.w).toBe(0);
        if (bottom <= top) expect(r.h).toBe(0);
      }),
      RUNS
    );
  });

  // Feature: daemonize, Property 17: visual anchor rects stay within [0,1]
  it('padClip stays inside the viewport and contains the element box clipped to it', () => {
    fc.assert(
      fc.property(boxArb, viewportArb, fc.integer({ min: 0, max: 50 }), (box, viewport, padding) => {
        const c = padClip(box, viewport, padding);
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.width).toBeGreaterThanOrEqual(0);
        expect(c.height).toBeGreaterThanOrEqual(0);
        expect(c.x + c.width).toBeLessThanOrEqual(viewport.width);
        expect(c.y + c.height).toBeLessThanOrEqual(viewport.height);
        const cl = Math.max(0, box.x);
        const cr = Math.min(viewport.width, box.x + Math.max(0, box.width));
        const ct = Math.max(0, box.y);
        const cb = Math.min(viewport.height, box.y + Math.max(0, box.height));
        if (cr > cl && cl < viewport.width) {
          expect(c.x).toBeLessThanOrEqual(cl);
          expect(c.x + c.width).toBeGreaterThanOrEqual(cr);
        }
        if (cb > ct && ct < viewport.height) {
          expect(c.y).toBeLessThanOrEqual(ct);
          expect(c.y + c.height).toBeGreaterThanOrEqual(cb);
        }
        // A visible box intersects its own clip
        if (cr > cl && cb > ct) {
          expect(boxesIntersect(c, { x: cl, y: ct, width: cr - cl, height: cb - ct })).toBe(true);
        }
      }),
      RUNS
    );
  });

  // Feature: daemonize, Property 17: visual anchor rects stay within [0,1]
  it('fitSize fits 160x120, never enlarges and keeps the aspect ratio within rounding', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 5000 }), fc.constantFrom(1, 0.75, 0.5, 0.35), (w, h, factor) => {
        const s = fitSize(w, h, factor);
        expect(s.width).toBeGreaterThanOrEqual(1);
        expect(s.height).toBeGreaterThanOrEqual(1);
        expect(s.width).toBeLessThanOrEqual(MAX_THUMBNAIL_WIDTH);
        expect(s.height).toBeLessThanOrEqual(MAX_THUMBNAIL_HEIGHT);
        expect(s.width).toBeLessThanOrEqual(Math.max(1, w));
        expect(s.height).toBeLessThanOrEqual(Math.max(1, h));
        const scale = Math.min(1, MAX_THUMBNAIL_WIDTH / w, MAX_THUMBNAIL_HEIGHT / h) * factor;
        expect(Math.abs(s.width - w * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(s.height - h * scale)).toBeLessThanOrEqual(1);
      }),
      RUNS
    );
  });

  // Feature: daemonize, Property 17: visual anchor rects stay within [0,1]
  it('thumbnailRelativePath is a stable, contained, injective path', () => {
    const fileName = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,20}$/);
    const fileArb = fc.tuple(fc.array(fileName, { maxLength: 3 }), fileName).map(([dirs, name]) => [...dirs, name].join('/'));
    fc.assert(
      fc.property(fileArb, fc.uuid(), fc.nat(1000), fc.uuid(), fc.nat(1000), (file, id, index, id2, index2) => {
        const p = thumbnailRelativePath(file, id, index);
        expect(p).toBe(thumbnailRelativePath(file, id, index));
        // No traversal: no segment is '.' or '..' (a file name ending in a dot only gives 'a..assets')
        expect(p.split('/').filter((s) => s === '..' || s === '.')).toEqual([]);
        expect(p.startsWith('/')).toBe(false);
        expect(p).not.toMatch(/^[A-Za-z]:/);
        expect(p).not.toContain('\\');
        expect(p.split('/')).toHaveLength(2);
        expect(p.endsWith('.png')).toBe(true);
        if (id !== id2 || index !== index2) expect(thumbnailRelativePath(file, id2, index2)).not.toBe(p);
      }),
      RUNS
    );
  });

  // Feature: daemonize, Property 17: visual anchor rects stay within [0,1]
  it('buildIntent is deterministic and never contains the typed value', () => {
    const word = fc.stringMatching(/^[a-z ]{0,30}$/);
    const secret = fc.hexaString({ minLength: 12, maxLength: 24 }).map((s) => `ZQ${s}QZ`);
    fc.assert(
      fc.property(
        fc.constantFrom('click', 'type', 'select', 'hover', 'keypress', 'scrollIntoView'),
        fc.constantFrom('button', 'textbox', 'combobox', 'link', 'document', ''),
        word,
        word,
        fc.constantFrom('dialog', 'form', 'region'),
        secret,
        fc.boolean(),
        (actionType, role, name, parentName, kind, value, withSecretRef) => {
          const step = {
            actionType,
            anchor: { role, name, parent: { kind, name: parentName }, frame: [] },
            label: name,
            value,
            ...(withSecretRef ? { secretRef: 'PASSWORD' } : {}),
          } as unknown as Parameters<typeof buildIntent>[0];
          const intent = buildIntent(step);
          expect(intent).not.toContain(value);
          expect(buildIntent(step)).toBe(intent);
        }
      ),
      RUNS
    );
  });

  // Feature: daemonize, Property 17: visual anchor rects stay within [0,1]
  it('the workflow JSON schema rejects rects outside [0,1] and valid ones round-trip', () => {
    const rectNum = fc.oneof(
      // JSON cannot represent -0: it comes back as +0, which toEqual treats as a different number. Not a product bug.
      { weight: 3, arbitrary: fc.double({ min: 0, max: 1, noNaN: true }).map((n) => (n === 0 ? 0 : n)) },
      { weight: 1, arbitrary: fc.double({ min: -5, max: 5, noNaN: true }).map((n) => (n === 0 ? 0 : n)) }
    );
    const inside = (v: number) => v >= 0 && v <= 1;
    fc.assert(
      fc.property(fc.record({ x: rectNum, y: rectNum, w: rectNum, h: rectNum }), fc.string(), (rect, intent) => {
        const set: WorkflowSet = {
          version: '1',
          targetType: 'web',
          targetName: 'App',
          startUrl: 'http://localhost/',
          workflows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              label: 'One',
              steps: [{ actionType: 'click', selectors: ['#a'], visual: { rect, intent } }],
              variables: [],
              observedPayloads: [],
            },
          ],
        };
        if (inside(rect.x) && inside(rect.y) && inside(rect.w) && inside(rect.h)) {
          const back = deserializeWorkflowSet(serializeWorkflowSet(set));
          expect(back.workflows[0].steps[0].visual).toEqual({ rect, intent });
        } else {
          expect(() => serializeWorkflowSet(set)).toThrow();
          expect(() => deserializeWorkflowSet(JSON.stringify(set))).toThrow();
        }
      }),
      RUNS
    );
  });
});
