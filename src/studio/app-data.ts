/**
 * The App_Data_Dir: the per-user folder for the secret vault and saved sessions.
 * It must never be inside the working directory, a git work tree or the Output_Dir, so nothing in it can be committed.
 */
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep, win32, posix } from 'node:path';
import type { AppData, AppDataCheck } from './contracts.js';

export interface AppDataOptions {
  /** Working directory (default process.cwd()). */
  cwd?: string;
  /** The Output_Dir of the Studio. */
  outDir: string;
  /** Environment (default process.env). */
  env?: Record<string, string | undefined>;
  /** Default process.platform. */
  platform?: NodeJS.Platform;
  /** Default os.homedir(). */
  home?: string;
}

/** The folder chosen for a platform, or undefined when `DAEMONIZE_DATA_DIR` is not an absolute path. */
export function defaultAppDataDir(options: Pick<AppDataOptions, 'env' | 'platform' | 'home'> = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const path = platform === 'win32' ? win32 : posix;
  const override = env.DAEMONIZE_DATA_DIR;
  if (override !== undefined && override !== '') {
    return path.isAbsolute(override) ? override : undefined;
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    return local !== undefined && local !== '' && path.isAbsolute(local) ? path.join(local, 'Daemonize') : path.join(home, 'AppData', 'Local', 'Daemonize');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Daemonize');
  const xdg = env.XDG_DATA_HOME;
  return xdg !== undefined && xdg !== '' && path.isAbsolute(xdg) ? path.join(xdg, 'daemonize') : path.join(home, '.local', 'share', 'daemonize');
}

/** realpath of the deepest existing ancestor, with the missing tail appended. */
async function resolveReal(target: string): Promise<string> {
  let current = resolve(target);
  const tail: string[] = [];
  for (; ;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
      current = parent;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function createAppData(options: AppDataOptions): AppData {
  const platform = options.platform ?? process.platform;
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const norm = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);
  const dir = defaultAppDataDir(options);
  const inside = (a: string, b: string): boolean => {
    const x = norm(a);
    const y = norm(b);
    return x === y || x.startsWith(y.endsWith(sep) ? y : y + sep);
  };

  const check = async (): Promise<AppDataCheck> => {
    if (dir === undefined) return { ok: false, problem: 'unresolved' };
    const real = await resolveReal(dir);
    const cwd = await resolveReal(options.cwd ?? process.cwd());
    if (inside(real, cwd)) return { ok: false, problem: 'inside-working-dir' };
    if (inside(real, await resolveReal(options.outDir))) return { ok: false, problem: 'inside-output-dir' };
    // Inside any directory that holds `.git` (a file counts: worktrees), the folder itself included
    for (let current = real; ;) {
      if (await exists(join(current, '.git'))) return { ok: false, problem: 'inside-git-repo' };
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return { ok: true, dir: real };
  };

  return {
    dir,
    check,
    async ensure(): Promise<AppDataCheck> {
      const result = await check();
      if (!result.ok) return result;
      try {
        await mkdir(result.dir, { recursive: true, mode: 0o700 });
      } catch {
        return { ok: false, problem: 'not-writable' };
      }
      return result;
    },
  };
}

/** An AppData that is never usable (sample mode, tests). */
export const unavailableAppData: AppData = {
  dir: undefined,
  check: async () => ({ ok: false, problem: 'unresolved' }),
  ensure: async () => ({ ok: false, problem: 'unresolved' }),
};
