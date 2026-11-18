// Feature: user-journey-improvements, Property 18: Start page and login of a workflow
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';

const ID = '66666666-6666-4666-8666-666666666666';

function fileWith(fields: Record<string, unknown>): string {
  return JSON.stringify({
    version: '1',
    targetType: 'web',
    targetName: 'app',
    startUrl: 'https://app.test/',
    workflows: [{ id: ID, label: 'Action', ...fields, steps: [{ actionType: 'click', selectors: ['button'] }], variables: [], observedPayloads: [] }],
  });
}

function outcome(fields: Record<string, unknown>): { accepted: boolean; message: string } {
  try {
    deserializeWorkflowSet(fileWith(fields));
    return { accepted: true, message: '' };
  } catch (error) {
    return { accepted: false, message: (error as Error).message };
  }
}

const host = fc.stringMatching(/^[a-z][a-z0-9]{0,10}(\.[a-z][a-z0-9]{0,6}){0,2}$/);
const path = fc.stringMatching(/^(\/[a-z0-9]{1,8}){0,3}$/);
const validUrl = fc
  .tuple(fc.constantFrom('http', 'https'), host, fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }), path)
  .map(([scheme, h, port, p]) => `${scheme}://${h}${port === undefined ? '' : `:${port}`}${p}`);
const invalidUrl = fc.oneof(
  fc.constant(''),
  fc.constantFrom('/relative/path', 'app.test/x', 'ftp://app.test/', 'file:///etc/hosts', 'javascript:alert(1)', 'https://', 'http:// spaced'),
  host.map((h) => `${h}/x`),
  fc.constant(`https://app.test/${'a'.repeat(2048)}`),
  fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant({})),
);

describe('Property 18: Start page and login of a workflow', () => {
  /** **Validates: Requirements 10.1, 10.2** */
  it('accepts startUrl if and only if it is an absolute http or https address of 1 to 2048 characters', () => {
    fc.assert(
      fc.property(fc.oneof(validUrl.map((url) => ({ url, valid: true })), invalidUrl.map((url) => ({ url, valid: false }))), ({ url, valid }) => {
        const result = outcome({ startUrl: url });
        expect(result.accepted).toBe(valid);
        if (!valid) {
          expect(result.message).toContain(ID);
          expect(result.message).toContain('startUrl');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('accepts storageState if and only if it is a non-empty string of at most 1024 characters, or null', () => {
    const state = fc.oneof(
      fc.string({ maxLength: 1100 }),
      fc.constant(null),
      fc.oneof(fc.integer(), fc.boolean(), fc.constant({}), fc.constant([])),
    );
    fc.assert(
      fc.property(state, (value) => {
        const valid = value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 1024);
        const result = outcome({ storageState: value });
        expect(result.accepted).toBe(valid);
        if (!valid) {
          expect(result.message).toContain(ID);
          expect(result.message).toContain('storageState');
        }
      }),
      { numRuns: 200 },
    );
  });
});