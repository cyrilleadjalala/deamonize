import * as vscode from 'vscode';
import { credentialsNotice } from '../../core/models/credentials-notice';
import { previewDetail } from '../../core/models/preview-format';
import { S } from '../../core/strings';
import type { InstallScope, TreeNode } from '../../core/types';
import { currentFolder, type Controller } from '../controller';

interface ScopePick { label: string; scope: InstallScope }

export function registerKiroCommands(controller: Controller): vscode.Disposable[] {
  const connect = vscode.commands.registerCommand('daemonize.connectToKiro', async () => {
    await controller.withStudio(async (api) => {
      const info = await api.powerInfo();
      if (!info.ok) {
        void vscode.window.showErrorMessage(controller.redact(info.error || S.loadFailed));
        return;
      }
      if (!info.data.available) {
        void vscode.window.showInformationMessage(S.connectUnavailable);
        return;
      }

      let scope: InstallScope = 'project';
      if (info.data.kiroHomeExists) {
        const pick = await vscode.window.showQuickPick<ScopePick>(
          [
            { label: S.scopeGlobal, scope: 'global' },
            { label: S.scopeProject, scope: 'project' },
          ],
          { placeHolder: S.connectScopePick, ignoreFocusOut: true },
        );
        if (pick === undefined) return;
        scope = pick.scope;
      }

      const folder = currentFolder();
      const workspacePath = scope === 'project' && folder.kind === 'local' ? folder.path : undefined;
      const preview = await api.powerPreview(scope, workspacePath);
      if (!preview.ok) {
        void vscode.window.showErrorMessage(S.connectFailed(controller.redact(preview.error)));
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        S.connectConfirm,
        { modal: true, detail: previewDetail(preview.data) },
        S.confirmConnect,
      );
      if (choice !== S.confirmConnect) return;

      const install = await api.powerInstall({
        confirmationId: preview.data.confirmationId,
        kiroPath: preview.data.kiroPath,
        scope,
      });
      if (!install.ok) {
        void vscode.window.showErrorMessage(S.connectFailed(controller.redact(install.error)));
        return;
      }

      const parts: string[] = [S.connected];
      switch (credentialsNotice(install.data, preview.data)) {
        case 'placeholders':
          parts.push(S.connectPlaceholders(install.data.placeholders.join(', ')));
          break;
        case 'vault':
          parts.push(S.credentialsFromVault);
          break;
        case 'none':
          parts.push(S.noCredentials);
          break;
        default:
          break;
      }
      if (install.data.missingSecrets.length > 0) parts.push(S.connectMissing(install.data.missingSecrets.join(', ')));
      void vscode.window.showInformationMessage(parts.join(' '));
      controller.refresh();
    });
  });

  const remove = vscode.commands.registerCommand('daemonize.removeFromKiro', async (node?: TreeNode) => {
    await controller.withStudio(async (api) => {
      let scope: InstallScope | undefined;
      // Row id: install:<scope>:<slug>
      const fromRow = node?.id.split(':')[1];
      if (fromRow === 'global' || fromRow === 'project') scope = fromRow;

      if (scope === undefined) {
        const info = await api.powerInfo();
        if (!info.ok) {
          void vscode.window.showErrorMessage(controller.redact(info.error || S.loadFailed));
          return;
        }
        const scopes = [...new Set(info.data.installs.map((i) => i.scope))];
        if (scopes.length === 0) {
          void vscode.window.showInformationMessage(S.notInstalled);
          return;
        }
        if (scopes.length === 1) {
          scope = scopes[0];
        } else {
          const pick = await vscode.window.showQuickPick<ScopePick>(
            scopes.map((s) => ({ label: s === 'global' ? S.scopeGlobal : S.scopeProject, scope: s })),
            { placeHolder: S.connectScopePick, ignoreFocusOut: true },
          );
          if (pick === undefined) return;
          scope = pick.scope;
        }
      }

      const choice = await vscode.window.showWarningMessage(
        S.removeConfirm,
        { modal: true, detail: S.removeDetail },
        S.confirmRemove,
      );
      if (choice !== S.confirmRemove) return;
      const result = await api.powerRemove(scope);
      if (result.ok) void vscode.window.showInformationMessage(S.removed);
      else void vscode.window.showErrorMessage(controller.redact(result.error || S.networkError));
      controller.refresh();
    });
  });

  return [connect, remove];
}
