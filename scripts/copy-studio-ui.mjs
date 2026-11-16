// Copies the Studio single-page UI (plain static files, no build step) next to the compiled server:
// `src/studio/ui` -> `<outDir>/studio/ui`. `tsc` only emits TypeScript, so `npm run build` runs this after it.
// Usage: node scripts/copy-studio-ui.mjs [outDir]   (default: dist)
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'studio', 'ui');
const outDir = resolve(root, process.argv[2] ?? 'dist');
const target = join(outDir, 'studio', 'ui');

if (!existsSync(source)) {
  console.error(`Studio UI not found: ${source}`);
  process.exit(1);
}
// A clean copy: a file removed from the source must not linger in the build
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`Studio UI copied to ${target}`);
