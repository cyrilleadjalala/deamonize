// Feature: kiro-thin-extension, Property 3: Credentials sentence follows the decision table (Studio)
// **Validates: Requirements 2.3, 2.4, 2.5, 2.6**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
// @ts-expect-error no type declarations for the browser modules
import { credentialsNotice } from '../../src/studio/ui/js/credentials-notice.js';

const names = fc.array(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,10}$/), { maxLength: 4 });
const field = fc.option(names, { nil: undefined });
const answer = fc.record({ placeholders: field, requiredSecrets: field, missingSecrets: field }, { requiredKeys: [] });

const expected = (result: any, preview: any): string => {
  if (Array.isArray(result.placeholders) && result.placeholders.length > 0) return 'placeholders';
  const required = Array.isArray(result.requiredSecrets) ? result.requiredSecrets : Array.isArray(preview.requiredSecrets) ? preview.requiredSecrets : undefined;
  return required === undefined ? 'unknown' : required.length > 0 ? 'vault' : 'none';
};

describe('Property 3: credentials sentence follows the decision table', () => {
  it('matches the table for every install and preview answer', () => {
    fc.assert(
      fc.property(answer, answer, (result, preview) => {
        const got = credentialsNotice(result, preview);
        expect(got).toBe(expected(result, preview));
        if (Array.isArray(result.placeholders) && result.placeholders.length > 0) expect(got).toBe('placeholders');
        if (!('requiredSecrets' in result) && !('requiredSecrets' in preview) && !(result.placeholders?.length > 0)) expect(got).toBe('unknown');
      }),
      { numRuns: 200 }
    );
  });

  it('tolerates missing answers', () => {
    expect(credentialsNotice(undefined, undefined)).toBe('unknown');
    expect(credentialsNotice(null, { requiredSecrets: ['A'] })).toBe('vault');
  });
});
