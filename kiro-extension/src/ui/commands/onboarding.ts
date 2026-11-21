import * as vscode from 'vscode';
import type { Controller } from '../controller';

/** G0 seam: the commands are registered so that the manifest and the walkthrough work; the handlers belong to group G-E3. */
export function registerOnboardingCommands(_controller: Controller): vscode.Disposable[] {
  const notYet = (): never => {
    throw new Error('not implemented: G-E3');
  };
  return [
    vscode.commands.registerCommand('daemonize.installCli', notYet),
    vscode.commands.registerCommand('daemonize.checkBrowser', notYet),
    vscode.commands.registerCommand('daemonize.getStarted', notYet),
  ];
}
