import * as vscode from 'vscode';
import { S } from '../../core/strings';
import type { StudioApi } from '../../core/ports';
import type { TreeNode } from '../../core/types';
import type { Controller } from '../controller';

/** The name of a credential row (its label is the name), or a quick pick of the known names. */
async function credentialName(api: StudioApi, node: TreeNode | undefined): Promise<string | undefined> {
  if (node && typeof node.label === 'string' && node.id.startsWith('secret:')) return node.label;
  const list = await api.secrets();
  if (!list.ok) {
    void vscode.window.showErrorMessage(S.loadFailed);
    return undefined;
  }
  if (list.data.length === 0) {
    void vscode.window.showInformationMessage(S.noCredentialsYet);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.data.map((s) => ({ label: s.name, description: s.configured ? S.hasValue : S.hasNoValue })),
    { placeHolder: S.pickCredential, ignoreFocusOut: true },
  );
  return picked?.label;
}

export function registerCredentialCommands(controller: Controller): vscode.Disposable[] {
  const setCredential = vscode.commands.registerCommand('daemonize.setCredential', async (node?: TreeNode) => {
    await controller.withStudio(async (api) => {
      const name = await credentialName(api, node);
      if (name === undefined) return;
      // The value lives only in this local constant. It goes to api.setSecret and nowhere else.
      const value = await vscode.window.showInputBox({
        prompt: S.setCredentialPrompt(name),
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined || value === '') return;
      const result = await api.setSecret(name, value);
      if (result.ok) {
        void vscode.window.showInformationMessage(S.credentialSaved(name));
      } else {
        const reason = result.error ? controller.redact(result.error).split(value).join('***') : S.credentialNotSaved;
        void vscode.window.showErrorMessage(reason);
      }
      controller.refresh();
    });
  });

  const forgetCredential = vscode.commands.registerCommand('daemonize.forgetCredential', async (node?: TreeNode) => {
    await controller.withStudio(async (api) => {
      const name = await credentialName(api, node);
      if (name === undefined) return;
      const choice = await vscode.window.showWarningMessage(
        S.forgetConfirm(name),
        { modal: true, detail: S.forgetDetail },
        S.confirmForget,
      );
      if (choice !== S.confirmForget) return;
      const result = await api.forgetSecret(name);
      if (result.ok) void vscode.window.showInformationMessage(S.credentialForgotten(name));
      else void vscode.window.showErrorMessage(controller.redact(result.error || S.networkError));
      controller.refresh();
    });
  });

  return [setCredential, forgetCredential];
}
