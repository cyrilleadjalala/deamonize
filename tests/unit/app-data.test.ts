import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createAppData, defaultAppDataDir } from '../../src/studio/app-data.js';
import { removeDir } from '../helpers/cleanup.js';

describe('defaultAppDataDir', () => {
  it('picks the folder of each platform', () => {
    expect(defaultAppDataDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home: 'C:\\Users\\a' })).toBe('C:\\Users\\a\\AppData\\Local\\Daemonize');
    expect(defaultAppDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\a' })).toBe('C:\\Users\\a\\AppData\\Local\\Daemonize');
    expect(defaultAppDataDir({ platform: 'darwin', env: {}, home: '/Users/a' })).toBe('/Users/a/Library/Application Support/Daemonize');
    expect(defaultAppDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/home/a' })).toBe('/data/daemonize');
    expect(defaultAppDataDir({ platform: 'linux', env: { XDG_DATA_HOME: 'relative' }, home: '/home/a' })).toBe('/home/a/.local/share/daemonize');
    expect(defaultAppDataDir({ platform: 'linux', env: {}, home: '/home/a' })).toBe('/home/a/.local/share/daemonize');
  });
  it('takes DAEMONIZE_DATA_DIR only when it is absolute', () => {
    expect(defaultAppDataDir({ platform: 'linux', env: { DAEMONIZE_DATA_DIR: '/srv/d' }, home: '/home/a' })).toBe('/srv/d');
    expect(defaultAppDataDir({ platform: 'linux', env: { DAEMONIZE_DATA_DIR: 'rel/dir' }, home: '/home/a' })).toBeUndefined();
  });
});

describe('createAppData', () => {
  let root: string;
  let work: string;
  let data: string;
  const make = (dataDir: string | undefined, outDir = join(work, 'daemonize-out')) =>
    createAppData({ cwd: work, outDir, env: dataDir === undefined ? { DAEMONIZE_DATA_DIR: 'relative' } : { DAEMONIZE_DATA_DIR: dataDir } });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'appdata-')));
    work = join(root, 'work');
    data = join(root, 'data');
    await mkdir(work, { recursive: true });
  });
  afterEach(async () => {
    await removeDir(root);
  });

  it('accepts a folder outside the working directory, creates it on ensure only', async () => {
    const appData = make(data);
    expect(await appData.check()).toEqual({ ok: true, dir: data });
    expect((await readdir(root)).includes('data')).toBe(false);
    expect(await appData.ensure()).toEqual({ ok: true, dir: data });
    expect((await readdir(root)).includes('data')).toBe(true);
  });

  it('rejects a relative override', async () => {
    expect(await make(undefined).check()).toEqual({ ok: false, problem: 'unresolved' });
  });

  it('rejects the working directory, a folder inside it and the Output_Dir, and creates nothing', async () => {
    expect(await make(work).check()).toEqual({ ok: false, problem: 'inside-working-dir' });
    const inside = make(join(work, 'sub', 'data'));
    expect(await inside.ensure()).toEqual({ ok: false, problem: 'inside-working-dir' });
    expect(await readdir(work)).toEqual([]);
    const out = join(root, 'out');
    expect(await createAppData({ cwd: work, outDir: out, env: { DAEMONIZE_DATA_DIR: join(out, 'x') } }).check()).toEqual({ ok: false, problem: 'inside-output-dir' });
  });

  it('rejects a folder under a git repository, also when .git is a file (worktree), and notices a later .git', async () => {
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    const appData = make(join(repo, 'data'));
    expect((await appData.check()).ok).toBe(true);
    await writeFile(join(repo, '.git'), 'gitdir: elsewhere');
    expect(await appData.check()).toEqual({ ok: false, problem: 'inside-git-repo' });
  });

  it('follows a symbolic link to the real location', async () => {
    const link = join(root, 'link');
    try {
      await symlink(work, link, 'junction');
    } catch {
      return; // No privilege to link on this machine
    }
    expect(await make(join(link, 'data')).check()).toEqual({ ok: false, problem: 'inside-working-dir' });
  });

  it('answers not-writable when the folder cannot be created', async () => {
    const file = join(root, 'a-file');
    await writeFile(file, 'x');
    expect(await make(join(file, 'data')).ensure()).toEqual({ ok: false, problem: 'not-writable' });
  });

  it('treats letter case as equal on case-insensitive systems', async () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    expect(await make(work.toUpperCase() + sep + 'x').check()).toEqual({ ok: false, problem: 'inside-working-dir' });
  });
});
