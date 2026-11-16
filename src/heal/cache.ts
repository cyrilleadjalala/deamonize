/**
 * Heal cache: remembers which locator a model found for a step, so the next call needs no model.
 * It lives in `<outputDir>/.daemonize/heal-cache.json` (or `DAEMONIZE_HEAL_CACHE`), never in the workflow
 * file, and holds only locator descriptors: no typed values, screenshots or secrets.
 */
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const HEAL_CACHE_VERSION = '1';
export const MAX_CACHE_ENTRIES = 500;

/** What a repair resolved to. Coordinates are fractions of the viewport and are used only when no locator exists. */
export type CachedLocator =
  | { role: string; name?: string; parent?: { role: string; name?: string } }
  | { text: string }
  | { css: string }
  | { point: { x: number; y: number } };

export interface HealCacheEntry {
  locator: CachedLocator;
  healedAt: string;
  lastUsed: string;
  hits: number;
}

interface CacheFile {
  version: string;
  entries: Record<string, HealCacheEntry>;
}

export interface CacheKeyParts {
  workflowId: string;
  stepIndex: number;
  /** Stable description of the recorded anchor (names, never typed values). */
  anchor?: string;
  intent?: string;
  pageTitle?: string;
}

export function healCachePath(outputDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DAEMONIZE_HEAL_CACHE?.trim();
  return override ? resolve(override) : join(resolve(outputDir), '.daemonize', 'heal-cache.json');
}

export function healCacheKey(parts: CacheKeyParts): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([parts.anchor ?? '', parts.intent ?? '', parts.pageTitle ?? '']))
    .digest('hex')
    .slice(0, 16);
  return `${parts.workflowId}#${parts.stepIndex}#${digest}`;
}

const clip = (s: unknown, n = 200): string | undefined => (typeof s === 'string' && s ? s.slice(0, n) : undefined);
const fraction = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined);

/** Keep only known descriptor fields; anything else (a stray value, a secret) is dropped. */
export function sanitizeLocator(input: unknown): CachedLocator | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const l = input as Record<string, unknown>;
  const role = clip(l.role, 40);
  if (role) {
    const out: { role: string; name?: string; parent?: { role: string; name?: string } } = { role };
    const name = clip(l.name);
    if (name) out.name = name;
    const p = l.parent as Record<string, unknown> | undefined;
    const parentRole = p && typeof p === 'object' ? clip(p.role, 40) : undefined;
    if (parentRole) {
      out.parent = { role: parentRole };
      const parentName = clip(p?.name);
      if (parentName) out.parent.name = parentName;
    }
    return out;
  }
  const text = clip(l.text);
  if (text) return { text };
  const css = clip(l.css, 300);
  if (css) return { css };
  const pt = l.point as Record<string, unknown> | undefined;
  if (pt && typeof pt === 'object') {
    const x = fraction(pt.x);
    const y = fraction(pt.y);
    if (x !== undefined && y !== undefined) return { point: { x, y } };
  }
  return undefined;
}

/**
 * A path as the file system sees it: symlinks resolved (through the deepest part that exists, so a cache that does
 * not exist yet is still placed correctly), ./.. removed, and case folded where the file system ignores case.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  let probe = absolute;
  let real = absolute;
  for (;;) {
    try {
      real = realpathSync.native(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      rest.unshift(basename(probe));
      probe = parent;
      real = parent;
    }
  }
  const full = rest.length > 0 ? join(real, ...rest) : real;
  return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full;
}

/** True when 	arget is protectedPath, lies inside it (a protected folder) or contains it (a folder holding it). */
function collides(target: string, protectedPath: string): boolean {
  const a = canonicalPath(target);
  const b = canonicalPath(protectedPath);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

export interface HealCacheOptions {
  maxEntries?: number;
  now?: () => Date;
  /** Paths the cache must never be, be inside, or contain: the workflow file and its assets folder. */
  protectedPaths?: string[];
}

export class HealCache {
  private readonly max: number;
  private readonly now: () => Date;

  constructor(readonly path: string, options: HealCacheOptions = {}) {
    this.max = options.maxEntries ?? MAX_CACHE_ENTRIES;
    this.now = options.now ?? (() => new Date());
    if ((options.protectedPaths ?? []).some((p) => collides(path, p))) {
      throw new Error('the heal cache must not be the workflow file');
    }
  }

  /** The entry for a key, counting a hit; undefined on a miss. */
  async get(key: string): Promise<HealCacheEntry | undefined> {
    const file = await this.load();
    const entry = file.entries[key];
    if (!entry) return undefined;
    entry.hits += 1;
    entry.lastUsed = this.now().toISOString();
    await this.save(file);
    return { ...entry };
  }

  /** Store a repaired locator. Returns false when the locator had nothing storable. */
  async put(key: string, locator: unknown): Promise<boolean> {
    const clean = sanitizeLocator(locator);
    if (!clean) return false;
    const file = await this.load();
    const stamp = this.now().toISOString();
    file.entries[key] = { locator: clean, healedAt: stamp, lastUsed: stamp, hits: 0 };
    await this.save(file);
    return true;
  }

  /** Forget an entry (the cached locator stopped working). */
  async drop(key: string): Promise<void> {
    const file = await this.load();
    if (!(key in file.entries)) return;
    delete file.entries[key];
    await this.save(file);
  }

  async size(): Promise<number> {
    return Object.keys((await this.load()).entries).length;
  }

  private async load(): Promise<CacheFile> {
    const empty: CacheFile = { version: HEAL_CACHE_VERSION, entries: {} };
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return empty;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CacheFile>;
      if (parsed.version !== HEAL_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') return empty;
      for (const [key, entry] of Object.entries(parsed.entries)) {
        const locator = sanitizeLocator(entry?.locator);
        if (!locator || typeof entry.healedAt !== 'string') continue;
        empty.entries[key] = {
          locator,
          healedAt: entry.healedAt,
          lastUsed: typeof entry.lastUsed === 'string' ? entry.lastUsed : entry.healedAt,
          hits: Number.isInteger(entry.hits) && entry.hits >= 0 ? entry.hits : 0,
        };
      }
      return empty;
    } catch {
      // Corrupt file: start again; the next save rewrites it
      return empty;
    }
  }

  private async save(file: CacheFile): Promise<void> {
    const keys = Object.keys(file.entries);
    if (keys.length > this.max) {
      keys
        .sort((a, b) => file.entries[a].lastUsed.localeCompare(file.entries[b].lastUsed) || a.localeCompare(b))
        .slice(0, keys.length - this.max)
        .forEach((k) => delete file.entries[k]);
    }
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
      await rename(tmp, this.path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }
}
