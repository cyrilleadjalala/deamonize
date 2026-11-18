import * as vscode from 'vscode';
import type { StudioRoute } from '../../core/ports';
import { S } from '../../core/strings';
import type { Controller } from '../controller';

/** Opens the full Studio in the default browser. The address (which holds the token) is never logged, copied or shown. */
export async function openInBrowser(controller: Controller, route: StudioRoute): Promise<void> {
  await controller.withStudio(async (_api, session) => {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(session.browserUrl(route), true));
    if (!opened) void vscode.window.showErrorMessage(S.browserNotOpened);
  });
}

export function registerStudioCommands(controller: Controller): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('daemonize.openStudio', () => openInBrowser(controller, 'overview')),
    vscode.commands.registerCommand('daemonize.testInStudio', () => openInBrowser(controller, 'playground')),
  ];
}
