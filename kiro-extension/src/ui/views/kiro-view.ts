import * as vscode from 'vscode';
import { kiroTree } from '../../core/models/kiro-model';
import { createPowerApi } from '../../core/power-api';
import type { InstallScope, TreeNode } from '../../core/types';
import type { Controller } from '../controller';
import { NodeTreeProvider } from './tree-provider';

export class KiroProvider extends NodeTreeProvider {
  constructor(private readonly controller: Controller) { super(); }
  protected async load(): Promise<TreeNode[]> {
    const info = await this.controller.query((api) => api.powerInfo());
    return kiroTree({ state: this.controller.state, info, powerScopes: await this.powerScopes() });
  }
  /** Where the Daemonize Power is installed. A failure only means that no Power row is shown. */
  private async powerScopes(): Promise<InstallScope[]> {
    const session = this.controller.manager.session;
    if (this.controller.state !== 'running' || !session) return [];
    try {
      const answer = await createPowerApi(session.client).info();
      if (!answer.ok) return [];
      return [...new Set(answer.data.installs.filter((i) => i.parts === 'power').map((i) => i.scope))];
    } catch {
      return [];
    }
  }
}

export function registerKiroView(controller: Controller): { provider: KiroProvider; disposables: vscode.Disposable[] } {
  const provider = new KiroProvider(controller);
  const view = vscode.window.createTreeView('daemonize.kiro', { treeDataProvider: provider });
  void provider.reload();
  return { provider, disposables: [view, provider] };
}
