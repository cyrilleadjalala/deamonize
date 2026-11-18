import * as vscode from 'vscode';
import { actionsTree, type FolderInfo } from '../../core/models/actions-model';
import type { TreeNode } from '../../core/types';
import { currentFolder, type Controller } from '../controller';
import { NodeTreeProvider } from './tree-provider';

function folderInfo(): FolderInfo {
  const folder = currentFolder();
  if (folder.kind === 'none') return { status: 'none' };
  if (folder.kind === 'remote') return { status: 'not-local' };
  return { status: folder.count > 1 ? 'several' : 'ok' };
}

export class ActionsProvider extends NodeTreeProvider {
  constructor(private readonly controller: Controller) { super(); }

  protected async load(): Promise<TreeNode[]> {
    const workflows = await this.controller.query((api) => api.workflows());
    return actionsTree({
      state: this.controller.state,
      folder: folderInfo(),
      workflows,
      recording: this.controller.recording,
    });
  }
}

/** The Actions view. Its first expansion starts the Studio once. */
export function registerActionsView(controller: Controller): { provider: ActionsProvider; disposables: vscode.Disposable[] } {
  const provider = new ActionsProvider(controller);
  const view = vscode.window.createTreeView('daemonize.actions', { treeDataProvider: provider });
  const visibility = view.onDidChangeVisibility((event) => {
    if (event.visible) controller.startOnFirstView();
  });
  if (view.visible) controller.startOnFirstView();
  void provider.reload();
  return { provider, disposables: [view, visibility, provider] };
}
