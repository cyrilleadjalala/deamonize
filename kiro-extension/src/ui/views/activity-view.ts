import * as vscode from 'vscode';
import type { TreeNode } from '../../core/types';
import type { Controller } from '../controller';
import { NodeTreeProvider } from './tree-provider';

/** G0 seam: an empty list; group G-E2 fills `load` (pending questions first, then the 5 newest entries). */
export class ActivityProvider extends NodeTreeProvider {
  constructor(protected readonly controller: Controller) { super(); }

  protected async load(): Promise<TreeNode[]> {
    return [];
  }
}

export function registerActivityView(controller: Controller): { provider: ActivityProvider; disposables: vscode.Disposable[] } {
  const provider = new ActivityProvider(controller);
  const view = vscode.window.createTreeView('daemonize.activity', { treeDataProvider: provider });
  void provider.reload();
  return { provider, disposables: [view, provider] };
}
