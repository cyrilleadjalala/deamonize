import { describe, expect, it } from 'vitest';
import { __calls, __callsTo, __objects, __script, __setFolders } from '../fake-vscode';
import { StartError } from '../../../kiro-extension/src/core/process-manager';
import { StudioClientError } from '../../../kiro-extension/src/core/studio-client';
import { S } from '../../../kiro-extension/src/core/strings';
import { containsText, createHarness, TEST_TOKEN } from './harness';

const messages = (api: string): string[] => __callsTo(api).map((args) => String(args[0]));

describe('workspace folder rules', () => {
  it('without a folder, shows the folder message and starts nothing', async () => {
    const h = createHarness({}, { folders: null });
    await h.run('daemonize.newAction');
    expect(messages('window.showInformationMessage')).toContain(S.noWorkspaceFolder);
    expect(__callsTo('window.showInputBox')).toHaveLength(0);
    expect(h.manager.starts).toBe(0);
  });

  it('with a folder that is not on this computer, refuses to start', async () => {
    const h = createHarness({}, { folders: null });
    __setFolders(['/remote/project'], 'vscode-remote');
    await h.run('daemonize.start');
    expect(messages('window.showErrorMessage')).toContain(S.folderNotLocal);
    expect(h.manager.starts).toBe(0);
  });

  it('with several folders, says which one is used, once', async () => {
    const h = createHarness({}, { folders: ['/a', '/b'] });
    h.manager.setState('stopped');
    await h.run('daemonize.start');
    await h.run('daemonize.start');
    expect(messages('window.showInformationMessage').filter((m) => m === S.severalFolders)).toHaveLength(1);
    expect(h.manager.starts).toBe(2);
  });
});

describe('opening the Studio', () => {
  it('opens the browser address with the route and never shows or logs it', async () => {
    const h = createHarness();
    await h.run('daemonize.testInStudio');
    const opened = __callsTo('env.openExternal');
    expect(opened).toHaveLength(1);
    expect(String(opened[0][0])).toContain('#/playground');
    expect(String(opened[0][0])).toContain(TEST_TOKEN);
    const others = __calls.filter((c) => c.api !== 'env.openExternal');
    expect(containsText(others, TEST_TOKEN)).toBe(false);
  });

  it('tells the user plainly when the browser does not open, without the address', async () => {
    const h = createHarness();
    __script({ 'env.openExternal': [false] });
    await h.run('daemonize.openStudio');
    expect(messages('window.showErrorMessage')).toContain(S.browserNotOpened);
    expect(containsText(__calls.filter((c) => c.api !== 'env.openExternal'), TEST_TOKEN)).toBe(false);
  });
});

describe('dismissed prompts send nothing', () => {
  it('stops the new action at each dismissed prompt', async () => {
    for (const answers of [[undefined], ['Create invoice', undefined]]) {
      const h = createHarness();
      __script({ 'window.showInputBox': answers });
      await h.run('daemonize.newAction');
      expect(h.apiCalls.filter((c) => c.method === 'recordStart')).toHaveLength(0);
    }
    const h = createHarness();
    __script({ 'window.showInputBox': ['Create invoice', 'https://example.com'], 'window.showQuickPick': [undefined] });
    await h.run('daemonize.newAction');
    expect(h.apiCalls.filter((c) => c.method === 'recordStart')).toHaveLength(0);
  });

  it('starts the recording with the typed values', async () => {
    const h = createHarness({ recordStart: async () => ({ ok: true, status: 202, data: { state: 'recording' } }) });
    __script({
      'window.showInputBox': ['Create invoice', 'https://example.com'],
      'window.showQuickPick': [{ label: S.reuseNo, reuse: false }],
    });
    await h.run('daemonize.newAction');
    const start = h.apiCalls.find((c) => c.method === 'recordStart');
    expect(start?.args[0]).toEqual({ name: 'Create invoice', url: 'https://example.com', reuseSession: false });
    expect(messages('window.showInformationMessage')).toContain(S.recordingStarted);
    await h.handle.dispose();
  });

  it('does not forget a credential when the modal is cancelled', async () => {
    const h = createHarness();
    __script({ 'window.showWarningMessage': [undefined] });
    await h.run('daemonize.forgetCredential', { id: 'secret:DAEMONIZE_SECRET_X', label: 'DAEMONIZE_SECRET_X', icon: 'check' });
    expect(h.apiCalls.filter((c) => c.method === 'forgetSecret')).toHaveLength(0);
    const warning = __callsTo('window.showWarningMessage')[0];
    expect((warning[1] as { modal: boolean }).modal).toBe(true);
  });
});

describe('Connect to Kiro', () => {
  const preview = {
    confirmationId: 'c1', scope: 'project', kiroPath: '/work/project/.kiro', replacesEntry: false,
    files: [{ path: 'mcp.json', outcome: 'create' }], placeholders: [], missingSecrets: [], requiredSecrets: ['DAEMONIZE_SECRET_X'], backup: false,
  };
  const apiFor = (extra: Record<string, (...a: any[]) => unknown> = {}) => ({
    powerInfo: async () => ({ ok: true, status: 200, data: { kiroHomeExists: false, installs: [], available: true } }),
    powerPreview: async () => ({ ok: true, status: 200, data: preview }),
    powerInstall: async () => ({ ok: true, status: 200, data: { written: ['mcp.json'], placeholders: [], missingSecrets: [], requiredSecrets: ['DAEMONIZE_SECRET_X'], scope: 'project' } }),
    ...extra,
  });

  it('sends no install request when the modal is cancelled', async () => {
    const h = createHarness(apiFor());
    __script({ 'window.showWarningMessage': [undefined] });
    await h.run('daemonize.connectToKiro');
    expect(h.apiCalls.filter((c) => c.method === 'powerInstall')).toHaveLength(0);
    expect(h.apiCalls.find((c) => c.method === 'powerPreview')?.args).toEqual(['project', '/work/project']);
  });

  it('installs after the user confirms and says the saved passwords are used', async () => {
    const h = createHarness(apiFor());
    __script({ 'window.showWarningMessage': [S.confirmConnect] });
    await h.run('daemonize.connectToKiro');
    expect(h.apiCalls.find((c) => c.method === 'powerInstall')?.args[0]).toEqual({ confirmationId: 'c1', kiroPath: '/work/project/.kiro', scope: 'project' });
    const done = messages('window.showInformationMessage').find((m) => m.startsWith(S.connected));
    expect(done).toContain(S.credentialsFromVault);
  });
});

describe('errors', () => {
  it('a 401 on a read only list is retried once on a fresh start', async () => {
    let calls = 0;
    const h = createHarness({
      workflows: async () => {
        calls += 1;
        if (calls === 1) throw new StudioClientError('unauthorized', 'no');
        return { ok: true, status: 200, data: [] };
      },
    });
    await h.run('daemonize.refresh');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.manager.staleMarks).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('a 401 on a POST is not replayed and tells the user to try again', async () => {
    const h = createHarness({
      secrets: async () => ({ ok: true, status: 200, data: [{ name: 'DAEMONIZE_SECRET_X', kind: 'password', configured: false }] }),
      setSecret: async () => { throw new StudioClientError('unauthorized', 'no'); },
    });
    __script({ 'window.showInputBox': ['value-1234'] });
    await h.run('daemonize.setCredential', { id: 'secret:DAEMONIZE_SECRET_X', label: 'DAEMONIZE_SECRET_X', icon: 'key' });
    expect(h.apiCalls.filter((c) => c.method === 'setSecret')).toHaveLength(1);
    expect(h.manager.staleMarks).toBe(1);
    expect(messages('window.showErrorMessage')).toContain(S.restartedTryAgain);
  });

  it('offers to choose the file or open settings when Daemonize is not found', async () => {
    const h = createHarness();
    h.manager.startError = new StartError('locator', { kind: 'not-found' });
    await h.run('daemonize.start');
    const call = __callsTo('window.showErrorMessage')[0];
    expect(call).toEqual([S.cliMissing(''), S.chooseFile, S.openSettings]);
  });

  it('names the configured file when it does not exist', async () => {
    const h = createHarness();
    h.manager.startError = new StartError('locator', { kind: 'configured-missing', path: '/nope/daemonize.js' });
    await h.run('daemonize.start');
    expect(messages('window.showErrorMessage')[0]).toBe(S.cliConfiguredMissing('/nope/daemonize.js'));
  });

  it('saves the chosen file at the user level', async () => {
    const h = createHarness();
    h.manager.startError = new StartError('locator', { kind: 'not-found' });
    __script({
      'window.showErrorMessage': [S.chooseFile],
      'window.showOpenDialog': [[{ fsPath: '/tools/daemonize.js' }]],
    });
    await h.run('daemonize.start');
    expect(__callsTo('config.update')[0].slice(0, 2)).toEqual(['daemonize.cliPath', '/tools/daemonize.js']);
  });
});

describe('views', () => {
  it('start the Studio once when the Actions view is first shown', async () => {
    const h = createHarness();
    const view = __objects.find((o) => o.kind === 'treeView' && o.value.id === 'daemonize.actions')!.value;
    view.__setVisible(true);
    view.__setVisible(false);
    view.__setVisible(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.manager.starts).toBe(1);
  });
});
