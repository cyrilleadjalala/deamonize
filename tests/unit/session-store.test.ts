import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAppData } from '../../src/studio/app-data.js';
import { SessionSaveError } from '../../src/studio/contracts.js';
import { createSessionStore, sessionFileName } from '../../src/studio/session-store.js';
import { removeDir } from '../helpers/cleanup.js';

describe('Session_Store', () => {
  let root: string;
  let work: string;
  let data: string;
  let out: string;
  const state = { cookies: [{ name: 'sid', value: 'synthetic-cookie-value-1234', domain: 'a.test', path: '/' }], origins: [] };

  const store = (dataDir: string = data) =>
    createSessionStore({ appData: createAppData({ cwd: work, outDir: out, env: { DAEMONIZE_DATA_DIR: dataDir }, platform: process.platform }) });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'session-store-'));
    work = join(root, 'work');
    out = join(work, 'out');
    data = join(root, 'data');
    await mkdir(work, { recursive: true });
  });
  afterEach(async () => {
    await removeDir(root);
  });

  it('keys by origin and names the file after the first 40 hex characters of the hash', () => {
    const s = store();
    expect(s.keyFor('https://Example.com:443/a/b?q=1')).toBe('https://example.com');
    expect(s.keyFor('ftp://example.com')).toBeUndefined();
    expect(sessionFileName('https://example.com')).toMatch(/^[0-9a-f]{40}\.storage-state\.json$/);
    expect(sessionFileName('https://a.test')).not.toBe(sessionFileName('https://b.test'));
  });

  it('saves atomically, reads back, and the file lies outside the working directory', async () => {
    const s = store();
    await s.save('https://a.test', state);
    const path = await s.pathFor('https://a.test');
    expect(path).toBeDefined();
    expect(dirname(path as string)).toBe(resolve(data));
    expect((path as string).startsWith(work)).toBe(false);
    expect(await s.available('https://a.test')).toBe(true);
    expect((await readdir(data)).filter((n) => n.includes('.tmp-'))).toEqual([]);
    await s.refresh();
    expect(s.knownValues()).toContain('synthetic-cookie-value-1234');
    if (process.platform !== 'win32') expect((await stat(path as string)).mode & 0o777).toBe(0o600);
  });

  it('forgets a file, and forgetting a missing file succeeds', async () => {
    const s = store();
    await s.save('https://a.test', state);
    await s.forget('https://a.test');
    expect(await s.available('https://a.test')).toBe(false);
    await expect(s.forget('https://a.test')).resolves.toBeUndefined();
    await s.refresh();
    expect(s.knownValues()).toEqual([]);
  });

  it('reads invalid JSON, a wrong shape and an oversize file as "no"', async () => {
    const s = store();
    await mkdir(data, { recursive: true });
    await writeFile(join(data, sessionFileName('https://a.test')), '{not json');
    await writeFile(join(data, sessionFileName('https://b.test')), JSON.stringify({ hello: 1 }));
    await writeFile(join(data, sessionFileName('https://c.test')), JSON.stringify({ cookies: [], pad: 'x'.repeat(5 * 1024 * 1024 + 10) }));
    for (const key of ['https://a.test', 'https://b.test', 'https://c.test']) {
      expect(await s.pathFor(key)).toBeUndefined();
      expect(await s.available(key)).toBe(false);
    }
  });

  it('uses nothing when the App_Data_Dir is inside the working directory', async () => {
    const s = store(join(work, 'inside'));
    expect(await s.pathFor('https://a.test')).toBeUndefined();
    expect(await s.problem()).toBeDefined();
    await expect(s.save('https://a.test', state)).rejects.toBeInstanceOf(SessionSaveError);
    expect((await readdir(work)).sort()).toEqual([]);
  });

  it('has no problem when the folder is allowed', async () => {
    expect(await store().problem()).toBeUndefined();
  });
});
