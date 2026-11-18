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

  it('the delete texts and the title contain no path and no Studio token', () => {
    const texts = [
      S.confirmDelete, S.deleteConfirm('Sample name'), S.deleteDetail, S.actionDeleted('Sample name'), S.actionDeletedUpdating('Sample name'),
      S.actionGone, S.deleteBusy, S.deleteFailed, S.deleteNoAnswer, CONTRIBUTION_STRINGS['command.deleteAction'],
    ];
    expect(S.deleteDetail).toBe('This action cannot be recovered from the Studio.');
    for (const text of texts) {
      expect(bannedTermsIn(text), text).toEqual([]);
      expect(text, text).not.toMatch(/[A-Za-z]:\\|\/[A-Za-z]|token/i);
    }
  });

  it('every user-facing string passes', () => {
    const offenders = allTexts().filter(([, text]) => bannedTermsIn(text).length > 0).map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});
