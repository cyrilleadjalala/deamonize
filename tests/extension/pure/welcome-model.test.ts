import { describe, expect, it } from 'vitest';
import { welcomeContent, welcomeFor } from '../../../kiro-extension/src/core/welcome-model';

const s = (cliFound: boolean, browserMissing: boolean, actionCount: number, installCount = 0) => ({ cliFound, browserMissing, actionCount, installCount });

describe('welcomeFor', () => {
  it('chooses the entry from the state', () => {
    expect(welcomeFor(s(false, false, 0))).toBe('install');
    expect(welcomeFor(s(false, true, 3))).toBe('install');
    expect(welcomeFor(s(true, false, 0))).toBe('first-action');
    expect(welcomeFor(s(true, true, 0))).toBe('browser-missing');
    expect(welcomeFor(s(true, true, 2))).toBe('none');
    expect(welcomeFor(s(true, false, 2, 1))).toBe('none');
  });
  it('has the specified texts and buttons in order (RC-1 wording)', () => {
    expect(welcomeContent('install')).toEqual([
      { kind: 'text', text: 'Daemonize is not installed yet.' },
      { kind: 'button', label: 'Install Daemonize', command: 'daemonize.installCli' },
    ]);
    const first = [
      { kind: 'text', text: 'Show Daemonize the first thing you do in your software.' },
      { kind: 'button', label: 'New action', command: 'daemonize.newAction' },
      { kind: 'button', label: 'Build a tool with the Daemonize agent', command: 'daemonize.buildWithAgent' },
    ];
    expect(welcomeContent('first-action')).toEqual(first);
    expect(welcomeContent('browser-missing')).toEqual([
      { kind: 'text', text: 'Daemonize needs Google Chrome or Microsoft Edge. Install one, then try again.' },
      { kind: 'button', label: 'Check again', command: 'daemonize.checkBrowser' },
      ...first,
    ]);
    expect(welcomeContent('none')).toBeUndefined();
  });
});