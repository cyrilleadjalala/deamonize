import * as vscode from 'vscode';
import type { Controller } from '../controller';

/** G0 seam: the commands are registered so that the manifest and the menus work; the handlers belong to group G-E2. */
export function registerApprovalCommands(_controller: Controller): vscode.Disposable[] {
  const notYet = (): never => {
    throw new Error('not implemented: G-E2');
  };
  return [
    vscode.commands.registerCommand('daemonize.openActivity', notYet),
    vscode.commands.registerCommand('daemonize.approve', notYet),
    vscode.commands.registerCommand('daemonize.deny', notYet),
    vscode.commands.registerCommand('daemonize.toggleAskBeforeChanges', notYet),
  ];
}
