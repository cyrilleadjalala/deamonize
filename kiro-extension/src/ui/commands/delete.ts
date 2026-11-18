import * as vscode from 'vscode';
import { S } from '../../core/strings';
import { StudioClientError } from '../../core/studio-client';
import type { TreeNode } from '../../core/types';
import { withTimeout } from '../../core/with-timeout';
import type { Controller } from '../controller';

const ACTION_ID = /^action:(.+)$/;
const DELETE_LIMIT_MS = 10_000;
/** An answer that is a code such as RECORDING_BUSY, not a sentence. */
const CODE_LIKE = /^[A-Z0-9_]+$/;

export function registerDeleteCommands(controller: Controller): vscode.Disposable[] {
  // Workflow ids with a confirmation or a request in progress. A second call for the same id is ignored.
  const pending = new Set<string>();

  const deleteAction = vscode.commands.registerCommand('daemonize.deleteAction', async (node?: TreeNode) => {
    const match = node && typeof node.id === 'string' ? ACTION_ID.exec(node.id) : null;
    if (!node || !match) return;
    if (controller.state !== 'running') return;
    const id = match[1];
    if (pending.has(id)) return;
    pending.add(id);
    try {
      const label = typeof node.label === 'string' && node.label !== '' ? node.label : id;
      const choice = await vscode.window.showWarningMessage(
        S.deleteConfirm(label),
        { modal: true, detail: S.deleteDetail },
        S.confirmDelete,
      );
      if (choice !== S.confirmDelete) return;
      await controller.withStudio(async (api) => {
        let outcome;
        try {
          outcome = await withTimeout(api.deleteWorkflow(id), DELETE_LIMIT_MS);
        } catch (error) {
          if (error instanceof StudioClientError && error.kind === 'unauthorized') throw error;
          void vscode.window.showErrorMessage(S.deleteFailed);
          return;
        }
        if (outcome.timedOut) {
          void vscode.window.showErrorMessage(S.deleteNoAnswer);
          return;
        }
        const result = outcome.value;
        if (result.ok) {
          controller.refresh();
          void vscode.window.showInformationMessage(
            result.data.recompile === 'started' ? S.actionDeletedUpdating(label) : S.actionDeleted(label),
          );
        } else if (result.status === 404) {
          controller.refresh();
          void vscode.window.showInformationMessage(S.actionGone);
        } else if (result.status === 409) {
          const message = controller.redact(result.error ?? '').trim();
          void vscode.window.showWarningMessage(message === '' || CODE_LIKE.test(message) ? S.deleteBusy : message);
        } else {
          void vscode.window.showErrorMessage(S.deleteFailed);
        }
      });
    } finally {
      pending.delete(id);
    }
  });

  return [deleteAction];
}
