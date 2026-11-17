import { describe, expect, it } from 'vitest';
import { requiredSecrets } from '../../src/studio/required-secrets.js';
import type { WorkflowSet } from '../../src/types.js';

const step = (extra: Record<string, unknown>) => ({ actionType: 'type', selectors: [], ...extra });
const set = (workflows: unknown[]): WorkflowSet => ({ version: '1', targetType: 'web', targetName: 'App', startUrl: 'https://app.example', workflows }) as unknown as WorkflowSet;

describe('requiredSecrets', () => {
  it('is empty without a workflow file', () => {
    expect(requiredSecrets(undefined)).toEqual([]);
  });

  it('lists names with a kind: declared first, then totp steps, else password; a header shows as token', () => {
    const result = requiredSecrets(
      set([
        {
          id: 'a', label: 'A',
          secrets: [{ name: 'API', kind: 'header' }, { name: 'PW', kind: 'password' }, 'PLAIN'],
          steps: [step({ secretRef: 'OTP', totp: true }), step({ secretRef: 'PW' })],
        },
        { id: 'b', label: 'B', steps: [step({ secretRef: 'PW' })] },
      ])
    );
    expect(result).toEqual([
      { name: 'API', kind: 'token' },
      { name: 'OTP', kind: 'totp' },
      { name: 'PLAIN', kind: 'password' },
      { name: 'PW', kind: 'password' },
    ]);
  });
});
