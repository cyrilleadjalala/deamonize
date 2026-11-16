// Usage: node scripts/check-secrets.mjs [--changed]      (npm run check:secrets)
// Scans the files git would commit (tracked + untracked and not ignored) for things that look like credentials.
// --changed: only the files modified since HEAD and the new ones (fast; used by the save hook).
// Exit code 1 when something is found. The report names the file, the line and the rule, never the value.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCommittableFiles, scanFiles } from './lib/secret-scan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const changedOnly = process.argv.includes('--changed');
const files = listCommittableFiles(root, { changedOnly });
if (files === undefined) {
  console.log('check:secrets skipped: not inside a git work tree.');
  process.exit(0);
}
const findings = scanFiles(root, files);
if (findings.length === 0) {
  console.log(`check:secrets: no secret found in ${files.length} file(s).`);
  process.exit(0);
}
for (const f of findings) console.error(`${f.file}:${f.line}  ${f.rule}  ${f.excerpt}`);
console.error(`check:secrets: ${findings.length} possible secret(s) in ${new Set(findings.map((f) => f.file)).size} file(s). Remove them, or use a ${'${NAME}'} reference.`);
process.exit(1);
