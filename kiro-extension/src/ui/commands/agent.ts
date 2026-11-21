import * as vscode from 'vscode';
import type { Controller } from '../controller';

/** G0 seam: the command is registered so that the manifest and the menus work; the handler belongs to group G-E1. */
export function registerAgentCommands(_controller: Controller): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('daemonize.buildWithAgent', () => {
      throw new Error('not implemented: G-E1');
    }),
  ];
}
