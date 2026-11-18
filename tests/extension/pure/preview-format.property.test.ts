// Feature: kiro-thin-extension, Property 19: The confirmation text lists everything that will be written
// **Validates: Requirements 14.4, 14.5, 14.6**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { previewDetail } from '../../../kiro-extension/src/core/models/preview-format';
import { S } from '../../../kiro-extension/src/core/strings';
import type { PreviewAnswer } from '../../../kiro-extension/src/core/types';

const pathText = fc.stringMatching(/^[A-Za-z0-9_./-]{3,30}$/);
const preview: fc.Arbitrary<PreviewAnswer> = fc.record({
  confirmationId: fc.constant('id'),
  scope: fc.constantFrom('global' as const, 'project' as const),
  kiroPath: pathText,
  files: fc.array(fc.record({ path: pathText, outcome: fc.constantFrom('create' as const, 'merge' as const, 'replace' as const) }), { maxLength: 5 }),
  replacesEntry: fc.boolean(),
  placeholders: fc.array(fc.stringMatching(/^[A-Z_]{3,10}$/), { maxLength: 3 }),
  missingSecrets: fc.array(fc.stringMatching(/^[A-Z][A-Z0-9_]{2,10}$/), { maxLength: 4 }),
  backup: fc.boolean(),
});
const WORD = { create: 'created', merge: 'merged', replace: 'replaced' } as const;

describe('Property 19: confirmation text', () => {
  it('lists the folder, each file with its outcome word, the missing names, the replacement and the backup', () => {
    fc.assert(
      fc.property(preview, (p) => {
        const text = previewDetail(p);
        expect(text).toContain(p.kiroPath);
        for (const f of p.files) expect(text).toContain(`${f.path} will be ${WORD[f.outcome]}`);
        for (const n of p.missingSecrets) expect(text).toContain(n);
        expect(text.includes(S.previewReplacesEntry)).toBe(p.replacesEntry);
        expect(text.includes(S.previewBackup)).toBe(p.backup);
        expect(text.includes('Credentials with no value yet')).toBe(p.missingSecrets.length > 0);
      }),
      { numRuns: 200 }
    );
  });
});
