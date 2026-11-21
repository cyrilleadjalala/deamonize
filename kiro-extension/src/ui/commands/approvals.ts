import * as vscode from 'vscode';
import { createActivityApi } from '../../core/activity-api';
import { approvalMessage } from '../../core/activity-model';
import { createApprovalWatcher } from '../../core/approval-watcher';
import type { ActivityApi } from '../../core/ports';
import { S } from '../../core/strings';
import type { InstallScope, TreeNode } from '../../core/types';
import type { Controller } from '../controller';
import { openInBrowser } from './studio';

const APPROVAL_NODE = /^approval:([0-9a-f]{32})$/;
const INSTALL_NODE = /^install:(global|project):/;

/** The question id of a clicked row, or of the id itself. */
function idOf(arg: unknown): string | undefined {
  const raw = typeof arg === 'string' ? arg : typeof arg === 'object' && arg !== null && typeof (arg as TreeNode).id === 'string' ? (arg as TreeNode).id : undefined;
  if (raw === undefined) return undefined;
  const match = APPROVAL_NODE.exec(raw);
  if (match) return match[1];
  return /^[0-9a-f]{32}$/.test(raw) ? raw : undefined;
}

export function registerApprovalCommands(controller: Controller): vscode.Disposable[] {
  /** The only way to reach the two routes: the session's own client, the owner token inside it. */
  const activityApi = (): ActivityApi | undefined => {
    const session = controller.manager.session;
    return controller.state === 'running' && session ? createActivityApi(session.client) : undefined;
  };

  const answer = async (id: string, decision: 'approved' | 'denied'): Promise<void> => {
    const result = await controller.withStudio((_api, session) => createActivityApi(session.client).decide(id, decision));
    if (result === undefined) return;
    if (result.ok) void vscode.window.showInformationMessage(S.approvalSent);
    else void vscode.window.showErrorMessage(result.status === 404 ? S.approvalEnded : S.approvalFailed);
    controller.refresh();
  };

  const watcher = createApprovalWatcher({
    api: activityApi,
    notify: (row) => {
      // Tool, application and risk only: an argument value never goes into a notification.
      void Promise.resolve(vscode.window.showInformationMessage(approvalMessage(row), S.approve, S.deny))
        .then(async (choice) => {
          if (choice === S.approve) await answer(row.id, 'approved');
          else if (choice === S.deny) await answer(row.id, 'denied');
        })
        .catch(() => { controller.logger.log('approval answer failed'); });
      controller.refresh();
    },
    clear: () => controller.refresh(),
    setTimeout,
    clearTimeout,
  });

  const sync = (): void => {
    if (controller.state === 'running') watcher.start();
    else watcher.stop();
  };
  const subscription = controller.manager.onDidChangeState(sync);
  sync();

  const decideCommand = (decision: 'approved' | 'denied') => async (arg?: unknown): Promise<void> => {
    const id = idOf(arg) ?? watcher.pending[0]?.id;
    if (id === undefined) {
      void vscode.window.showInformationMessage(S.approvalEnded);
      return;
    }
    await answer(id, decision);
  };

  const toggle = async (node?: TreeNode): Promise<void> => {
    const scope = node && typeof node.id === 'string' ? (INSTALL_NODE.exec(node.id)?.[1] as InstallScope | undefined) : undefined;
    if (scope === undefined) return;
    await controller.withStudio(async (api, session) => {
      const info = await api.powerInfo();
      if (!info.ok) {
        void vscode.window.showErrorMessage(S.askFailed);
        return;
      }
      const current = info.data.installs.find((i) => i.scope === scope)?.askBeforeChanges === true;
      if (current) {
        const choice = await vscode.window.showWarningMessage(S.askTurnOffConfirm, { modal: true }, S.askTurnOff);
        if (choice !== S.askTurnOff) return;
      }
      const changed = await createActivityApi(session.client).setAskBeforeChanges(scope, !current);
      if (changed.ok) void vscode.window.showInformationMessage(S.askChanged);
      else void vscode.window.showErrorMessage(S.askFailed);
      controller.refresh();
    });
  };

  return [
    vscode.commands.registerCommand('daemonize.openActivity', () => openInBrowser(controller, 'activity')),
    vscode.commands.registerCommand('daemonize.approve', decideCommand('approved')),
    vscode.commands.registerCommand('daemonize.deny', decideCommand('denied')),
    vscode.commands.registerCommand('daemonize.toggleAskBeforeChanges', toggle),
    { dispose: () => { subscription.dispose(); watcher.stop(); } } as vscode.Disposable,
  ];
}
