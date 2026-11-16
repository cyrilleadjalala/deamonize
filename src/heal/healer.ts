/**
 * Heal mode, Level 3: ask a vision model where an element is. This file holds only types and pure
 * validation, so it has no network or browser dependency.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** One numbered, visible, interactive element drawn on the screenshot. */
export interface Mark {
  id: number;
  box: Box;
  role?: string;
  name?: string;
  /** A Playwright-style description that resolved to this element, e.g. `getByRole('button', { name: 'Save' })`. */
  locatorHint?: string;
}

export interface HealStep {
  /** Action kind only (click, fill, ...). Never a typed value. */
  action: string;
  role?: string;
  name?: string;
}

export interface HealRequest {
  screenshotPng: Buffer;
  marks: Mark[];
  anchorThumbnailPng?: Buffer;
  intent: string;
  step: HealStep;
  viewport: Viewport;
}

export type HealResult =
  | { kind: 'mark'; markId: number }
  | { kind: 'point'; x: number; y: number }
  | { kind: 'none'; reason: string };

export interface Healer {
  locate(req: HealRequest): Promise<HealResult>;
}

/**
 * Check a model answer against what was offered: a mark id must be one of the marks, a point must be
 * inside the viewport. Anything invalid becomes `none` with the reason.
 */
export function validateHealResult(result: unknown, marks: Mark[], viewport: Viewport): HealResult {
  if (!result || typeof result !== 'object') return { kind: 'none', reason: 'answer is not an object' };
  const r = result as Record<string, unknown>;
  if (r.kind === 'none') {
    return { kind: 'none', reason: typeof r.reason === 'string' && r.reason ? r.reason.slice(0, 200) : 'model found nothing' };
  }
  if (r.kind === 'mark') {
    const id = r.markId;
    if (typeof id !== 'number' || !Number.isInteger(id)) return { kind: 'none', reason: 'mark id is not an integer' };
    if (!marks.some((m) => m.id === id)) return { kind: 'none', reason: `unknown mark id ${id}` };
    return { kind: 'mark', markId: id };
  }
  if (r.kind === 'point') {
    const { x, y } = r;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { kind: 'none', reason: 'point is not numeric' };
    }
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      return { kind: 'none', reason: `point (${x}, ${y}) is outside the viewport` };
    }
    return { kind: 'point', x, y };
  }
  return { kind: 'none', reason: 'unknown answer kind' };
}
