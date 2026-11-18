import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../../src/cli/entry.js';
import { removeDir } from '../helpers/cleanup.js';

describe('isEntryPoint', () => {
  const realOf = (map: Record<string, string>) => (p: string) => map[p] ?? p;

  it('is false without a script path', () => {
    expect(isEntryPoint('file:///D:/repo/dist/cli/index.js', undefined, 'win32', (p) => p)).toBe(false);
    expect(isEntryPoint('file:///D:/repo/dist/cli/index.js', '', 'win32', (p) => p)).toBe(false);
  });

  it('resolves the script path through realpath (npm link junction on Windows)', () => {
    const module = 'D:\\deamonize\\workspace\\dist\\cli\\index.js';
    const link = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\daemonize\\dist\\cli\\index.js';
    const realpath = realOf({ [link]: module, [module]: module });
    expect(isEntryPoint(pathToFileURL(module).href, link, 'win32', realpath)).toBe(true);
  });

  it('ignores case on win32 and darwin only', () => {
    const realpath = (p: string) => p;
    if (process.platform === 'win32') {
      expect(isEntryPoint(pathToFileURL('D:\\Repo\\cli.js').href, 'd:\\repo\\CLI.js', 'win32', realpath)).toBe(true);
    } else {
      expect(isEntryPoint(pathToFileURL('/Repo/cli.js').href, '/repo/CLI.js', 'darwin', realpath)).toBe(true);
      expect(isEntryPoint(pathToFileURL('/Repo/cli.js').href, '/repo/CLI.js', 'linux', realpath)).toBe(false);
    }
  });

  it('is false for another script (imported by a test runner)', () => {
    const realpath = (p: string) => p;
    const self = process.platform === 'win32' ? 'D:\\repo\\dist\\cli\\index.js' : '/repo/dist/cli/index.js';
    const other = process.platform === 'win32' ? 'D:\\repo\\node_modules\\vitest\\vitest.mjs' : '/repo/node_modules/vitest/vitest.mjs';
    expect(isEntryPoint(pathToFileURL(self).href, other, process.platform, realpath)).toBe(false);
  });

  it('falls back to the plain path when realpath throws', () => {
    const path = process.platform === 'win32' ? 'D:\\gone\\cli.js' : '/gone/cli.js';
    const throwing = () => {
      throw new Error('ENOENT');
    };
    expect(isEntryPoint(pathToFileURL(path).href, path, process.platform, throwing)).toBe(true);
  });

  it('matches through a real directory link on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'entry-link-'));
    try {
      await mkdir(join(dir, 'pkg'), { recursive: true });
      const file = join(dir, 'pkg', 'index.js');
      await writeFile(file, '');
      await symlink(join(dir, 'pkg'), join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(isEntryPoint(pathToFileURL(file).href, join(dir, 'link', 'index.js'))).toBe(true);
    } finally {
      await removeDir(dir);
    }
  });
});