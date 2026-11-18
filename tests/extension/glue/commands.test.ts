import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => { vi.useRealTimers(); });

const row = (id: string, label = 'Create invoice') => ({ id: `action:${id}`, label, icon: 'play' as const, contextValue: 'action' });
const wf = (id: string, toolName?: string) => ({ id, label: `Label of ${id}`, risk: 'read', ...(toolName === undefined ? {} : { toolName }) });
const opened = (): string[] => __callsTo('env.openExternal').map((a) => String(a[0]));
const noTokenOutside = (): boolean => !containsText(__calls.filter((c) => c.api !== 'env.openExternal'), TEST_TOKEN);

describe('daemonize.testInStudio on a row', () => {
  it('opens the tool in the Playground when the workflow has a tool name', async () => {
    const h = createHarness({ workflows: async () => ({ ok: true, status: 200, data: [wf('a1', 'other_tool'), wf('b2', 'create_invoice')] }) });
    await new Promise((r) => setTimeout(r, 20));
    const before = h.apiCalls.filter((c) => c.method === 'workflows').length;
    await h.run('daemonize.testInStudio', row('b2'));
    expect(opened()).toHaveLength(1);
    expect(opened()[0]).toContain('#/playground?tool=create_invoice');
    expect(h.apiCalls.filter((c) => c.method === 'workflows')).toHaveLength(before + 1);
    expect(noTokenOutside()).toBe(true);
  });

  it('opens the workflow page when the workflow has no tool name', async () => {
    const h = createHarness({ workflows: async () => ({ ok: true, status: 200, data: [wf('b2')] }) });
    await h.run('daemonize.testInStudio', row('b2'));
    expect(opened()[0]).toContain('#/workflows/b2');
  });

  it('matches the id exactly and never the label', async () => {
    const h = createHarness({ workflows: async () => ({ ok: true, status: 200, data: [{ ...wf('zzz', 'wrong_tool'), label: 'Create invoice' }] }) });
    await h.run('daemonize.testInStudio', row('b2', 'Create invoice'));
    expect(opened()[0]).toMatch(/#\/playground$/);
  });

  it('opens the plain Playground for an unknown id', async () => {
    const h = createHarness({ workflows: async () => ({ ok: true, status: 200, data: [wf('a1', 'x')] }) });
    await h.run('daemonize.testInStudio', row('b2'));
    expect(opened()[0]).toMatch(/#\/playground$/);
  });

  it('opens the plain Playground, with no message, when the list fails', async () => {
    for (const workflows of [
      async () => { throw new StudioClientError('network', 'down'); },
      async () => ({ ok: false, status: 500, error: 'boom' }),
      async () => ({ ok: false, status: 200, error: 'malformed' }),
    ]) {
      const h = createHarness({ workflows });
      await h.run('daemonize.testInStudio', row('b2'));
      expect(opened()[0]).toMatch(/#\/playground$/);
      expect(__callsTo('window.showErrorMessage')).toHaveLength(0);
      expect(__callsTo('window.showInformationMessage')).toHaveLength(0);
    }
  });

  it('opens the plain Playground, with no message, when the list does not answer in 5 seconds', async () => {
    vi.useFakeTimers();
    const h = createHarness({ workflows: () => new Promise(() => { /* never answers */ }) });
    const done = h.run('daemonize.testInStudio', row('b2'));
    await vi.advanceTimersByTimeAsync(4999);
    expect(opened()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(opened()[0]).toMatch(/#\/playground$/);
    expect(__callsTo('window.showErrorMessage')).toHaveLength(0);
  });

  it('opens the plain Playground without calling the Studio for another row or no row', async () => {
    for (const node of [undefined, { id: 'credentials:x', label: 'x', icon: 'key' as const }, { id: 'actions', label: 'x', icon: 'info' as const }]) {
      const h = createHarness();
      await new Promise((r) => setTimeout(r, 20));
      const before = h.apiCalls.filter((c) => c.method === 'workflows').length;
      await h.run('daemonize.testInStudio', node);
      expect(opened()[0]).toMatch(/#\/playground$/);
      expect(h.apiCalls.filter((c) => c.method === 'workflows')).toHaveLength(before);
    }
  });
});

describe('daemonize.deleteAction', () => {
  const ok = (data: Record<string, unknown> = { ok: true, remaining: 1 }) => async () => ({ ok: true, status: 200, data });
  const fail = (status: number, error: string) => async () => ({ ok: false, status, error });
  const deletes = (h: ReturnType<typeof createHarness>) => h.apiCalls.filter((c) => c.method === 'deleteWorkflow');
  const confirm = (): void => __script({ 'window.showWarningMessage': [S.confirmDelete] });

  it('asks in a modal that names the action and sends nothing when cancelled', async () => {
    const h = createHarness({ deleteWorkflow: ok() });
    __script({ 'window.showWarningMessage': [undefined] });
    await h.run('daemonize.deleteAction', row('b2'));
    const [message, options, button] = __callsTo('window.showWarningMessage')[0] as [string, { modal: boolean; detail: string }, string];
    expect(message).toContain('Create invoice');
    expect(options).toEqual({ modal: true, detail: S.deleteDetail });
    expect(button).toBe('Delete');
    expect(deletes(h)).toHaveLength(0);
  });

  it('deletes by id after the confirmation and refreshes (200 without recompile)', async () => {
    const h = createHarness({ deleteWorkflow: ok() });
    confirm();
    await h.run('daemonize.deleteAction', row('b2'));
    expect(deletes(h).map((c) => c.args)).toEqual([['b2']]);
    expect(messages('window.showInformationMessage')).toEqual([S.actionDeleted('Create invoice')]);
  });

  it('says the tools are being updated when the recompile started', async () => {
    const h = createHarness({ deleteWorkflow: ok({ ok: true, remaining: 1, recompile: 'started' }) });
    confirm();
    await h.run('daemonize.deleteAction', row('b2'));
    expect(messages('window.showInformationMessage')).toEqual([S.actionDeletedUpdating('Create invoice')]);
  });

  it('404: says the action no longer exists', async () => {
    const h = createHarness({ deleteWorkflow: fail(404, 'WORKFLOW_NOT_FOUND') });
    confirm();
    await h.run('daemonize.deleteAction', row('b2'));
    expect(messages('window.showInformationMessage')).toEqual([S.actionGone]);
  });

  it('409: shows the redacted message of the answer', async () => {
    const h = createHarness({ deleteWorkflow: fail(409, `An action is being created. ${TEST_TOKEN}`) });
    confirm();
    await h.run('daemonize.deleteAction', row('b2'));
    const shown = messages('window.showWarningMessage')[1];
    expect(shown).toContain('An action is being created.');
    expect(shown).not.toContain(TEST_TOKEN);
  });

  it('409 with only a code: shows a plain sentence', async () => {
    const h = createHarness({ deleteWorkflow: fail(409, 'SAMPLE_MODE') });
    confirm();
    await h.run('daemonize.deleteAction', row('b2'));
    expect(messages('window.showWarningMessage')[1]).toBe(S.deleteBusy);
  });

  it('another status or an unreachable Studio: a plain error', async () => {
    for (const deleteWorkflow of [fail(500, 'WRITE_FAILED'), async () => { throw new StudioClientError('network', 'down'); }]) {
      const h = createHarness({ deleteWorkflow });
      confirm();
      await h.run('daemonize.deleteAction', row('b2'));
      expect(messages('window.showErrorMessage')).toEqual([S.deleteFailed]);
    }
  });

  it('no answer within 10 seconds: a plain error', async () => {
    vi.useFakeTimers();
    const h = createHarness({ deleteWorkflow: () => new Promise(() => { /* never answers */ }) });
    confirm();
    const done = h.run('daemonize.deleteAction', row('b2'));
    await vi.advanceTimersByTimeAsync(9999);
    expect(messages('window.showErrorMessage')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(messages('window.showErrorMessage')).toEqual([S.deleteNoAnswer]);
  });

  it('ignores a second call for the same id while the first is pending, not for another id', async () => {
    let release: (v: unknown) => void = () => undefined;
    const h = createHarness({ deleteWorkflow: () => new Promise((r) => { release = r; }) });
    __script({ 'window.showWarningMessage': [S.confirmDelete, S.confirmDelete] });
    const first = h.run('daemonize.deleteAction', row('b2'));
    await new Promise((r) => setTimeout(r, 10));
    await h.run('daemonize.deleteAction', row('b2'));
    expect(__callsTo('window.showWarningMessage')).toHaveLength(1);
    expect(deletes(h)).toHaveLength(1);
    release({ ok: true, status: 200, data: { ok: true, remaining: 0 } });
    await first;
    // After the first call ended, the same id can be deleted again.
    __script({ 'window.showWarningMessage': [undefined] });
    await h.run('daemonize.deleteAction', row('b2'));
    expect(__callsTo('window.showWarningMessage')).toHaveLength(2);
  });

  it('does nothing without a row, with a bad row id or when the Studio is not running', async () => {
    const h = createHarness({ deleteWorkflow: ok() });
    await h.run('daemonize.deleteAction');
    await h.run('daemonize.deleteAction', { id: 'secret:X', label: 'X', icon: 'key' });
    await h.run('daemonize.deleteAction', { id: 'action:', label: 'X', icon: 'play' });
    h.manager.setState('stopped');
    await h.run('daemonize.deleteAction', row('b2'));
    expect(__callsTo('window.showWarningMessage')).toHaveLength(0);
    expect(deletes(h)).toHaveLength(0);
    expect(h.manager.starts).toBe(0);
  });

  it('never puts the token or a path in a message', async () => {
    for (const deleteWorkflow of [ok(), ok({ ok: true, remaining: 1, recompile: 'started' }), fail(404, 'x'), fail(409, `busy ${TEST_TOKEN}`), fail(500, 'x')]) {
      const h = createHarness({ deleteWorkflow });
      confirm();
      await h.run('daemonize.deleteAction', row('b2'));
      expect(containsText(__calls, TEST_TOKEN)).toBe(false);
    }
  });
});

describe('daemonize.newAction 409 handling', () => {
  const promptNewAction = (): void => {
    __script({
      'window.showInputBox': ['Search Wikipedia', 'https://fr.wikipedia.org'],
      'window.showQuickPick': [{ label: S.reuseNo, reuse: false }],
    });
  };

  it('shows the URL/origin message instead of recordingAlready when 409 carries field "url"', async () => {
    const h = createHarness({
      recordStart: async () => ({
        ok: false,
        status: 409,
        field: 'url',
        error: 'This folder already holds actions for https://google.com. Another application needs another folder.',
      }),
    });
    promptNewAction();
    await h.run('daemonize.newAction');
    const errs = messages('window.showErrorMessage');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('already holds actions for https://google.com');
    expect(errs[0]).not.toBe(S.recordingAlready);
  });

  it('shows the sample-mode or non-busy 409 message instead of recordingAlready', async () => {
    const h = createHarness({
      recordStart: async () => ({
        ok: false,
        status: 409,
        error: 'This Studio is running sample data.',
      }),
    });
    promptNewAction();
    await h.run('daemonize.newAction');
    expect(messages('window.showErrorMessage')).toEqual([S.recordingFailed('This Studio is running sample data.')]);
  });

  it('still shows recordingAlready when a recording is genuinely in progress', async () => {
    const h = createHarness({
      recordStart: async () => ({
        ok: false,
        status: 409,
        error: 'A recording is already in progress. Finish it before you start another.',
      }),
    });
    promptNewAction();
    await h.run('daemonize.newAction');
    expect(messages('window.showErrorMessage')).toEqual([S.recordingAlready]);
  });
});
