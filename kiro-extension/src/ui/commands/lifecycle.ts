import * as vscode from 'vscode';
import { S } from '../../core/strings';
import type { Controller } from '../controller';
import { chooseCliFile } from '../settings';

export function registerLifecycleCommands(controller: Controller): vscode.Disposable[] {
  const { manager } = controller;
  const reg = (id: string, handler: (...args: any[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, handler);

  const start = reg('daemonize.start', async () => {
    await controller.withStudio(async () => undefined);
  });

  const stop = reg('daemonize.stop', async () => {
    await controller.guarded(async () => { await manager.stop(); });
    void vscode.window.showInformationMessage(S.stopped);
  });

  const restart = reg('daemonize.restart', async () => {
    if (!(await controller.ensureFolder())) return;
    await controller.guarded(async () => { await manager.restart(); });
  });

  const refresh = reg('daemonize.refresh', () => { controller.refresh(); });

  const showLog = reg('daemonize.showLog', () => { controller.logger.show(); });

  const chooseFile = reg('daemonize.chooseCliFile', async () => {
    const file = await chooseCliFile();
    if (file) controller.refresh();
  });

  // A different folder means a different place for the files: stop the process, the next start uses the new folder.
  const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (manager.state === 'running' || manager.state === 'starting') {
      void manager.stop().then(() => {
        void vscode.window.showInformationMessage(S.folderChanged);
        controller.refresh();
      });
    } else {
      controller.refresh();
    }
  });

  return [start, stop, restart, refresh, showLog, chooseFile, folders];
}
