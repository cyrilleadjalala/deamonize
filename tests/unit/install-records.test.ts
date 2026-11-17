import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppData } from '../../src/studio/contracts.js';
import { createInstallRecords, type InstallRecord } from '../../src/studio/install-records.js';
import { createAutoAddStore } from '../../src/studio/auto-add-store.js';

let dir: string;
let appData: AppData;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'records-'));
  appData = { dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rec = (slug: string, scope: 'global' | 'project', hash = 'a'.repeat(64)): InstallRecord => ({
  slug, scope, kiroPath: '/k/.kiro', written: ['/k/.kiro/settings/mcp.json'], skillDir: '/k/.kiro/skills/' + slug,
  configSha256: hash, backup: true, installedAt: '2025-01-01T00:00:00.000Z',
});

describe('install records', () => {
  it('is empty at first, then stores, replaces the same (slug, scope) and deletes', async () => {
    const r = createInstallRecords({ appData });
    expect(await r.list()).toEqual([]);
    await r.put(rec('a', 'global'));
    await r.put(rec('a', 'project'));
    await r.put(rec('a', 'global', 'b'.repeat(64)));
    const list = await r.list();
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.scope === 'global')?.configSha256).toBe('b'.repeat(64));
    await r.delete('a', 'global');
    expect((await r.list()).map((x) => x.scope)).toEqual(['project']);
    expect((await readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('survives concurrent puts', async () => {
    const r = createInstallRecords({ appData });
    await Promise.all(['a', 'b', 'c', 'd'].map((s) => r.put(rec(s, 'global'))));
    expect((await r.list()).map((x) => x.slug).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('throws on an invalid file and when the folder is unusable', async () => {
    await writeFile(join(dir, 'kiro-installs.json'), '{"v":2}');
    await expect(createInstallRecords({ appData }).list()).rejects.toThrow();
    const bad: AppData = { dir: undefined, ensure: async () => ({ ok: false, problem: 'unresolved' }), check: async () => ({ ok: false, problem: 'unresolved' }) };
    await expect(createInstallRecords({ appData: bad }).put(rec('a', 'global'))).rejects.toThrow();
  });
});

describe('auto-add store', () => {
  it('reads nothing, writes, reads back, clears', async () => {
    const s = createAutoAddStore({ appData });
    expect(await s.read()).toBeUndefined();
    await s.write({ enabled: true, scope: 'project', workspacePath: '/w' });
    expect(await s.read()).toEqual({ enabled: true, scope: 'project', workspacePath: '/w' });
    await s.write({ enabled: true, scope: 'global', workspacePath: '/ignored' });
    expect(await s.read()).toEqual({ enabled: true, scope: 'global' });
    expect(JSON.parse(await readFile(join(dir, 'kiro-auto-add.json'), 'utf-8')).workspacePath).toBeUndefined();
    await s.clear();
    expect(await s.read()).toBeUndefined();
    await s.clear();
  });

  it('surfaces an unreadable file and an unusable folder on write', async () => {
    await writeFile(join(dir, 'kiro-auto-add.json'), 'not json');
    await expect(createAutoAddStore({ appData }).read()).rejects.toThrow();
    const bad: AppData = { dir: undefined, ensure: async () => ({ ok: false, problem: 'not-writable' }), check: async () => ({ ok: false, problem: 'not-writable' }) };
    await expect(createAutoAddStore({ appData: bad }).write({ enabled: true, scope: 'global' })).rejects.toThrow();
  });
});
