import * as vscode from 'vscode';
import type { Controller } from '../controller';

/** G0 seam: the commands are registered so that the manifest and the menus work; the handlers belong to group G-E4. */
export function registerPowerCommands(_controller: Controller): vscode.Disposable[] {
  const notYet = (): never => {
    throw new Error('not implemented: G-E4');
  };
  return [
    vscode.commands.registerCommand('daemonize.installPower', notYet),
    vscode.commands.registerCommand('daemonize.removePower', notYet),
  ];
}
