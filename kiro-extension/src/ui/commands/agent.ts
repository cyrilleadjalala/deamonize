import * as vscode from 'vscode';
import { chooseChatCommand, chooseOpenChatCommand } from '../../core/chat-launch';
import { createPowerApi } from '../../core/power-api';
import type { PowerApi } from '../../core/ports';
import { S } from '../../core/strings';
import type { DaemonizePowerPlanRow, InstallScope } from '../../core/types';
import { currentFolder, type Controller } from '../controller';

interface ScopePick { label: string; scope: InstallScope }

const OUTCOME_TEXT: Record<DaemonizePowerPlanRow['files'][number]['outcome'], string> = {
  create: S.previewCreate,
  merge: S.previewMerge,
  replace: S.previewReplace,
};

/** Offers to add the agent and its skill, shows the plan, and installs it without replacing a file. Never throws for a decline. */
async function offerToAddAgent(controller: Controller, power: PowerApi): Promise<void> {
  const offer = await vscode.window.showInformationMessage(S.addAgentConfirm, S.addAgent);
  if (offer !== S.addAgent) return;
  const pick = await vscode.window.showQuickPick<ScopePick>(
    [
      { label: S.scopeGlobal, scope: 'global' },
      { label: S.scopeProject, scope: 'project' },
    ],
    { placeHolder: S.addAgentScopePick, ignoreFocusOut: true },
  );
  if (pick === undefined) return;
  const folder = currentFolder();
  const plan = await power.preview({ scope: pick.scope, parts: 'agent', ...(pick.scope === 'project' && folder.kind === 'local' ? { workspacePath: folder.path } : {}) });
  if (!plan.ok) {
    void vscode.window.showErrorMessage(S.agentNotAdded);
    return;
  }
  if (plan.data.alreadyInstalled) {
    void vscode.window.showInformationMessage(S.agentAlready);
    return;
  }
  const detail = [S.powerPlanTitle, ...plan.data.files.map((f) => `${f.path}: ${OUTCOME_TEXT[f.outcome]}`)].join('\n');
  const choice = await vscode.window.showWarningMessage(S.addAgentConfirm, { modal: true, detail }, S.addAgent);
  if (choice !== S.addAgent) return;
  const done = await power.install({ confirmationId: plan.data.confirmationId, kiroPath: plan.data.kiroPath, scope: pick.scope });
  if (!done.ok) {
    void vscode.window.showErrorMessage(S.agentNotAdded);
    return;
  }
  void vscode.window.showInformationMessage(done.data.alreadyInstalled ? S.agentAlready : S.agentAdded);
  controller.refresh();
}

/** Opens the chat with the agent `daemonize`, or shows the plain instruction (Requirement 9.2 and 9.3). */
async function openChat(): Promise<void> {
  let available: Set<string>;
  try {
    available = new Set(await vscode.commands.getCommands(true));
  } catch {
    available = new Set();
  }
  const chosen = chooseChatCommand(available);
  if (chosen) {
    try {
      await vscode.commands.executeCommand(chosen.id, ...chosen.args);
      return;
    } catch {
      // fall through to the plain instruction
    }
  }
  const plain = chooseOpenChatCommand(available);
  const pressed = plain === undefined
    ? await vscode.window.showInformationMessage(S.agentOpenChat)
    : await vscode.window.showInformationMessage(S.agentOpenChat, S.openChat);
  if (pressed === S.openChat && plain !== undefined) await vscode.commands.executeCommand(plain);
}

export function registerAgentCommands(controller: Controller): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('daemonize.buildWithAgent', async () => {
      const ready = await controller.withStudio(async (_api, session) => {
        const power = createPowerApi(session.client);
        const info = await power.info();
        if (info.ok && !info.data.agentPresent.project && !info.data.agentPresent.global) await offerToAddAgent(controller, power);
        return true;
      });
      if (ready) await openChat();
    }),
  ];
}
