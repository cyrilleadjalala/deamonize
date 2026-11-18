import * as vscode from 'vscode';
import { credentialsTree } from '../../core/models/credentials-model';
import type { TreeNode } from '../../core/types';
import type { Controller } from '../controller';
import { NodeTreeProvider } from './tree-provider';

export class CredentialsProvider extends NodeTreeProvider {
  constructor(private readonly controller: Controller) { super(); }

  protected async load(): Promise<TreeNode[]> {
    const secrets = await this.controller.query((api) => api.secrets());
    return credentialsTree({ state: this.controller.state, secrets });
  }
}

export function registerCredentialsView(controller: Controller): { provider: CredentialsProvider; disposables: vscode.Disposable[] } {
  const provider = new CredentialsProvider(controller);
  const view = vscode.window.createTreeView('daemonize.credentials', { treeDataProvider: provider });
  void provider.reload();
  return { provider, disposables: [view, provider] };
}
