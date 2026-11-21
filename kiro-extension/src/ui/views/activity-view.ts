import * as vscode from 'vscode';
import { createActivityApi } from '../../core/activity-api';
import { activityNodes } from '../../core/activity-model';
import type { ActivityRow, ApprovalRow, TreeNode } from '../../core/types';
import type { Controller } from '../controller';
import { NodeTreeProvider } from './tree-provider';

const RECENT = 5;

/** Pending questions first, then the 5 newest entries. Reads only the two read routes of the Studio. */
export class ActivityProvider extends NodeTreeProvider {
  constructor(protected readonly controller: Controller) { super(); }
  protected async load(): Promise<TreeNode[]> {
    const session = this.controller.manager.session;
    const running = this.controller.state === 'running' && session !== undefined;
    let pending: ApprovalRow[] = [];
    let recent: ActivityRow[] = [];
    if (running && session) {
      try {
        const api = createActivityApi(session.client);
        const [a, b] = await Promise.all([api.approvals(), api.activity(RECENT)]);
        if (a.ok) pending = a.data;
        if (b.ok) recent = b.data;
      } catch {
        this.controller.logger.log('activity failed');
      }
    }
    return activityNodes({ running, pending, recent, now: Date.now() });
  }
}

export function registerActivityView(controller: Controller): { provider: ActivityProvider; disposables: vscode.Disposable[] } {
  const provider = new ActivityProvider(controller);
  const view = vscode.window.createTreeView('daemonize.activity', { treeDataProvider: provider });
  void provider.reload();
  return { provider, disposables: [view, provider] };
}
