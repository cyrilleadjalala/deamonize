import { describe, it, expect } from 'vitest';
import { bannedTermsIn } from '../../../kiro-extension/src/core/plain-language';
import { CONTRIBUTION_STRINGS, S } from '../../../kiro-extension/src/core/strings';

function allTexts(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(S)) {
    if (typeof value === 'string') out.push([`S.${key}`, value]);
    else if (typeof value === 'function') {
      const fn = value as (...args: unknown[]) => string;
      out.push([`S.${key}()`, fn.length === 1 && key === 'statusRecording' ? fn(2) : fn('Sample name')]);
    }
  }
  for (const [key, value] of Object.entries(CONTRIBUTION_STRINGS)) out.push([`nls.${key}`, value]);
  return out;
}

describe('Plain_Language lint', () => {
  it('finds a banned word and exempts paths and code spans', () => {
    expect(bannedTermsIn('Start the CLI and record a token')).toEqual(['CLI', 'record', 'token']);
    expect(bannedTermsIn('Open C:\\Users\\me\\record\\x and `daemonize compile`')).toEqual([]);
    expect(bannedTermsIn('Use the sign-in you saved')).toEqual([]);
  });

  it('every user-facing string passes', () => {
    const offenders = allTexts().filter(([, text]) => bannedTermsIn(text).length > 0).map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});
