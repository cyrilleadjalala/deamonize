/** Group G3: saved browser sessions (Playwright storage states), one file per Application_Key in the App_Data_Dir. */
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionSaveError, type AppData, type SessionStore } from './contracts.js';
import { InertSessionStore } from './inert-services.js';
import { SESSION_STORE_UNAVAILABLE } from './messages/record.js';
import { storageStateValues } from './redact.js';
import { applicationKey } from './validate-action.js';

export interface SessionStoreDeps {
  appData: AppData;
}

const MAX_BYTES = 5 * 1024 * 1024;
const SUFFIX = '.storage-state.json';

/** `<first 40 hex characters of sha256(key)>.storage-state.json` */
export function sessionFileName(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 40) + SUFFIX;
}

function isStorageState(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as { cookies?: unknown; origins?: unknown };
  return Array.isArray(v.cookies) || Array.isArray(v.origins);
}

export class FileSessionStore implements SessionStore {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; values: string[] }>();

  constructor(private readonly appData: AppData) { }

  keyFor(url: string): string | undefined {
    return applicationKey(url);
  }

  private async read(file: string): Promise<unknown | undefined> {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_BYTES) return undefined;
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      return isStorageState(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async pathFor(key: string): Promise<string | undefined> {
    const check = await this.appData.check();
    if (!check.ok) return undefined;
    const file = join(check.dir, sessionFileName(key));
    return (await this.read(file)) === undefined ? undefined : file;
  }

  async available(key: string): Promise<boolean> {
    return (await this.pathFor(key)) !== undefined;
  }

  async save(key: string, state: unknown): Promise<void> {
    const ensured = await this.appData.ensure();
    if (!ensured.ok) throw new SessionSaveError(SESSION_STORE_UNAVAILABLE);
    const file = join(ensured.dir, sessionFileName(key));
    const temp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
      this.cache.delete(file);
    } catch {
      await unlink(temp).catch(() => undefined);
      throw new SessionSaveError('The session file could not be written.');
    }
  }

  async forget(key: string): Promise<void> {
    const check = await this.appData.check();
    if (!check.ok) return;
    const file = join(check.dir, sessionFileName(key));
    try {
      await unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.cache.delete(file);
  }

  knownValues(): readonly string[] {
    return [...this.cache.values()].flatMap((entry) => entry.values);
  }

  async refresh(): Promise<void> {
    const check = await this.appData.check();
    if (!check.ok) {
      this.cache.clear();
      return;
    }
    let names: string[];
    try {
      names = (await readdir(check.dir)).filter((n) => n.endsWith(SUFFIX));
    } catch {
      this.cache.clear();
      return;
    }
    const seen = new Set<string>();
    for (const name of names) {
      const file = join(check.dir, name);
      seen.add(file);
      try {
        const info = await stat(file);
        const known = this.cache.get(file);
        if (known !== undefined && known.mtimeMs === info.mtimeMs && known.size === info.size) continue;
        const state = await this.read(file);
        this.cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, values: state === undefined ? [] : storageStateValues(state) });
      } catch {
        this.cache.delete(file);
      }
    }
    for (const file of [...this.cache.keys()]) if (!seen.has(file)) this.cache.delete(file);
  }

  async problem(): Promise<string | undefined> {
    const check = await this.appData.check();
    return check.ok ? undefined : SESSION_STORE_UNAVAILABLE;
  }
}

/** Kept for the stub's exported name. */
export class NullSessionStore extends InertSessionStore { }

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  return new FileSessionStore(deps.appData);
}
