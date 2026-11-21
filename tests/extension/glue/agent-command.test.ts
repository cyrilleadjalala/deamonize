import { beforeEach, describe, expect, it } from 'vitest';
import { __callsTo, __hostCommands, __script } from '../fake-vscode';
import { createHarness, containsText, TEST_TOKEN, type Harness } from './harness';
import { S } from '../../../kiro-extension/src/core/strings';

const PLAN = {
  confirmationId: 'c1', scope: 'project', parts: 'agent', kiroPath: '.kiro',
  files: [{ path: '.kiro/agents/daemonize.md', outcome: 'create' }],
  conflicts: [], alreadyInstalled: false, replacesEntry: false,
};

let posts: Array<{ path: string; body: Record<string, unknown> }>;

function arrange(agentPresent: { project: boolean; global: boolean }): Harness {
  const h = createHarness();
  posts = [];
  const client = h.manager.session!.client as { get: unknown; post: unknown };
  client.get = async (path: string) => {
    if (path === '/api/power/daemonize/info') return { status: 200, body: { installs: [], agentPresent } };
    throw new Error(`unexpected GET ${path}`);
  };
  client.post = async (path: string, body: Record<string, unknown>) => {
    posts.push({ path, body });
    if (path.endsWith('/preview')) return { status: 200, body: PLAN };
    if (path.endsWith('/install')) return { status: 200, body: { written: ['a'], skipped: [], alreadyInstalled: false } };
    throw new Error(`unexpected POST ${path}`);
  };
  return h;
}

beforeEach(() => { __hostCommands.clear(); });

describe('daemonize.buildWithAgent', () => {
  it('runs the chat command with the agent daemonize when the host has it, without asking to add the agent', async () => {
    const h = arrange({ project: true, global: false });
    __hostCommands.add('workbench.action.chat.open');
    await h.run('daemonize.buildWithAgent');
    expect(__callsTo('commands.executeCommand').some(([id, arg]) => id === 'workbench.action.chat.open' && (arg as { query: string }).query === '/daemonize ')).toBe(true);
    expect(posts).toEqual([]);
  });

  it('shows the plain instruction and no Open the chat button when the host has no chat command', async () => {
    const h = arrange({ project: false, global: true });
    await h.run('daemonize.buildWithAgent');
    expect(__callsTo('window.showInformationMessage')).toContainEqual([S.agentOpenChat]);
    expect(S.agentOpenChat).toContain('/daemonize');
  });

  it('offers to add the agent when it is missing, installs it without replacing, then continues to the chat', async () => {
    const h = arrange({ project: false, global: false });
    __script({
      'window.showInformationMessage': [S.addAgent],
      'window.showQuickPick': [{ label: S.scopeProject, scope: 'project' }],
      'window.showWarningMessage': [S.addAgent],
    });
    await h.run('daemonize.buildWithAgent');
    expect(posts.map((p) => p.path)).toEqual(['/api/power/daemonize/preview', '/api/power/daemonize/install']);
    expect(posts[0].body.parts).toBe('agent');
    expect(posts[1].body).not.toHaveProperty('replace');
    expect(__callsTo('window.showInformationMessage').some(([m]) => m === S.agentAdded)).toBe(true);
  });

  it('writes nothing when the user declines the plan', async () => {
    const h = arrange({ project: false, global: false });
    __script({
      'window.showInformationMessage': [S.addAgent],
      'window.showQuickPick': [{ label: S.scopeProject, scope: 'project' }],
      'window.showWarningMessage': [undefined],
    });
    await h.run('daemonize.buildWithAgent');
    expect(posts.map((p) => p.path)).toEqual(['/api/power/daemonize/preview']);
  });

  it('never shows or logs the token', async () => {
    const h = arrange({ project: false, global: false });
    __script({
      'window.showInformationMessage': [S.addAgent],
      'window.showQuickPick': [{ label: S.scopeProject, scope: 'project' }],
      'window.showWarningMessage': [S.addAgent],
    });
    await h.run('daemonize.buildWithAgent');
    const shown = [
      ...__callsTo('window.showInformationMessage'), ...__callsTo('window.showWarningMessage'),
      ...__callsTo('window.showErrorMessage'), ...__callsTo('outputChannel.appendLine'),
    ];
    expect(containsText(shown, TEST_TOKEN)).toBe(false);
  });
});
