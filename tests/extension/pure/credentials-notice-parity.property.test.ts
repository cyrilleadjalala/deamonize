// Feature: kiro-thin-extension, Property 20: The extension and the Studio choose the same credentials sentence
// **Validates: Requirements 14.10**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
// @ts-expect-error no type declarations for the browser modules
import { credentialsNotice as studioNotice } from '../../../src/studio/ui/js/credentials-notice.js';
// @ts-expect-error no type declarations for the browser modules
import { COPY } from '../../../src/studio/ui/js/copy.js';
import { credentialsNotice } from '../../../kiro-extension/src/core/models/credentials-notice';
import { S } from '../../../kiro-extension/src/core/strings';

const names = fc.array(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,10}$/), { maxLength: 4 });
const field = fc.option(names, { nil: undefined });
const answer = fc.record({ placeholders: field, requiredSecrets: field, missingSecrets: field }, { requiredKeys: [] });

describe('Property 20: credentials sentence parity', () => {
  it('returns the same decision as the Studio for any pair of answers', () => {
    fc.assert(fc.property(answer, fc.option(answer, { nil: undefined }), (result, preview) => {
      expect(credentialsNotice(result as never, preview as never)).toBe(studioNotice(result, preview));
    }), { numRuns: 300 });
  });

  it('shows the same texts for vault and none', () => {
    expect(S.credentialsFromVault).toBe(COPY.credentialsFromVault);
    expect(S.noCredentials).toBe(COPY.noPlaceholders);
  });
});
