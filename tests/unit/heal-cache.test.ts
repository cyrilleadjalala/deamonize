import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealCache, healCacheKey, healCachePath } from '../../src/heal/cache.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'heal-cache-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('healCacheKey / healCachePath', () => {
  it('is stable and changes with each part', () => {
    const base = { workflowId: 'wf', stepIndex: 4, anchor: 'button Remove', intent: 'remove', pageTitle: 'Cart' };
    expect(healCacheKey(base)).toBe(healCacheKey({ ...base }));
    expect(healCacheKey(base)).toMatch(/^wf#4#[0-9a-f]{16}$/);
    for (const change of [{ stepIndex: 5 }, { workflowId: 'x' }, { anchor: 'a' }, { intent: 'i' }, { pageTitle: 't' }]) {
      expect(healCacheKey({ ...base, ...change })).not.toBe(healCacheKey(base));
    }
  });
  it('defaults under .daemonize and honors DAEMONIZE_HEAL_CACHE', () => {
    expect(healCachePath(dir, {})).toBe(join(dir, '.daemonize', 'heal-cache.json'));
    expect(healCachePath(dir, { DAEMONIZE_HEAL_CACHE: join(dir, 'x.json') })).toBe(join(dir, 'x.json'));
  });
});

describe('HealCache', () => {
  it('misses, stores, hits and counts hits; creates the directory', async () => {
    const cache = new HealCache(healCachePath(dir, {}));
    expect(await cache.get('k')).toBeUndefined();
    expect(await cache.put('k', { role: 'button', name: 'Remove', parent: { role: 'row', name: 'Item 1' } })).toBe(true);
    const first = await cache.get('k');
    expect(first?.locator).toEqual({ role: 'button', name: 'Remove', parent: { role: 'row', name: 'Item 1' } });
    expect(first?.hits).toBe(1);
    expect((await cache.get('k'))?.hits).toBe(2);
    await cache.drop('k');
    expect(await cache.get('k')).toBeUndefined();
  });

  it('survives a new instance (persisted) and rewrites a corrupt file', async () => {
    const path = join(dir, 'c.json');
    await new HealCache(path).put('k', { text: 'Hello' });
    expect((await new HealCache(path).get('k'))?.locator).toEqual({ text: 'Hello' });
    for (const garbage of ['{not json', '[]', '{"version":"9","entries":{}}', '']) {
      await writeFile(path, garbage);
      const cache = new HealCache(path);
      expect(await cache.get('k')).toBeUndefined();
      await cache.put('k2', { css: '#a' });
      expect(JSON.parse(await readFile(path, 'utf8')).version).toBe('1');
    }
  });

  it('keeps at most maxEntries, dropping the least recently used', async () => {
    let t = 0;
    const cache = new HealCache(join(dir, 'c.json'), { maxEntries: 3, now: () => new Date(1_700_000_000_000 + ++t * 1000) });
    for (const k of ['a', 'b', 'c']) await cache.put(k, { text: k });
    await cache.get('a'); // a is now newer than b
    await cache.put('d', { text: 'd' });
    expect(await cache.size()).toBe(3);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBeDefined();
  });

  it('defaults to a 500 entry bound', async () => {
    const path = join(dir, 'c.json');
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < 520; i++) entries[`k${i}`] = { locator: { text: 't' }, healedAt: new Date(i * 1000).toISOString(), lastUsed: new Date(i * 1000).toISOString(), hits: 0 };
    await writeFile(path, JSON.stringify({ version: '1', entries }));
    const cache = new HealCache(path);
    await cache.put('new', { text: 'n' });
    expect(await cache.size()).toBe(500);
  });

  it('writes atomically: no temp files remain', async () => {
    const path = join(dir, '.daemonize', 'c.json');
    const cache = new HealCache(path);
    await Promise.all([cache.put('a', { text: 'a' }), cache.put('b', { text: 'b' })].map((p) => p.catch(() => undefined)));
    expect((await readdir(join(dir, '.daemonize'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    JSON.parse(await readFile(path, 'utf8'));
  });

  it('stores only locator descriptors: stray fields and secrets are dropped', async () => {
    const path = join(dir, 'c.json');
    const cache = new HealCache(path);
    await cache.put('k', { role: 'textbox', name: 'Email', value: 'SECRET-typed', password: 'SECRET-pw', screenshot: 'SECRET-img' });
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('SECRET');
    expect(await cache.put('bad', { value: 'SECRET-x' })).toBe(false);
    expect(await cache.put('badpoint', { point: { x: 800, y: 3 } })).toBe(false);
    expect(await cache.put('pt', { point: { x: 0.5, y: 0.25 } })).toBe(true);
  });

  it('refuses to be the workflow file and never touches it', async () => {
    const wf = join(dir, 'wf.workflow.json');
    await mkdir(dir, { recursive: true });
    await writeFile(wf, '{"steps":[]}');
    expect(() => new HealCache(wf, { protectedPaths: [wf] })).toThrow();
    const cache = new HealCache(healCachePath(dir, {}), { protectedPaths: [wf] });
    await cache.put('k', { text: 'x' });
    expect(await readFile(wf, 'utf8')).toBe('{"steps":[]}');
  });
});
