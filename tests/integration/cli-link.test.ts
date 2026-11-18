import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
// Spawns the CLI: realistic limits for a loaded full-suite run
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeDir } from '../helpers/cleanup.js';

// The built CLI started through a directory link, the way `npm link` installs it
// (a junction on Windows, a symlink elsewhere). Before the fix main() never ran and the process exited 0 silently.
const repo = resolve(__dirname, '../..');
const dist = join(repo, 'dist');
const built = existsSync(join(dist, 'cli', 'entry.js'));

function run(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      done({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) ?? 1 : 0, stdout, stderr });
    });
  });
}

describe.skipIf(!built)('CLI started through an npm link style directory link', () => {
  let dir: string;
  let linked: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-link-'));
    await symlink(dist, join(dir, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    linked = join(dir, 'dist', 'cli', 'index.js');
  });
  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it('prints the help through the link', async () => {
    const { code, stdout } = await run(linked, ['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage: daemonize/);
  });

  it('prints the same help through the link as through the direct path', async () => {
    const direct = await run(join(dist, 'cli', 'index.js'), ['--help']);
    const viaLink = await run(linked, ['--help']);
    expect(viaLink.stdout).toBe(direct.stdout);
  });

  it('reports an unknown argument through the link instead of exiting silently', async () => {
    const { code, stderr } = await run(linked, ['no-such-command']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/no-such-command/);
  });
});