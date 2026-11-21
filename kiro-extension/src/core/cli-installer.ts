import type { FsPort } from './cli-locator';
import type { Redactor } from './ports';

/** G0 seam: types and signatures are final; the bodies belong to group G-E3. */

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

/** `node` plus `npm-cli.js` next to it (Windows: `<nodeDir>/node_modules/npm/bin/npm-cli.js`; elsewhere `<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js`). */
export function locateNpmCli(_nodePath: string, _platform: NodeJS.Platform, _fs: FsPort): Promise<string | undefined> {
  throw new Error('not implemented: G-E3');
}

/** Arguments array, never a shell; staging folder, check (`--version`, `studio --help` lists `--machine`), then move it into place. */
export function installCli(_ports: InstallerPorts, _target: string, _platform: NodeJS.Platform): Promise<InstallResult> {
  throw new Error('not implemented: G-E3');
}
