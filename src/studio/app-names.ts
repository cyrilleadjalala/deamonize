/**
 * Application names: a pure slug derivation plus the persistent Name_Map `<App_Data_Dir>/app-names.json`
 * that makes a slug stable across runs. See design "4. Names".
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
import type { WorkflowSet } from '../types.js';
import type { AppData } from './contracts.js';

/** origin = Application_Key. */
export type AppSource = { origin: string } | { name: string };

export const MAX_SLUG = 48;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAP_FILE = 'app-names.json';
const MAX_MAP_BYTES = 1024 * 1024;
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

export class AppNamesError extends Error { }

export interface AppNames {
  /** Stored slug, else the slug that `ensure` would store. Reads only. */
  peek(source: AppSource): Promise<string>;
  /** Stored slug, else derive, resolve a collision, write the map, return. Throws AppNamesError. */
  ensure(source: AppSource): Promise<string>;
}

const hyphenate = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Requirement 5.3: first 48 characters, cut before the last hyphen of the last 12, no trailing hyphen. */
function cut(slug: string): string {
  if (slug.length <= MAX_SLUG) return slug;
  let head = slug.slice(0, MAX_SLUG);
  const at = head.lastIndexOf('-');
  if (at >= MAX_SLUG - 12) head = head.slice(0, at);
  return head.replace(/-+$/g, '');
}

/** Pure. Rules of Requirements 5.1 to 5.4. */
export function deriveSlug(source: AppSource): string {
  let text: string;
  if ('origin' in source) {
    try {
      const url = new URL(source.origin);
      const host = domainToASCII(url.hostname) || url.hostname;
      const port = url.port !== '' && url.port !== DEFAULT_PORTS[url.protocol] ? `-${url.port}` : '';
      text = `${host}${port}`;
    } catch {
      text = source.origin;
    }
  } else {
    text = source.name;
  }
  const slug = cut(hyphenate(text));
  return slug === '' ? 'app' : slug;
}

/** Pure. `-2`, `-3`... with the base shortened so the total stays <= 48 and no trailing hyphen. */
export function withSuffix(base: string, n: number): string {
  const suffix = `-${n}`;
  const head = base.slice(0, Math.max(0, MAX_SLUG - suffix.length)).replace(/-+$/g, '');
  return `${head === '' ? 'app' : head}${suffix}`;
}

/** Name_Map key: the origin itself, or `name:<Action name>` for a source without an http(s) origin. */
export function mapKey(source: AppSource): string {
  return 'origin' in source ? source.origin : `name:${source.name}`;
}

/** Source of a loaded set: origin of `set.startUrl` for a web target, else the target name. */
export function sourceOfSet(set: WorkflowSet): AppSource {
  if (set.targetType === 'web' && set.startUrl !== undefined) {
    try {
      const url = new URL(set.startUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') return { origin: url.origin };
    } catch {
      // Not a URL: fall back to the name
    }
  }
  return { name: set.targetName };
}

type SlugMap = Record<string, string>;

async function readMap(dir: string): Promise<SlugMap> {
  const file = join(dir, MAP_FILE);
  let text: string;
  try {
    const info = await stat(file);
    if (info.size > MAX_MAP_BYTES) throw new AppNamesError('The name map is too large.');
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof AppNamesError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new AppNamesError('The name map cannot be read.');
  }
  if (Buffer.byteLength(text) > MAX_MAP_BYTES) throw new AppNamesError('The name map is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppNamesError('The name map is not valid.');
  }
  const apps = (parsed as { apps?: unknown } | null)?.apps;
  if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 1 || typeof apps !== 'object' || apps === null || Array.isArray(apps)) {
    throw new AppNamesError('The name map is not valid.');
  }
  const map: SlugMap = Object.create(null) as SlugMap;
  for (const [key, slug] of Object.entries(apps)) {
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) throw new AppNamesError('The name map is not valid.');
    map[key] = slug;
  }
  return map;
}

async function writeMap(dir: string, map: SlugMap): Promise<void> {
  const file = join(dir, MAP_FILE);
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  const bytes = JSON.stringify({ v: 1, apps: map }, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > MAX_MAP_BYTES) throw new AppNamesError('The name map is too large.');
  try {
    await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error instanceof AppNamesError ? error : new AppNamesError('The name map cannot be written.');
  }
}

/** The first free slug: the derived one, then `-2`, `-3`... */
function freeSlug(source: AppSource, map: SlugMap): string {
  const taken = new Set(Object.values(map));
  const base = deriveSlug(source);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = withSuffix(base, n);
    if (!taken.has(candidate)) return candidate;
  }
}

export function createAppNames(deps: { appData: AppData }): AppNames {
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(body: () => Promise<T>): Promise<T> => {
    const run = chain.then(body, body);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    async peek(source) {
      const check = await deps.appData.check();
      const map = check.ok ? await readMap(check.dir) : {};
      return map[mapKey(source)] ?? freeSlug(source, map);
    },
    ensure(source) {
      return exclusive(async () => {
        const check = await deps.appData.ensure();
        if (!check.ok) throw new AppNamesError('The application name cannot be saved.');
        const map = await readMap(check.dir);
        const key = mapKey(source);
        const stored = map[key];
        if (stored !== undefined) return stored;
        const slug = freeSlug(source, map);
        await writeMap(check.dir, { ...map, [key]: slug });
        return slug;
      });
    },
  };
}
