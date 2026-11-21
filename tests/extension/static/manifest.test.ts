import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { __commands } from '../fake-vscode';
import { CONTRIBUTION_STRINGS, S } from '../../../kiro-extension/src/core/strings';
import { COPY } from '../../../src/studio/ui/js/copy.js';
import { createHarness } from '../glue/harness';

const EXT = path.resolve(__dirname, '../../../kiro-extension');
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
const nls = JSON.parse(fs.readFileSync(path.join(EXT, 'package.nls.json'), 'utf8'));

describe('extension manifest', () => {
  it('has the required fields', () => {
    expect(pkg.engines.vscode).toBe('^1.85.0');
    expect(pkg.main).toBe('./dist/extension.js');
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe(false);
    expect(pkg.capabilities.virtualWorkspaces.supported).toBe(false);
  });

  it('has no runtime dependencies', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).not.toHaveProperty('playwright');
    expect(pkg.devDependencies).not.toHaveProperty('node-pty');
  });

  it('activates only on a view or a command', () => {
    for (const event of pkg.activationEvents as string[]) {
      expect(event, event).toMatch(/^on(View|Command):daemonize\./);
    }
  });

  it('has the Activity Bar container and four views (Actions, Credentials, Kiro, Activity) and no webview', () => {
    expect(pkg.contributes.viewsContainers.activitybar).toHaveLength(1);
    expect(pkg.contributes.viewsContainers.activitybar[0].id).toBe('daemonize');
    expect(pkg.contributes.views.daemonize.map((v: { id: string }) => v.id)).toEqual(['daemonize.actions', 'daemonize.credentials', 'daemonize.kiro', 'daemonize.activity']);
    expect(JSON.stringify(pkg.contributes.views)).not.toContain('webview');
  });

  it('declares the two settings with scope machine', () => {
    const props = pkg.contributes.configuration.properties;
    expect(Object.keys(props).sort()).toEqual(['daemonize.cliPath', 'daemonize.nodePath']);
    for (const key of Object.keys(props)) expect(props[key].scope).toBe('machine');
  });

  it('wires every command into the palette, a menu or an activation event, and registers it at activation', () => {
    createHarness();
    const ids: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(ids.length).toBeGreaterThanOrEqual(14);
    for (const id of ids) {
      expect(pkg.activationEvents, id).toContain(`onCommand:${id}`);
      expect(__commands.has(id), id).toBe(true);
    }
    const menuCommands = new Set<string>(
      Object.values(pkg.contributes.menus as Record<string, Array<{ command: string }>>).flatMap((list) => list.map((m) => m.command)),
    );
    for (const id of ['daemonize.newAction', 'daemonize.testInStudio', 'daemonize.connectToKiro', 'daemonize.setCredential', 'daemonize.forgetCredential', 'daemonize.removeFromKiro']) {
      expect(menuCommands.has(id), id).toBe(true);
    }
  });

  it('keeps package.nls.json equal to CONTRIBUTION_STRINGS and every %key% defined', () => {
    expect(nls).toEqual(CONTRIBUTION_STRINGS);
    const keys = [...JSON.stringify(pkg).matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(nls, key).toHaveProperty(key);
  });

  it('contributes daemonize.deleteAction: inline on action rows only, hidden from the palette, titled in package.nls.json', () => {
    const command = pkg.contributes.commands.find((c: { command: string }) => c.command === 'daemonize.deleteAction');
    expect(command?.title).toBe('%command.deleteAction%');
    expect(nls['command.deleteAction']).toBe('Delete this action');
    const items = (pkg.contributes.menus['view/item/context'] as Array<{ command: string; when: string; group: string }>).filter((m) => m.command === 'daemonize.deleteAction');
    expect(items).toHaveLength(1);
    expect(items[0].when).toBe('view == daemonize.actions && viewItem == action');
    expect(items[0].group).toMatch(/^inline/);
    for (const [menu, list] of Object.entries(pkg.contributes.menus as Record<string, Array<{ command: string; when?: string }>>)) {
      if (menu === 'view/item/context') continue;
      const entry = list.find((m) => m.command === 'daemonize.deleteAction');
      if (menu === 'commandPalette') expect(entry?.when).toBe('false');
      else expect(entry).toBeUndefined();
    }
    expect(pkg.activationEvents).toContain('onCommand:daemonize.deleteAction');
  });

  it('offers no rename or variable editing on the action row', () => {
    const forAction = (pkg.contributes.menus['view/item/context'] as Array<{ command: string; when: string }>)
      .filter((m) => m.when.includes('viewItem == action')).map((m) => m.command);
    expect(forAction.sort()).toEqual(['daemonize.connectToKiro', 'daemonize.deleteAction', 'daemonize.testInStudio']);
  });

  it('shares the credentials sentence with the Studio', () => {
    expect(S.credentialsFromVault).toBe(COPY.credentialsFromVault);
    expect(S.noCredentials).toBe(COPY.noPlaceholders);
  });
});
