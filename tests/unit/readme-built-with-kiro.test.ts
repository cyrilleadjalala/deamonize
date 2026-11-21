import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanForSecretShapes } from '../../scripts/lib/secret-scan.mjs';

// Feature: kiro-native-agent-and-firewall, README "Built with Kiro" table
// **Validates: Requirements 29.8**

const root = resolve(__dirname, '..', '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

/** Local, git-ignored files: only their `.example` is committed, so they may be named without existing. */
const GIT_IGNORED_LOCAL_PATHS = new Set(['.kiro/settings/mcp.json']);

const section = readme.split(/^## Built with Kiro\s*$/m)[1]?.split(/^## /m)[0] ?? '';
const rows = section.split(/\r?\n/).filter((l) => l.startsWith('|')).slice(2); // drop header and separator
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
const dirNames = (rel: string, dirs: boolean): string[] =>
  readdirSync(resolve(root, rel), { withFileTypes: true }).filter((e) => e.isDirectory() === dirs).map((e) => e.name);

describe('README "Built with Kiro" table', () => {
  it('has a table with rows', () => {
    expect(rows.length).toBeGreaterThan(5);
  });

  it('names every spec folder of .kiro/specs', () => {
    const named = new Set(rows.flatMap((r) => ticks(r.split('|')[1] ?? '')));
    const missing = dirNames('.kiro/specs', true).filter((d) => !named.has(d));
    expect(missing).toEqual([]);
  });

  it('names no spec that has no folder', () => {
    const folders = new Set(dirNames('.kiro/specs', true));
    const named = rows
      .filter((r) => (r.split('|')[1] ?? '').trim().startsWith('Spec:'))
      .map((r) => ticks(r.split('|')[1] ?? '')[0]!);
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(folders.has(n), n).toBe(true);
  });

  it('only names file paths that exist (the git-ignored local settings file excepted)', () => {
    const paths = [...new Set(rows.flatMap(ticks).filter((t) => /^[\w.-]+(\/[\w.-]+)*\/$|^[\w.-]+(\/[\w.-]+)+$/.test(t)))];
    expect(paths.length).toBeGreaterThan(5);
    const missing = paths.filter((p) => !GIT_IGNORED_LOCAL_PATHS.has(p) && !existsSync(resolve(root, p)));
    expect(missing).toEqual([]);
  });

  it('names exactly the hooks that are files of .kiro/hooks', () => {
    const row = rows.find((r) => (r.split('|')[1] ?? '').includes('`.kiro/hooks/`'));
    expect(row).toBeDefined();
    const named = ticks(row!.split('|')[2] ?? '').sort();
    const files = dirNames('.kiro/hooks', false).map((f) => f.replace(/\.json$/, '')).sort();
    expect(named).toEqual(files);
  });

  it('holds no secret and no absolute user path', () => {
    expect(scanForSecretShapes(section)).toEqual([]);
    expect(section).not.toMatch(/[A-Za-z]:\\Users\\|\/home\/[a-z]|\/Users\/[A-Za-z]/);
  });
});
