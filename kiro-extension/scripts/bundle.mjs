// Bundles src/extension.ts into one CommonJS file. `vscode` stays external. Fails on anything that would
// pull native or runtime packages into the extension.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: false,
  minify: production,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

const srcDir = path.join(root, 'src') + path.sep;
const bad = Object.keys(result.metafile.inputs).filter((input) => {
  const normalized = input.replace(/\\/g, '/');
  if (/playwright|node-pty|node_modules/.test(normalized)) return true;
  return !(path.resolve(root, input) + '').startsWith(srcDir);
});
if (bad.length > 0) {
  console.error(`Bundle refused. Inputs outside kiro-extension/src or forbidden packages:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`Bundled ${Object.keys(result.metafile.inputs).length} files into dist/extension.js${production ? ' (minified)' : ''}`);
