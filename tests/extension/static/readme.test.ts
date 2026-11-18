import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(resolve(process.cwd(), 'kiro-extension', 'README.md'), 'utf8');
const rootReadme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');

describe('kiro-extension README', () => {
  it('explains build, install, both settings, Node and the browser', () => {
    expect(readme).toMatch(/npm run build/);
    expect(readme).toMatch(/npm run package/);
    expect(readme).toMatch(/Install from VSIX/);
    expect(readme).toContain('daemonize.cliPath');
    expect(readme).toContain('daemonize.nodePath');
    expect(readme).toMatch(/Node\.js 20/);
    expect(readme).toContain('ELECTRON_RUN_AS_NODE');
    expect(readme).toMatch(/default browser/i);
    expect(readme).toMatch(/orphan/i);
    expect(readme).toMatch(/OWNER/);
  });

  it('is pointed to by the root README', () => {
    expect(rootReadme).toContain('kiro-extension/README.md');
  });
});
