// Feature: user-journey-improvements, Property 22: Origin guard
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { checkSameOrigin, foreignOriginMessage, saveOriginMessage } from '../../src/workflow/origin-guard.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';

const workflow = (id: string): Workflow => ({ id, label: 'a', steps: [{ actionType: 'click', selectors: ['b'] }], variables: [], observedPayloads: [] });

const host = fc.constantFrom('app.test', 'other.test', 'a.b.test', 'localhost');
const address = fc
  .tuple(fc.constantFrom('http', 'https'), host, fc.option(fc.constantFrom(80, 443, 8080, 3000), { nil: undefined }), fc.constantFrom('', '/', '/secretdir/page', '/x?y=1#z'))
  .map(([scheme, h, port, path]) => `${scheme}://${h}${port === undefined ? '' : `:${port}`}${path}`);
const text = fc.oneof(address, fc.constantFrom('', 'not a url', '/relative', 'app.test/x', 'ht!tp://x'));

const existingArb = fc.oneof(
  fc.constant(undefined),
  fc.record({
    targetType: fc.constantFrom('web', 'tui') as fc.Arbitrary<'web' | 'tui'>,
    startUrl: fc.option(text, { nil: undefined }),
    count: fc.integer({ min: 0, max: 2 }),
  }).map(({ targetType, startUrl, count }): Pick<WorkflowSet, 'startUrl' | 'targetType' | 'workflows'> => ({
    targetType,
    ...(startUrl === undefined ? {} : { startUrl }),
    workflows: Array.from({ length: count }, (_, i) => workflow(`id-${i}`)),
  })),
);

function originOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

describe('Property 22: Origin guard', () => {
  /** **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.9, 12.10** */
  it('refuses if and only if a web file with a workflow and a valid startUrl meets a valid url of another origin', () => {
    fc.assert(
      fc.property(existingArb, text, (existing, url) => {
        const result = checkSameOrigin(existing, url);
        const held = originOrUndefined(existing?.startUrl);
        const wanted = originOrUndefined(url);
        const expectRefusal =
          existing !== undefined && existing.targetType === 'web' && existing.workflows.length >= 1 && held !== undefined && wanted !== undefined && held !== wanted;
        expect(result.ok).toBe(!expectRefusal);
        if (!result.ok) {
          expect(result.heldOrigin).toBe(held);
          expect(result.message).toBe(foreignOriginMessage(held!));
          expect(result.message).toContain(held!);
          expect(result.message).not.toContain('secretdir');
          expect(result.message).not.toMatch(/[A-Za-z]:\\|\.json|\/secretdir/);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('treats a default port as the same address without a port', () => {
    const existing = { targetType: 'web' as const, startUrl: 'https://app.test/start', workflows: [workflow('a')] };
    expect(checkSameOrigin(existing, 'https://app.test:443/other?x=1').ok).toBe(true);
    expect(checkSameOrigin({ ...existing, startUrl: 'http://app.test:80/' }, 'http://app.test/x').ok).toBe(true);
    expect(checkSameOrigin(existing, 'https://app.test:8443/').ok).toBe(false);
  });

  it('names both origins and no path in the save message', () => {
    const message = saveOriginMessage('https://a.test', 'https://b.test');
    expect(message).toContain('https://a.test');
    expect(message).toContain('https://b.test');
    expect(message).not.toMatch(/[A-Za-z]:\\|\.json/);
  });
});