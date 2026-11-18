// Feature: kiro-thin-extension, Property 17: The credentials tree shows names and flags, never values
// **Validates: Requirements 13.1, 13.2, 13.3**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { credentialsTree } from '../../../kiro-extension/src/core/models/credentials-model';
import { parseSecrets } from '../../../kiro-extension/src/core/studio-api';
import { S } from '../../../kiro-extension/src/core/strings';

const secret = fc.record({
  name: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,15}$/),
  kind: fc.constantFrom('password', 'totp', 'token'),
  configured: fc.boolean(),
  value: fc.constant('PLANTED-VALUE-123'),
});
const bad = fc.constantFrom<unknown>(null, 3, { name: 'X', kind: 'password' }, { name: 'X', kind: 'other', configured: true }, { kind: 'totp', configured: false });

describe('Property 17: credentials tree', () => {
  it('has one row per valid secret, with the flag text, the context value and no value', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(secret, bad), { maxLength: 8 }), (items) => {
        const rows = parseSecrets({ secrets: items })!;
        const tree = credentialsTree({ state: 'running', secrets: { ok: true, status: 200, data: rows } });
        if (rows.length === 0) {
          expect(tree.map((n) => n.id)).toEqual(['info:none']);
          return;
        }
        expect(tree).toHaveLength(rows.length);
        tree.forEach((node, i) => {
          const r = rows[i]!;
          expect(node.label).toBe(r.name);
          expect(node.description).toBe(r.configured ? S.hasValue : S.hasNoValue);
          expect(node.contextValue).toBe(r.configured ? 'secret.configured' : 'secret.missing');
          expect(JSON.stringify(node)).not.toContain('PLANTED-VALUE-123');
          expect(Object.keys(node).sort()).not.toContain('value');
        });
      }),
      { numRuns: 200 }
    );
  });

  it('asks to start when the Studio is not running and shows a retry row on failure', () => {
    expect(credentialsTree({ state: 'stopped', secrets: undefined })[0]!.label).toBe(S.startToSee);
    expect(credentialsTree({ state: 'running', secrets: { ok: false, status: 500, error: 'x' } })[0]!.label).toBe(S.loadFailed);
  });
});
