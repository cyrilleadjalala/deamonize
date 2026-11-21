import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { __commands } from '../fake-vscode';
import { CONTRIBUTION_STRINGS, S } from '../../../kiro-extension/src/core/strings';
import { COPY } from '../../../src/studio/ui/js/copy.js';
import { createHarness } from '../glue/harness';
import { whenHolds } from '../when-clause';
import { welcomeFor } from '../../../kiro-extension/src/core/welcome-model';

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

describe('walkthrough daemonize.getStarted and the welcome entries', () => {
  const walkthrough = pkg.contributes.walkthroughs.find((w: { id: string }) => w.id === 'daemonize.getStarted');
  const steps: Array<{ id: string; title: string; description: string; completionEvents: string[]; media: { markdown: string } }> = walkthrough.steps;
  const declared = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));
  const KNOWN_KEYS = new Set(['daemonize.cliFound', 'daemonize.browserMissing', 'daemonize.actionCount', 'daemonize.installCount']);
  it('has the title and six steps in order, with unique ids', () => {
    expect(nls[walkthrough.title.replace(/%/g, '')]).toBe('Get started with Daemonize');
    expect(steps.map((s) => nls[s.title.replace(/%/g, '')])).toEqual([
      'Install Daemonize', 'Open the Studio', 'Create your first action', 'Test it', 'Add it to Kiro', 'Try the Daemonize agent',
    ]);
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
  });
  it('links a declared command, has a completion event on a declared command or a known key, and an existing media file', () => {
    const linked = steps.map((s) => /command:([\w.]+)/.exec(nls[s.description.replace(/%/g, '')])?.[1]);
    expect(linked).toEqual(['daemonize.installCli', 'daemonize.openStudio', 'daemonize.newAction', 'daemonize.testInStudio', 'daemonize.connectToKiro', 'daemonize.buildWithAgent']);
    for (const s of steps) {
      expect(nls[s.description.replace(/%/g, '')].length, s.id).toBeLessThanOrEqual(200);
      expect(s.completionEvents.length, s.id).toBeGreaterThan(0);
      for (const event of s.completionEvents) {
        const [kind, name] = event.split(':');
        if (kind === 'onCommand') expect(declared.has(name), event).toBe(true);
        else expect(kind === 'onContext' && KNOWN_KEYS.has(name), event).toBe(true);
      }
      expect(fs.existsSync(path.join(EXT, s.media.markdown)), s.media.markdown).toBe(true);
    }
    for (const id of linked) expect(declared.has(id!), id).toBe(true);
    expect(steps[0].completionEvents).toEqual(['onCommand:daemonize.installCli', 'onContext:daemonize.cliFound']);
  });
  it('has one heading in each media page, no hex colour', () => {
    for (const s of steps) {
      const text = fs.readFileSync(path.join(EXT, s.media.markdown), 'utf8');
      expect(text.match(/^# /gm), s.media.markdown).toHaveLength(1);
      expect(text).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    }
  });
  it('matches exactly one Actions welcome entry per state (none when welcomeFor says none)', () => {
    const entries = (pkg.contributes.viewsWelcome as Array<{ view: string; contents: string; when: string }>).filter((e) => e.view === 'daemonize.actions' && e.contents !== '%welcome.noFolder%');
    for (const cliFound of [false, true]) for (const browserMissing of [false, true]) for (const actionCount of [0, 1]) {
      const holding = entries.filter((e) => whenHolds(e.when, { 'daemonize.cliFound': cliFound, 'daemonize.browserMissing': browserMissing, 'daemonize.actionCount': actionCount, 'daemonize.installCount': 0 }));
      expect(holding.length, JSON.stringify({ cliFound, browserMissing, actionCount })).toBe(welcomeFor({ cliFound, browserMissing, actionCount, installCount: 0 }) === 'none' ? 0 : 1);
    }
  });
});