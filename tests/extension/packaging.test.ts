// checkpoint-only: needs G-F1
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const EXT = path.resolve(__dirname, '../../kiro-extension');
const REQUIRED = process.env.DAEMONIZE_REQUIRE_EXTENSION_BUILD === '1';
const HAS_MODULES = fs.existsSync(path.join(EXT, 'node_modules'));
const LIMIT = 500 * 1024;

function npx(args: string[]): { status: number | null; out: string } {
  // npx.cmd needs a shell on Windows (Node refuses to spawn .cmd files without one); the arguments are fixed strings.
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
    cwd: EXT, encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000,
  });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('extension packaging', () => {
  if (!HAS_MODULES && !REQUIRED) {
    it.skip('skipped: kiro-extension/node_modules is absent (run npm ci in kiro-extension, or set DAEMONIZE_REQUIRE_EXTENSION_BUILD=1)', () => undefined);
    return;
  }

  it('has node_modules when the build is required', () => {
    expect(HAS_MODULES, 'run npm ci in kiro-extension first').toBe(true);
  });

  it('bundles one file and lists only the allowed package files under the size limit', () => {
    const bundle = spawnSync(process.execPath, ['scripts/bundle.mjs', '--production'], { cwd: EXT, encoding: 'utf8' });
    expect(bundle.status, `${bundle.stdout}${bundle.stderr}`).toBe(0);

    const listed = npx(['--no-install', 'vsce', 'ls', '--no-dependencies']);
    expect(listed.status, listed.out).toBe(0);
    const files = listed.out.split(/\r?\n/).map((l) => l.trim().replace(/\\/g, '/')).filter((l) => /^[\w.@/-]+\.[A-Za-z]+$|^LICENSE$/.test(l));
    expect(files).toContain('dist/extension.js');
    expect(files).toContain('package.json');
    // The agent and the skill travel in the package as the same bytes as the Power's files (Requirement 9.8).
    for (const [template, source] of [
      ['templates/agents/daemonize.md', 'power/agents/daemonize.md'],
      ['templates/skills/daemonize-builder/SKILL.md', 'power/skills/daemonize-builder/SKILL.md'],
    ]) {
      expect(files, template).toContain(template);
      expect(fs.readFileSync(path.join(EXT, template)).equals(fs.readFileSync(path.resolve(EXT, '..', source))), template).toBe(true);
    }
    expect(files).toContain('package.json');
    for (const file of files) {
      expect(file, file).not.toMatch(/(^|\/)(src|tests|node_modules|scripts)\//);
      expect(file, file).not.toMatch(/playwright|node-pty|\.map$|\.ts$/);
    }

    const bundleText = fs.readFileSync(path.join(EXT, 'dist/extension.js'), 'utf8');
    expect(bundleText).not.toMatch(/require\(["'](playwright|node-pty)/);
    expect(fs.statSync(path.join(EXT, 'dist/extension.js')).size).toBeLessThan(LIMIT);
  });

  it('packs a .vsix under the size limit', () => {
    const out = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kext-')), 'daemonize-test.vsix');
    const packed = npx(['--no-install', 'vsce', 'package', '--no-dependencies', '--out', out]);
    expect(packed.status, packed.out).toBe(0);
    expect(fs.statSync(out).size).toBeLessThan(LIMIT);
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  });
});
