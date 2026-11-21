// Feature: kiro-native-agent-and-firewall, Property 32: The locator is pure and ordered
// **Validates: Requirements 19.1, 19.13**
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { locateCli, type FsPort, type LocatorInput } from '../../../kiro-extension/src/core/cli-locator';
import { renderWelcome, welcomeFor, type WelcomeId } from '../../../kiro-extension/src/core/welcome-model';
import { whenHolds } from '../when-clause';

const CUSTOM = '/custom/daemonize';
const OWN = '/g/cli/node_modules/daemonize/dist/cli/index.js';
const WS = '/ws/node_modules/.bin/daemonize';
const PATHED = '/a/daemonize';
const ORDER = [CUSTOM, OWN, WS, PATHED];
const base = (files: Set<string>, cliPath: string): LocatorInput => {
  const port: FsPort = { isFile: async (p) => files.has(p), realpath: async (p) => p, readText: async () => undefined };
  return { cliPath, nodePath: '', workspaceFolder: '/ws', extensionFolder: '/g/cli', pathEntries: ['/a'], platform: 'linux', execPath: '/electron/kiro', fs: port };
};

describe('Property 32: The locator is pure and ordered', () => {
  it('gives the same answer twice and the first existing of cliPath, extension folder, workspace, PATH wins', async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray(ORDER), fc.boolean(), async (present, useSetting) => {
        const files = new Set([...present, '/a/node']);
        const input = base(files, useSetting ? CUSTOM : '');
        const first = await locateCli(input);
        expect(await locateCli(input)).toEqual(first);
        if (useSetting && !files.has(CUSTOM)) {
          expect(first).toEqual({ kind: 'configured-missing', path: CUSTOM });
          return;
        }
        const expected = (useSetting ? ORDER : ORDER.slice(1)).find((c) => files.has(c));
        if (expected === undefined) expect(first).toEqual({ kind: 'not-found' });
        else expect(first).toMatchObject({ kind: 'ok', cliFile: expected });
      }),
      { numRuns: 200 },
    );
  });
});

// Feature: kiro-native-agent-and-firewall, Property 33: The welcome state is a pure function
// **Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.8**
const EXT = path.resolve(__dirname, '../../../kiro-extension');
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
const nls = JSON.parse(fs.readFileSync(path.join(EXT, 'package.nls.json'), 'utf8'));
const KEY: Record<WelcomeId, string | undefined> = { install: 'welcome.install', 'first-action': 'welcome.firstAction', 'browser-missing': 'welcome.browserMissing', none: undefined };
const actionEntries = (pkg.contributes.viewsWelcome as Array<{ view: string; contents: string; when: string }>).filter((e) => e.view === 'daemonize.actions' && e.contents !== '%welcome.noFolder%');
describe('Property 33: The welcome state is a pure function', () => {
  it('returns the same id, and exactly one manifest entry holds for it with the specified text and buttons', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.nat(5), fc.nat(5), (cliFound, browserMissing, actionCount, installCount) => {
        const state = { cliFound, browserMissing, actionCount, installCount };
        const id = welcomeFor(state);
        expect(welcomeFor({ ...state })).toBe(id);
        const keys = { 'daemonize.cliFound': cliFound, 'daemonize.browserMissing': browserMissing, 'daemonize.actionCount': actionCount, 'daemonize.installCount': installCount };
        const holding = actionEntries.filter((e) => whenHolds(e.when, keys));
        const key = KEY[id];
        if (key === undefined) {
          expect(holding).toHaveLength(0);
          return;
        }
        expect(holding).toHaveLength(1);
        expect(holding[0]!.contents).toBe(`%${key}%`);
        expect(nls[key]).toBe(renderWelcome(id));
      }),
      { numRuns: 200 },
    );
  });
});
