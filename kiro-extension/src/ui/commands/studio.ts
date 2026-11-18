import * as vscode from 'vscode';
import type { StudioRoute } from '../../core/ports';
import { S } from '../../core/strings';
import { TARGET_NAME_RE, type StudioTarget } from '../../core/studio-url';
import type { TreeNode } from '../../core/types';
import { withTimeout } from '../../core/with-timeout';
import type { Controller } from '../controller';

const WORKFLOWS_LIMIT_MS = 5000;
const ACTION_ID = /^action:(.+)$/;

/** Opens the full Studio in the default browser. The address (which holds the token) is never logged, copied or shown. */
export async function openInBrowser(controller: Controller, route: StudioRoute, target?: StudioTarget): Promise<void> {
  await controller.withStudio(async (_api, session) => {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(session.browserUrl(route, target), true));
    if (!opened) void vscode.window.showErrorMessage(S.browserNotOpened);
  });
}

/**
 * Opens the clicked action: its tool in the Playground, or its page when it has no tool name yet.
 * Any problem reading the list falls back to the plain Playground, without a message.
 */
async function testInStudio(controller: Controller, node: TreeNode | undefined): Promise<void> {
  const match = node && typeof node.id === 'string' ? ACTION_ID.exec(node.id) : null;
  if (!match) {
    await openInBrowser(controller, 'playground');
    return;
  }
  const id = match[1];
  await controller.withStudio(async (api, session) => {
    let target: StudioTarget | undefined;
    try {
      const outcome = await withTimeout(api.workflows(), WORKFLOWS_LIMIT_MS);
      if (!outcome.timedOut && outcome.value.ok) {
        const found = outcome.value.data.find((w) => w.id === id);
        if (found) {
          if (found.toolName === undefined || found.toolName === '') target = { kind: 'workflow', id };
          else if (TARGET_NAME_RE.test(found.toolName)) target = { kind: 'tool', name: found.toolName };
        }
      }
    } catch {
      target = undefined;
    }
    const opened = await vscode.env.openExternal(vscode.Uri.parse(session.browserUrl('playground', target), true));
    if (!opened) void vscode.window.showErrorMessage(S.browserNotOpened);
  });
}

export function registerStudioCommands(controller: Controller): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('daemonize.openStudio', () => openInBrowser(controller, 'overview')),
    vscode.commands.registerCommand('daemonize.testInStudio', (node?: TreeNode) => testInStudio(controller, node)),
  ];
}
