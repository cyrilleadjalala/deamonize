import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppNamesError, createAppNames, deriveSlug, sourceOfSet, withSuffix } from '../../src/studio/app-names';
import type { AppData } from '../../src/studio/contracts';

describe('app-names', () => {
  let dir: string;
  const appData = (): AppData => ({ dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'app-names-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('derives slugs from origins', () => {
    expect(deriveSlug({ origin: 'https://cycyly.vercel.app' })).toBe('cycyly-vercel-app');
    expect(deriveSlug({ origin: 'http://localhost:3000' })).toBe('localhost-3000');
    expect(deriveSlug({ origin: 'https://example.com:443' })).toBe('example-com');
    expect(deriveSlug({ origin: 'http://example.com:8080' })).toBe('example-com-8080');
  });

  it('converts an internationalized host to punycode', () => {
    expect(deriveSlug({ origin: 'https://b\u00fccher.example' })).toBe('xn-bcher-kva-example');
  });

  it('cuts a 60-character host at 48 characters, before a hyphen of the last 12', () => {
    expect(deriveSlug({ origin: `https://${'a'.repeat(60)}.com` })).toBe('a'.repeat(48));
    const cutAtHyphen = deriveSlug({ origin: `https://${'a'.repeat(40)}.bcdef.ghijklmnop.com` });
    expect(cutAtHyphen).toBe(`${'a'.repeat(40)}-bcdef`);
  });

  it('falls back to the Action name, then to app', () => {
    expect(deriveSlug({ name: 'Mon Appli \u00c9t\u00e9' })).toBe('mon-appli-t');
    expect(deriveSlug({ name: '' })).toBe('app');
    expect(deriveSlug({ name: '\u65e5\u672c\u8a9e' })).toBe('app');
  });

  it('shortens the base for a suffix', () => {
    expect(withSuffix('shop', 2)).toBe('shop-2');
    const out = withSuffix('a'.repeat(47) + '-b', 12);
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out.endsWith('-12')).toBe(true);
  });

  it('uses the origin of a web set and the name otherwise', () => {
    expect(sourceOfSet({ targetType: 'web', targetName: 'X', startUrl: 'https://a.example/path?q=1' } as never)).toEqual({ origin: 'https://a.example' });
    expect(sourceOfSet({ targetType: 'tui', targetName: 'htop' } as never)).toEqual({ name: 'htop' });
  });

  it('suffixes a collision and keeps the stored slug', async () => {
    const names = createAppNames({ appData: appData() });
    expect(await names.ensure({ origin: 'https://a.b.com' })).toBe('a-b-com');
    expect(await names.ensure({ name: 'a b com' })).toBe('a-b-com-2');
    expect(await names.ensure({ origin: 'https://a.b.com' })).toBe('a-b-com');
    expect(await createAppNames({ appData: appData() }).peek({ name: 'a b com' })).toBe('a-b-com-2');
  });

  it('serializes concurrent ensure calls', async () => {
    const names = createAppNames({ appData: appData() });
    const slugs = await Promise.all([{ name: 'x y' }, { name: 'x-y' }, { name: 'X Y' }].map((s) => names.ensure(s)));
    expect(new Set(slugs).size).toBe(3);
  });

  it('writes the map atomically without leftovers', async () => {
    await createAppNames({ appData: appData() }).ensure({ name: 'Shop' });
    expect(await readdir(dir)).toEqual(['app-names.json']);
    expect(JSON.parse(await readFile(join(dir, 'app-names.json'), 'utf8'))).toEqual({ v: 1, apps: { 'name:Shop': 'shop' } });
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['wrong shape', '[]'],
    ['bad slug', JSON.stringify({ v: 1, apps: { k: 'Bad Slug' } })],
    ['too large', ' '.repeat(1024 * 1024 + 1)],
  ])('refuses an unusable map (%s) and writes nothing', async (_n, content) => {
    await writeFile(join(dir, 'app-names.json'), content);
    await expect(createAppNames({ appData: appData() }).ensure({ name: 'Shop' })).rejects.toBeInstanceOf(AppNamesError);
    expect(await readFile(join(dir, 'app-names.json'), 'utf8')).toBe(content);
    expect(await readdir(dir)).toEqual(['app-names.json']);
  });

  it('refuses when the App_Data_Dir is unusable', async () => {
    const bad: AppData = { dir: undefined, ensure: async () => ({ ok: false, problem: 'unresolved' }), check: async () => ({ ok: false, problem: 'unresolved' }) };
    await expect(createAppNames({ appData: bad }).ensure({ name: 'Shop' })).rejects.toBeInstanceOf(AppNamesError);
  });

  it('refuses when the map cannot be written', async () => {
    const missing: AppData = { dir: join(dir, 'nope'), ensure: async () => ({ ok: true, dir: join(dir, 'nope') }), check: async () => ({ ok: true, dir: join(dir, 'nope') }) };
    await expect(createAppNames({ appData: missing }).ensure({ name: 'Shop' })).rejects.toBeInstanceOf(AppNamesError);
  });
});
