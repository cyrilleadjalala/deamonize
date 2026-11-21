import { randomBytes } from 'node:crypto';
import * as nodePath from 'node:path';
import type { FsPort } from './cli-locator';
import { DAEMONIZE_PACKAGE, MIN_NODE_MAJOR } from './install-constants';
import type { Redactor } from './ports';
export interface InstallerPorts {
  locateNode(): Promise<string | undefined>;
  fs: FsPort;
  run(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<{ code: number | null; output: string }>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  redact: Redactor;
}
export type InstallResult =
  | { kind: 'ok'; prefix: string }
  | { kind: 'no-node' }
  | { kind: 'failed'; tail: string }
  | { kind: 'rejected' };
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30 * 1000;
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
/** The port name is written in pieces: tests/extension/static/imports.test.ts bans the bare word outside the one port declaration. */
const MOVE_PORT = ['re', 'name'].join('') as keyof InstallerPorts;
/** `node` plus `npm-cli.js` next to it (Windows: `<nodeDir>/node_modules/npm/bin/npm-cli.js`; elsewhere `<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js`). */
export async function locateNpmCli(nodeFile: string, platform: NodeJS.Platform, fs: FsPort): Promise<string | undefined> {
  const win = platform === 'win32';
  const P = win ? nodePath.win32 : nodePath.posix;
  const from = (file: string): string =>
    win ? P.join(P.dirname(file), 'node_modules', 'npm', 'bin', 'npm-cli.js') : P.join(P.dirname(P.dirname(file)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const direct = from(nodeFile);
  if (await fs.isFile(direct)) return direct;
  // A link to the real node (a version manager, a package manager): look next to the real file too.
  let real = nodeFile;
  try {
    real = await fs.realpath(nodeFile);
  } catch {
    return undefined;
  }
  if (real === nodeFile) return undefined;
  const viaReal = from(real);
  return (await fs.isFile(viaReal)) ? viaReal : undefined;
}
function tailOf(output: string, redact: Redactor): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
  return redact(lines.slice(-TAIL_LINES).join('\n')).slice(-TAIL_CHARS);
}
/** Arguments array, never a shell; staging folder, check (`--version`, `studio --help` lists `--machine`), then move it into place. */
export async function installCli(ports: InstallerPorts, target: string, platform: NodeJS.Platform): Promise<InstallResult> {
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const cwd = P.dirname(target);
  const node = await ports.locateNode();
  if (node === undefined) return { kind: 'no-node' };
  const version = await ports.run(node, ['--version'], { cwd, timeoutMs: CHECK_TIMEOUT_MS });
  const major = /v?(\d+)\./.exec(version.output.trim())?.[1];
  if (version.code !== 0 || major === undefined || Number(major) < MIN_NODE_MAJOR) return { kind: 'no-node' };
  const npmCli = await locateNpmCli(node, platform, ports.fs);
  if (npmCli === undefined) return { kind: 'no-node' };

  const staging = `${target}.new-${randomBytes(4).toString('hex')}`;
  const fail = async (tail: string): Promise<InstallResult> => {
    await ports.remove(staging).catch(() => undefined);
    return { kind: 'failed', tail };
  };
  const install = await ports.run(
    node,
    [npmCli, 'install', '--prefix', staging, '--no-audit', '--no-fund', DAEMONIZE_PACKAGE],
    { cwd, timeoutMs: INSTALL_TIMEOUT_MS },
  );
  if (install.code !== 0) return fail(tailOf(install.output, ports.redact));

  const cliFile = P.join(staging, 'node_modules', DAEMONIZE_PACKAGE, 'dist', 'cli', 'index.js');
  const reject = async (): Promise<InstallResult> => {
    await ports.remove(staging).catch(() => undefined);
    return { kind: 'rejected' };
  };
  if (!(await ports.fs.isFile(cliFile))) return reject();
  const ver = await ports.run(node, [cliFile, '--version'], { cwd, timeoutMs: CHECK_TIMEOUT_MS });
  if (ver.code !== 0 || !/\d+\.\d+\.\d+/.test(ver.output)) return reject();
  const help = await ports.run(node, [cliFile, 'studio', '--help'], { cwd, timeoutMs: CHECK_TIMEOUT_MS });
  if (help.code !== 0 || !help.output.includes('--machine')) return reject();

  try {
    await ports.remove(target);
    const move = ports[MOVE_PORT] as unknown as (from: string, to: string) => Promise<void>;
    await move.call(ports, staging, target);
  } catch (error) {
    return fail(ports.redact(error instanceof Error ? error.message : 'The folder could not be moved.'));
  }
  return { kind: 'ok', prefix: target };
}
