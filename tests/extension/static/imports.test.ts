import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const EXT_SRC = path.resolve(__dirname, '../../../kiro-extension/src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

function specifiers(text: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(pattern)) found.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  return found;
}

const files = sourceFiles(EXT_SRC).map((file) => ({ file, rel: path.relative(EXT_SRC, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') }));

describe('extension source imports', () => {
  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('core/ imports no vscode', () => {
    for (const f of files.filter((x) => x.rel.startsWith('core/'))) {
      expect(specifiers(f.text), f.rel).not.toContain('vscode');
    }
  });

  it('imports nothing from the root src/ or outside kiro-extension/src', () => {
    for (const f of files) {
      for (const spec of specifiers(f.text)) {
        if (!spec.startsWith('.')) continue;
        const target = path.resolve(path.dirname(f.file), spec);
        expect(path.relative(EXT_SRC, target).startsWith('..'), `${f.rel} imports ${spec}`).toBe(false);
      }
    }
  });

  it('uses only vscode and node: built-ins as bare imports (no runtime dependency)', () => {
    for (const f of files) {
      for (const spec of specifiers(f.text)) {
        if (spec.startsWith('.')) continue;
        expect(spec === 'vscode' || spec.startsWith('node:'), `${f.rel} imports ${spec}`).toBe(true);
      }
    }
  });

  it('has no webview and no iframe', () => {
    for (const f of files) {
      expect(f.text, f.rel).not.toMatch(/createWebviewPanel|registerWebview|WebviewView|<iframe/i);
    }
  });

  it('writes no file', () => {
    for (const f of files) {
      expect(f.text, f.rel).not.toMatch(/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rmSync|unlinkSync|rename|renameSync|copyFile)\b/);
    }
  });

  it('does not use a shell to start the process', () => {
    for (const f of files) {
      expect(f.text, f.rel).not.toMatch(/shell:\s*true|(?<![.\w])exec(Sync)?\(/);
    }
  });
});
