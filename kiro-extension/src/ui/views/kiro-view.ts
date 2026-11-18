import * as vscode from 'vscode';
import { kiroTree } from '../../core/models/kiro-model';
import type { TreeNode } from '../../core/types';
import type { Controller } from '../controller';
import { NodeTreeProvider } from './tree-provider';

export class KiroProvider extends NodeTreeProvider {
  constructor(private readonly controller: Controller) { super(); }

  protected async load(): Promise<TreeNode[]> {
    const info = await this.controller.query((api) => api.powerInfo());
    return kiroTree({ state: this.controller.state, info });
  }
}

export function registerKiroView(controller: Controller): { provider: KiroProvider; disposables: vscode.Disposable[] } {
  const provider = new KiroProvider(controller);
  const view = vscode.window.createTreeView('daemonize.kiro', { treeDataProvider: provider });
  void provider.reload();
  return { provider, disposables: [view, provider] };
}
