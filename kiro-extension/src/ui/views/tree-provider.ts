import * as vscode from 'vscode';
import type { TreeNode } from '../../core/types';

const ICONS: Record<TreeNode['icon'], string> = {
  play: 'play',
  sync: 'sync',
  warning: 'warning',
  read: 'eye',
  write: 'edit',
  delete: 'trash',
  key: 'key',
  check: 'check',
  plug: 'plug',
  folder: 'folder',
  add: 'add',
  info: 'info',
};

/**
 * Accent colours are theme colours, never fixed values: Kiro swaps them with the user's theme, so the
 * panels stay readable in the dark, light and high contrast themes.
 */
const ACCENTS: Partial<Record<TreeNode['icon'], string>> = {
  read: 'charts.green',
  write: 'charts.yellow',
  delete: 'charts.red',
  check: 'charts.green',
  warning: 'list.warningForeground',
};

export function toTreeItem(node: TreeNode): vscode.TreeItem {
  const state = node.children && node.children.length > 0
    ? vscode.TreeItemCollapsibleState.Expanded
    : vscode.TreeItemCollapsibleState.None;
  const item = new vscode.TreeItem(node.label, state);
  item.id = node.id;
  if (node.description !== undefined) item.description = node.description;
  if (node.tooltip !== undefined) item.tooltip = node.tooltip;
  if (node.contextValue !== undefined) item.contextValue = node.contextValue;
  const accent = ACCENTS[node.icon];
  item.iconPath = new vscode.ThemeIcon(ICONS[node.icon] ?? 'info', accent === undefined ? undefined : new vscode.ThemeColor(accent));
  if (node.command) {
    item.command = { command: node.command.id, title: node.label, arguments: node.command.args };
  }
  return item;
}

/** A tree data provider over plain `TreeNode` data. The subclass decides how the nodes are computed. */
export abstract class NodeTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  protected nodes: TreeNode[] = [];
  private generation = 0;

  /** Compute the nodes for the current state. May call the Studio for a read only list. */
  protected abstract load(): Promise<TreeNode[]>;

  /** Recomputes the nodes and redraws. A slow answer never overwrites a newer one. */
  async reload(): Promise<void> {
    const generation = ++this.generation;
    const next = await this.load();
    if (generation !== this.generation) return;
    this.nodes = next;
    this.changed.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem { return toTreeItem(node); }

  getChildren(node?: TreeNode): TreeNode[] {
    return node ? node.children ?? [] : this.nodes;
  }

  dispose(): void { this.changed.dispose(); }
}
