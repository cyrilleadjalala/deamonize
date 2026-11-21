import * as vscode from 'vscode';
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

/** The plan in plain words: the .kiro folder, then each file with what happens to it. No token, no secret value. */
function planDetail(plan: DaemonizePowerPlanRow, replace: readonly string[]): string {
  const lines = [S.previewPath(plan.kiroPath), S.powerPlanTitle];
  for (const f of plan.files) {
    const replaced = plan.conflicts.includes(f.path) && !replace.includes(f.path);
    lines.push(`${f.path}: ${replaced ? S.powerKeep : OUTCOME_TEXT[f.outcome]}`);
  }
  for (const c of plan.conflicts) {
    if (!plan.files.some((f) => f.path === c)) lines.push(`${c}: ${replace.includes(c) ? S.previewReplace : S.powerKeep}`);
  }
  return lines.join('\n');
}

async function installPower(controller: Controller): Promise<void> {
  await controller.withStudio(async (api, session) => {
    const power: PowerApi = createPowerApi(session.client);
    const info = await api.powerInfo();
    const home = info.ok && info.data.kiroHomeExists;

    // Scope: global by default when ~/.kiro exists, otherwise the project.
    const picks: ScopePick[] = [
      { label: S.scopeGlobal, scope: 'global' },
      { label: S.scopeProject, scope: 'project' },
    ];
    const ordered = home ? picks : [picks[1], picks[0]];
    const pick = await vscode.window.showQuickPick<ScopePick>(ordered, { placeHolder: S.powerScopePick, ignoreFocusOut: true });
    if (pick === undefined) return;

    const folder = currentFolder();
    const plan = await power.preview({
      scope: pick.scope,
      parts: 'power',
      ...(pick.scope === 'project' && folder.kind === 'local' ? { workspacePath: folder.path } : {}),
    });
    if (!plan.ok) {
      void vscode.window.showErrorMessage(S.powerNotInstalled);
      return;
    }
    if (plan.data.alreadyInstalled) {
      void vscode.window.showInformationMessage(S.powerAlready);
      return;
    }

    // A differing file is kept unless the user explicitly chooses to replace it.
    const replace: string[] = [];
    for (const file of plan.data.conflicts) {
      const answer = await vscode.window.showWarningMessage(S.powerReplaceConfirm(file), { modal: true }, S.powerReplace, S.powerKeep);
      if (answer === S.powerReplace) replace.push(file);
    }

    const choice = await vscode.window.showWarningMessage(S.powerInstallConfirm, { modal: true, detail: planDetail(plan.data, replace) }, S.installPower);
    if (choice !== S.installPower) return;

    const done = await power.install({
      confirmationId: plan.data.confirmationId,
      kiroPath: plan.data.kiroPath,
      scope: pick.scope,
      ...(replace.length > 0 ? { replace } : {}),
    });
    if (!done.ok) {
      void vscode.window.showErrorMessage(S.powerNotInstalled);
      return;
    }
    controller.refresh();
    if (done.data.alreadyInstalled) {
      void vscode.window.showInformationMessage(S.powerAlready);
      return;
    }
    const next = await vscode.window.showInformationMessage(S.powerInstalled, S.buildWithAgent);
    if (next === S.buildWithAgent) await vscode.commands.executeCommand('daemonize.buildWithAgent');
  });
}

async function removePower(controller: Controller): Promise<void> {
  await controller.withStudio(async (_api, session) => {
    const power = createPowerApi(session.client);
    const info = await power.info();
    const scopes = info.ok ? [...new Set(info.data.installs.filter((i) => i.parts === 'power').map((i) => i.scope))] : [];
    if (scopes.length === 0) {
      void vscode.window.showInformationMessage(S.powerRemoveFailed);
      return;
    }
    let scope: InstallScope = scopes[0];
    if (scopes.length > 1) {
      const pick = await vscode.window.showQuickPick<ScopePick>(
        [
          { label: S.scopeGlobal, scope: 'global' },
          { label: S.scopeProject, scope: 'project' },
        ],
        { placeHolder: S.powerScopePick, ignoreFocusOut: true },
      );
      if (pick === undefined) return;
      scope = pick.scope;
    }
    const choice = await vscode.window.showWarningMessage(S.powerRemoveConfirm, { modal: true, detail: S.powerRemoveDetail }, S.removePower);
    if (choice !== S.removePower) return;
    const done = await power.remove(scope, 'power');
    if (!done.ok) {
      void vscode.window.showErrorMessage(S.powerRemoveFailed);
      return;
    }
    void vscode.window.showInformationMessage(S.powerRemoved);
    controller.refresh();
  });
}

export function registerPowerCommands(controller: Controller): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('daemonize.installPower', () => installPower(controller)),
    vscode.commands.registerCommand('daemonize.removePower', () => removePower(controller)),
  ];
}
