// Feature: kiro-thin-extension, Property 10: CLI location is deterministic and follows the documented order
// **Validates: Requirements 4.1, 4.2, 4.4, 4.5, 4.6, 4.10**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { locateCli, type FsPort, type LocatorInput } from '../../../kiro-extension/src/core/cli-locator';

function fakeFs(files: Set<string>, texts: Record<string, string> = {}, real: Record<string, string> = {}): FsPort {
  return {
    isFile: async (p) => files.has(p),
    realpath: async (p) => real[p] ?? p,
    readText: async (p) => texts[p],
  };
}

const WS = '/ws';
const ORDER = ['/ws/node_modules/.bin/daemonize', '/ws/node_modules/daemonize/dist/cli/index.js', '/a/daemonize', '/b/daemonize'];
const NODES = ['/a/node', '/b/node'];
const base = (over: Partial<LocatorInput>, fs: FsPort): LocatorInput => ({
  cliPath: '', nodePath: '', workspaceFolder: WS, pathEntries: ['/a', '/b'], platform: 'linux', execPath: '/electron/kiro', fs, ...over,
});

describe('Property 10: CLI location order', () => {
  it('returns the first existing candidate, is deterministic, and picks Node in the documented order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(ORDER),
        fc.subarray(NODES),
        fc.constantFrom('', '/custom/node'),
        fc.boolean(),
        async (present, nodes, nodePath, nodeExists) => {
          const files = new Set([...present, ...nodes]);
          if (nodePath !== '' && nodeExists) files.add(nodePath);
          const input = base({ nodePath }, fakeFs(files));
          const first = await locateCli(input);
          expect(await locateCli(input)).toEqual(first);
          const expectedFile = ORDER.find((c) => files.has(c));
          if (expectedFile === undefined) {
            expect(first).toEqual({ kind: 'not-found' });
            return;
          }
          if (!expectedFile.endsWith('.js')) {
            expect(first).toMatchObject({ kind: 'ok', command: expectedFile, baseArgs: [], extraEnv: {}, cliFile: expectedFile });
            return;
          }
          if (nodePath !== '' && !nodeExists) {
            expect(first).toEqual({ kind: 'configured-missing', path: nodePath });
            return;
          }
          const node = nodePath !== '' ? nodePath : NODES.find((n) => files.has(n));
          if (node !== undefined) {
            expect(first).toMatchObject({ kind: 'ok', command: node, baseArgs: [expectedFile], extraEnv: {}, usedElectronNode: false });
          } else {
            expect(first).toMatchObject({ kind: 'ok', command: '/electron/kiro', baseArgs: [expectedFile], extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, usedElectronNode: true });
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('a configured cliPath that does not exist is configured-missing with no fallback', async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray(ORDER), async (present) => {
        const res = await locateCli(base({ cliPath: '/nope/daemonize.js' }, fakeFs(new Set(present))));
        expect(res).toEqual({ kind: 'configured-missing', path: '/nope/daemonize.js' });
      }),
      { numRuns: 100 }
    );
  });
});

describe('cli locator examples', () => {
  it('follows a symlink to a .js file and runs it with Node', async () => {
    const files = new Set(['/ws/node_modules/.bin/daemonize', '/a/node']);
    const fs = fakeFs(files, {}, { '/ws/node_modules/.bin/daemonize': '/ws/node_modules/daemonize/dist/cli/index.js' });
    expect(await locateCli(base({}, fs))).toMatchObject({ kind: 'ok', command: '/a/node', baseArgs: ['/ws/node_modules/daemonize/dist/cli/index.js'] });
  });

  it('reads a Windows .cmd shim and runs the .js file it names with node.exe, without a shell', async () => {
    const shim = 'C:\\ws\\node_modules\\.bin\\daemonize.cmd';
    const js = 'C:\\ws\\node_modules\\daemonize\\dist\\cli\\index.js';
    const files = new Set([shim, js, 'C:\\node\\node.exe']);
    const texts = { [shim]: '@ECHO off\r\n"%_prog%"  "%dp0%\\..\\daemonize\\dist\\cli\\index.js" %*\r\n' };
    const res = await locateCli({
      cliPath: '', nodePath: '', workspaceFolder: 'C:\\ws', pathEntries: ['C:\\node'], platform: 'win32', execPath: 'C:\\kiro.exe', fs: fakeFs(files, texts),
    });
    expect(res).toMatchObject({ kind: 'ok', command: 'C:\\node\\node.exe', baseArgs: [js], extraEnv: {}, usedElectronNode: false });
  });

  it('refuses a .cmd shim it cannot read', async () => {
    const shim = 'C:\\ws\\node_modules\\.bin\\daemonize.cmd';
    const res = await locateCli({
      cliPath: '', nodePath: '', workspaceFolder: 'C:\\ws', pathEntries: [], platform: 'win32', execPath: 'C:\\kiro.exe', fs: fakeFs(new Set([shim]), { [shim]: 'echo hi' }),
    });
    expect(res).toEqual({ kind: 'unsupported-shim', path: shim });
  });

  it('runs a .exe directly without Node', async () => {
    const exe = 'C:\\tools\\daemonize.exe';
    const res = await locateCli({
      cliPath: '', nodePath: '', workspaceFolder: 'C:\\ws', pathEntries: ['C:\\tools'], platform: 'win32', execPath: 'C:\\kiro.exe', fs: fakeFs(new Set([exe])),
    });
    expect(res).toMatchObject({ kind: 'ok', command: exe, baseArgs: [], usedElectronNode: false });
  });

  it('uses the Electron binary with ELECTRON_RUN_AS_NODE when no node exists', async () => {
    const res = await locateCli(base({ cliPath: '/x/cli.js' }, fakeFs(new Set(['/x/cli.js']))));
    expect(res).toMatchObject({ kind: 'ok', command: '/electron/kiro', extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, usedElectronNode: true });
  });
});
