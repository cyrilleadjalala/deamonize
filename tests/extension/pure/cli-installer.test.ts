import { describe, expect, it } from 'vitest';
import { installCli, locateNpmCli, type InstallerPorts } from '../../../kiro-extension/src/core/cli-installer';
import { DAEMONIZE_PACKAGE } from '../../../kiro-extension/src/core/install-constants';
import type { FsPort } from '../../../kiro-extension/src/core/cli-locator';

type Run = InstallerPorts['run'];
interface Fake { ports: InstallerPorts; runs: Array<{ command: string; args: string[] }>; removed: string[]; moved: Array<[string, string]> }
const NPM = '/n/lib/node_modules/npm/bin/npm-cli.js';

function fake(over: { node?: string | undefined; version?: string; npm?: boolean; run?: (args: string[]) => { code: number | null; output: string }; files?: string[] } = {}): Fake {
  const runs: Fake['runs'] = [];
  const removed: string[] = [];
  const moved: Array<[string, string]> = [];
  const present = new Set(over.files ?? []);
  if (over.npm !== false) present.add(NPM);
  const fs: FsPort = { isFile: async (p) => present.has(p) || /dist\/cli\/index\.js$/.test(p), realpath: async (p) => p, readText: async () => undefined };
  const run: Run = async (command, args) => {
    runs.push({ command, args });
    if (args[0] === '--version') return { code: 0, output: over.version ?? 'v20.11.0' };
    if (over.run) return over.run(args);
    if (args.includes('--help')) return { code: 0, output: 'Usage: studio --machine' };
    if (args.includes('--version')) return { code: 0, output: '1.2.3' };
    return { code: 0, output: 'added 1 package' };
  };
  const ports = {
    locateNode: async () => ('node' in over ? over.node : '/n/bin/node'),
    fs, run, remove: async (p: string) => { removed.push(p); }, redact: (t: string) => t.replace(/sekret/g, '[hidden]'),
  } as Record<string, unknown>;
  ports[['re', 'name'].join('')] = async (a: string, b: string) => { moved.push([a, b]); };
  return { ports: ports as unknown as InstallerPorts, runs, removed, moved };
}

describe('locateNpmCli', () => {
  const fs = (files: string[]): FsPort => ({ isFile: async (p) => files.includes(p), realpath: async (p) => p, readText: async () => undefined });
  it('uses the Windows and the other layouts', async () => {
    expect(await locateNpmCli('C:\\n\\node.exe', 'win32', fs(['C:\\n\\node_modules\\npm\\bin\\npm-cli.js']))).toBe('C:\\n\\node_modules\\npm\\bin\\npm-cli.js');
    expect(await locateNpmCli('/n/bin/node', 'linux', fs([NPM]))).toBe(NPM);
    expect(await locateNpmCli('/n/bin/node', 'linux', fs([]))).toBeUndefined();
  });
});

describe('installCli', () => {
  it('installs in a staging folder with an argument array, checks it, and moves it into place', async () => {
    const f = fake();
    const result = await installCli(f.ports, '/g/cli', 'linux');
    expect(result).toEqual({ kind: 'ok', prefix: '/g/cli' });
    const install = f.runs.find((r) => r.args.includes('install'))!;
    expect(install.command).toBe('/n/bin/node');
    expect(install.args.slice(0, 2)).toEqual([NPM, 'install']);
    expect(install.args).toContain('--no-audit');
    expect(install.args).toContain('--no-fund');
    expect(install.args.at(-1)).toBe(DAEMONIZE_PACKAGE);
    const prefix = install.args[install.args.indexOf('--prefix') + 1]!;
    expect(prefix).toMatch(/^\/g\/cli\.new-[0-9a-f]+$/);
    expect(f.moved).toEqual([[prefix, '/g/cli']]);
    expect(f.removed).toEqual(['/g/cli']);
  });
  it('answers no-node for a missing node, an old node and a missing npm, and installs nothing', async () => {
    for (const f of [fake({ node: undefined }), fake({ version: 'v18.19.0' }), fake({ npm: false })]) {
      expect(await installCli(f.ports, '/g/cli', 'linux')).toEqual({ kind: 'no-node' });
      expect(f.runs.some((r) => r.args.includes('install'))).toBe(false);
      expect(f.moved).toEqual([]);
    }
  });
  it('shows the redacted tail of a failed install and removes the staging folder', async () => {
    const f = fake({ run: (args) => (args.includes('install') ? { code: 1, output: 'npm ERR! sekret network' } : { code: 0, output: '' }) });
    const result = await installCli(f.ports, '/g/cli', 'linux');
    expect(result).toEqual({ kind: 'failed', tail: 'npm ERR! [hidden] network' });
    expect(f.removed).toHaveLength(1);
    expect(f.removed[0]).toMatch(/^\/g\/cli\.new-/);
    expect(f.moved).toEqual([]);
  });
  it('rejects a program that does not know --machine, or has no version', async () => {
    for (const run of [
      (a: string[]) => (a.includes('--help') ? { code: 0, output: 'Usage: studio' } : { code: 0, output: '1.2.3' }),
      (a: string[]) => (a.includes('install') || a.includes('--help') ? { code: 0, output: '--machine' } : { code: 0, output: 'oops' }),
    ]) {
      const f = fake({ run });
      expect(await installCli(f.ports, '/g/cli', 'linux')).toEqual({ kind: 'rejected' });
      expect(f.moved).toEqual([]);
      expect(f.removed[0]).toMatch(/^\/g\/cli\.new-/);
    }
  });
});
