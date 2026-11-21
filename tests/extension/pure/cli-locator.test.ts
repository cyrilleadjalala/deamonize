import { describe, expect, it } from 'vitest';
import { locateCli, type FsPort, type LocatorInput } from '../../../kiro-extension/src/core/cli-locator';

const fakeFs = (files: Set<string>): FsPort => ({ isFile: async (p) => files.has(p), realpath: async (p) => p, readText: async () => undefined });
const input = (files: string[], over: Partial<LocatorInput> = {}): LocatorInput => ({
  cliPath: '', nodePath: '', workspaceFolder: '/ws', pathEntries: ['/a'], platform: 'linux', execPath: '/electron/kiro',
  fs: fakeFs(new Set(files)), ...over,
});

describe('locateCli: the folder owned by the extension', () => {
  it('comes after daemonize.cliPath and before the workspace and the PATH', async () => {
    const own = '/g/cli/node_modules/daemonize/dist/cli/index.js';
    const ws = '/ws/node_modules/.bin/daemonize';
    const path = '/a/daemonize';
    const both = await locateCli(input([own, ws, path, '/a/node'], { extensionFolder: '/g/cli' }));
    expect(both).toMatchObject({ kind: 'ok', cliFile: own });
    const configured = await locateCli(input([own, ws, '/c/daemonize'], { extensionFolder: '/g/cli', cliPath: '/c/daemonize' }));
    expect(configured).toMatchObject({ kind: 'ok', cliFile: '/c/daemonize' });
  });
  it('is ignored when empty or missing, and the workspace wins again', async () => {
    const ws = '/ws/node_modules/.bin/daemonize';
    expect(await locateCli(input([ws]))).toMatchObject({ kind: 'ok', cliFile: ws });
    expect(await locateCli(input([ws], { extensionFolder: '' }))).toMatchObject({ kind: 'ok', cliFile: ws });
    expect(await locateCli(input([ws], { extensionFolder: '/g/cli' }))).toMatchObject({ kind: 'ok', cliFile: ws });
  });
  it('finds the shim of the installed folder on Windows', async () => {
    const shim = 'C:\\g\\cli\\node_modules\\.bin\\daemonize.cmd';
    const js = 'C:\\g\\cli\\node_modules\\.bin\\..\\daemonize\\dist\\cli\\index.js';
    const fs: FsPort = {
      isFile: async (p) => p === shim || p === js.replace('.bin\\..\\', '') || p === 'C:\\n\\node.exe',
      realpath: async (p) => p,
      readText: async (p) => (p === shim ? '"%dp0%\\..\\daemonize\\dist\\cli\\index.js" %*' : undefined),
    };
    const result = await locateCli({ ...input([]), platform: 'win32', pathEntries: ['C:\\n'], extensionFolder: 'C:\\g\\cli', fs });
    expect(result.kind).toBe('ok');
  });
  it('finds nothing when nothing exists', async () => {
    expect(await locateCli(input([], { extensionFolder: '/g/cli' }))).toEqual({ kind: 'not-found' });
  });
});
