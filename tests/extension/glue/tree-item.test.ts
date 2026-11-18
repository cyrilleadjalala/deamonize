import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { toTreeItem } from '../../../kiro-extension/src/ui/views/tree-provider';

function iconOf(icon: Parameters<typeof toTreeItem>[0]['icon']): vscode.ThemeIcon {
  return toTreeItem({ id: 'n', label: 'node', icon }).iconPath as vscode.ThemeIcon;
}

describe('tree items: accents follow the theme', () => {
  it('colours the risk of an action with theme colours (read green, write yellow, delete red)', () => {
    expect(iconOf('read').color?.id).toBe('charts.green');
    expect(iconOf('write').color?.id).toBe('charts.yellow');
    expect(iconOf('delete').color?.id).toBe('charts.red');
  });

  it('colours a check and a warning, and leaves neutral icons to the theme', () => {
    expect(iconOf('check').color?.id).toBe('charts.green');
    expect(iconOf('warning').color?.id).toBe('list.warningForeground');
    for (const icon of ['play', 'sync', 'key', 'plug', 'folder', 'add', 'info'] as const) {
      expect(iconOf(icon).color, icon).toBeUndefined();
    }
  });

  it('keeps the editor icon names', () => {
    expect(iconOf('read').id).toBe('eye');
    expect(iconOf('write').id).toBe('edit');
    expect(iconOf('delete').id).toBe('trash');
  });
});
