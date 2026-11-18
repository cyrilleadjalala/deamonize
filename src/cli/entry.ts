import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The real path of a file, or the plain resolved path when it cannot be read (deleted, permission). */
function real(path: string, realpath: (p: string) => string): string {
  try {
    return realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when the module at `moduleUrl` is the script Node was started with (`argv1`).
 * Both sides go through realpath, so a launch through an `npm link` symlink or junction, or a global npm shim,
 * still counts. Windows and macOS file systems ignore case (the drive letter differs between `C:` and `c:`).
 */
export function isEntryPoint(
  moduleUrl: string,
  argv1: string | undefined,
  platform: NodeJS.Platform = process.platform,
  realpath: (p: string) => string = realpathSync.native
): boolean {
  if (!argv1) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const a = real(modulePath, realpath);
  const b = real(argv1, realpath);
  return platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}