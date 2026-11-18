import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// The panels of the extension are native: Kiro draws them with the user's theme. A fixed colour would
// clash with the light theme and break the high contrast theme, so the UI code names theme colours only.
const UI = path.resolve(__dirname, '../../../kiro-extension/src/ui');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const files = sourceFiles(UI).map((file) => ({
  rel: path.relative(UI, file).replaceAll('\\', '/'),
  // Comments may quote colours: they are not code
  text: fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
}));

describe('extension UI uses theme colours only', () => {
  it('finds the UI sources', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it('contains no hex, rgb, hsl or named-colour literal', () => {
    for (const f of files) {
      expect(f.text, f.rel).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(f.text, f.rel).not.toMatch(/\b(?:rgba?|hsla?)\(/);
    }
  });

  it('names only theme colours in ThemeColor', () => {
    for (const f of files) {
      for (const match of f.text.matchAll(/new vscode\.ThemeColor\(\s*['"]([^'"]+)['"]/g)) {
        expect(match[1], f.rel).toMatch(/^(charts|list|editorWarning|editorError|testing|descriptionForeground)[A-Za-z.]*$/);
      }
    }
  });

  it('never points an icon at a file or an image: icons come from the editor (codicons) or from media/', () => {
    for (const f of files) {
      expect(f.text, f.rel).not.toMatch(/iconPath\s*=\s*(?=\S)(?!new vscode\.ThemeIcon)/);
    }
  });
});
