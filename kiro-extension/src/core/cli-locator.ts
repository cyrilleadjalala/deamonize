import * as nodePath from 'node:path';

/** File system access the locator needs. Injected so tests run without a disk. */
export interface FsPort {
  isFile(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  readText(path: string, maxBytes: number): Promise<string | undefined>;
}

export interface LocatorInput {
  /** Setting daemonize.cliPath ('' = unset). */
  cliPath: string;
  /** Setting daemonize.nodePath ('' = unset). */
  nodePath: string;
  workspaceFolder: string;
  /** The folder the extension installs into (<globalStorage>/cli); '' or missing = none. */
  extensionFolder?: string;
  /** PATH split, in order. */
  pathEntries: string[];
  platform: NodeJS.Platform;
  /** process.execPath */
  execPath: string;
  fs: FsPort;
}

export type LocatorResult =
  | { kind: 'ok'; command: string; baseArgs: string[]; extraEnv: Record<string, string>; cliFile: string; usedElectronNode: boolean }
  | { kind: 'not-found' }
  | { kind: 'configured-missing'; path: string }
  | { kind: 'unsupported-shim'; path: string };

const SHIM_LIMIT = 64 * 1024;
const SHIM_PATTERN = /"%dp0%\\([^"]+?\.js)"/i;

/** Finds the Daemonize program without a shell. The result depends only on the input. */
export async function locateCli(input: LocatorInput): Promise<LocatorResult> {
  const win = input.platform === 'win32';
  const P = win ? nodePath.win32 : nodePath.posix;
  const { fs } = input;

  const withNode = async (cliFile: string): Promise<LocatorResult> => {
    if (input.nodePath !== '') {
      if (!(await fs.isFile(input.nodePath))) return { kind: 'configured-missing', path: input.nodePath };
      return { kind: 'ok', command: input.nodePath, baseArgs: [cliFile], extraEnv: {}, cliFile, usedElectronNode: false };
    }
    const nodeName = win ? 'node.exe' : 'node';
    for (const dir of input.pathEntries) {
      if (dir === '') continue;
      const candidate = P.join(dir, nodeName);
      if (await fs.isFile(candidate)) {
        return { kind: 'ok', command: candidate, baseArgs: [cliFile], extraEnv: {}, cliFile, usedElectronNode: false };
      }
    }
    return { kind: 'ok', command: input.execPath, baseArgs: [cliFile], extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, cliFile, usedElectronNode: true };
  };

  const direct = (file: string): LocatorResult => ({ kind: 'ok', command: file, baseArgs: [], extraEnv: {}, cliFile: file, usedElectronNode: false });

  const resolveFile = async (file: string): Promise<LocatorResult> => {
    const lower = file.toLowerCase();
    if (/\.(js|mjs|cjs)$/.test(lower)) return withNode(file);
    if (win) {
      if (/\.(cmd|bat)$/.test(lower)) {
        const text = await fs.readText(file, SHIM_LIMIT);
        const match = text === undefined ? null : SHIM_PATTERN.exec(text);
        if (match === null) return { kind: 'unsupported-shim', path: file };
        const js = P.join(P.dirname(file), match[1]!);
        if (!(await fs.isFile(js))) return { kind: 'unsupported-shim', path: file };
        return withNode(js);
      }
      if (/\.(exe|com)$/.test(lower)) return direct(file);
      return { kind: 'unsupported-shim', path: file };
    }
    let real = file;
    try {
      real = await fs.realpath(file);
    } catch {
      real = file;
    }
    if (/\.(js|mjs|cjs)$/i.test(real)) return withNode(real);
    return direct(file);
  };

  if (input.cliPath !== '') {
    if (!(await fs.isFile(input.cliPath))) return { kind: 'configured-missing', path: input.cliPath };
    return resolveFile(input.cliPath);
  }

  const candidates: string[] = [];
  const own = input.extensionFolder ?? '';
  if (own !== '') {
    candidates.push(P.join(own, 'node_modules', '.bin', win ? 'daemonize.cmd' : 'daemonize'), P.join(own, 'node_modules', 'daemonize', 'dist', 'cli', 'index.js'));
  }
  candidates.push(
    P.join(input.workspaceFolder, 'node_modules', '.bin', win ? 'daemonize.cmd' : 'daemonize'),
    P.join(input.workspaceFolder, 'node_modules', 'daemonize', 'dist', 'cli', 'index.js'),
  );
  const names = win ? ['daemonize.cmd', 'daemonize.exe'] : ['daemonize'];
  for (const dir of input.pathEntries) {
    if (dir === '') continue;
    for (const name of names) candidates.push(P.join(dir, name));
  }
  for (const candidate of candidates) {
    if (await fs.isFile(candidate)) return resolveFile(candidate);
  }
  return { kind: 'not-found' };
}
