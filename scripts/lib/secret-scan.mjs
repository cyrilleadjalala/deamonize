// Secret-shape scanner shared by `scripts/check-secrets.mjs` (npm run check:secrets) and tests/integration/examples-no-leak.test.ts.
// It looks for things that LOOK like credentials (it does not know any value). A finding never carries the value itself:
// only the rule, the line and a masked excerpt, so a report cannot become a second leak.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The only values that look like secrets and are documented as public demo values. Each one may appear only in the
 * listed files (paths relative to the repository root, with forward slashes).
 */
export const ALLOWED_DEMO_VALUES = Object.freeze({
  // Default password of the throwaway, in-memory PostgreSQL of examples/adminer (compose default, README, recording script)
  'demo-password-change-me': Object.freeze([
    'examples/adminer/docker-compose.yml',
    'examples/adminer/README.md',
    'examples/adminer/record-workflows.mjs',
    // The scanner itself names the value, to allow it
    'scripts/lib/secret-scan.mjs',
  ]),
});

/**
 * Test files that plant FAKE credentials on purpose (decoys such as "sk-planted-...", RFC test vectors, "hunter2") to prove
 * the product redacts, rejects or never writes them. Reviewed one by one: none is a real credential. A new file that plants
 * a fake secret must be added here deliberately; a real one must never be committed.
 */
export const SYNTHETIC_FIXTURE_FILES = Object.freeze([
  'tests/integration/adminer-e2e.test.ts',
  'tests/integration/examples-no-leak.test.ts',
  'tests/integration/no-model-without-heal.test.ts',
  'tests/integration/secrets-e2e.test.ts',
  'tests/integration/studio-server.test.ts',
  'tests/integration/suggest.test.ts',
  'tests/property/vault-reader-failures.property.test.ts',
  'tests/unit/credentials-view.test.ts',
  'tests/unit/vault-reader.test.ts',
  'tests/extension/glue/secrets-never-leak.test.ts',
  'tests/extension/pure/redactor.property.test.ts',
  'tests/extension/real/studio-handshake.test.ts',
  'tests/unit/studio-machine.test.ts',
  'tests/property/studio-machine-handshake.property.test.ts',
  'tests/property/redaction.property.test.ts',
  'tests/unit/heal.test.ts',
  'tests/unit/heal-cache.test.ts',
  'tests/unit/heal-providers.test.ts',
  'tests/unit/http-correlate.test.ts',
  'tests/unit/http-replay.test.ts',
  'tests/unit/playground.test.ts',
  'tests/unit/redactor.test.ts',
  'tests/unit/step-plan.test.ts',
  'tests/unit/studio-redact.test.ts',
  'tests/unit/suggest.test.ts',
  'tests/unit/totp.test.ts',
  // studio-first-flow: tests that plant fake credentials on purpose
  'tests/unit/totp-secret.test.ts',
  'tests/unit/secret-vault.test.ts',
  'tests/unit/key-providers.test.ts',
  'tests/unit/playground-vault-env.test.ts',
  'tests/unit/secrets-routes.test.ts',
  'tests/unit/session-store.test.ts',
  'tests/unit/power-installer.test.ts',
  'tests/unit/mcp-snippet.test.ts',
  'tests/property/studio-secrets.property.test.ts',
  'tests/property/studio-recording.property.test.ts',
  'tests/property/studio-compile-power.property.test.ts',
  'tests/integration/studio-secrets.test.ts',
  'tests/integration/studio-record.test.ts',
  'tests/integration/studio-power.test.ts',
  'tests/integration/studio-ui-features.test.ts',
  'tests/integration/studio-ui-first-flow.test.ts',
  'tests/integration/vault-bridge.test.ts',
]);

/** Words that make a value a placeholder, not a credential. */
const PLACEHOLDER_WORD = /^(x{3,}|\*+|\.{3,}|redacted|placeholder|changeme|change-me|your[-_a-z]*|example[-_a-z]*|dummy|sample|none|null|undefined|true|false|string|value|name|token|secret|password|passwd|pwd|env|process|options?|args?|config|input|data|req|res|this|self|opts?|key|text|literal|param\w*)$/i;

/** @param {string} value */
function isPlaceholder(value) {
  const v = value.trim().replace(/^["'`]|["'`,;]+$/g, '');
  if (v.length < 4) return true;
  if (/^\$|\$\{|\{\{|^<|>$|^%|^\[|^\(|\)$|\.\.\.|\\\$/.test(v)) return true; // ${NAME}, $NAME, <name>, {{x}}, %VAR%, templates
  if (/^(process\.env|import\.meta|os\.environ|ENV\[)/.test(v)) return true;
  if (PLACEHOLDER_WORD.test(v)) return true;
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(v)) return true; // an environment variable NAME (DAEMONIZE_SECRET_X), not a value
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\(\))+;?$/.test(v)) return true; // code: options.password, getPassword()
  return false;
}

function mask(text) {
  const t = text.trim();
  return t.length <= 12 ? `${t.slice(0, 2)}***` : `${t.slice(0, 4)}***(${t.length} chars)`;
}

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

const SENSITIVE_NAME = '[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|CREDENTIAL|COOKIE|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*';

/** Rules that need no context. `re` is global; group 1 (when present) is the sensitive part. */
const SHAPE_RULES = [
  { rule: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { rule: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { rule: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { rule: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { rule: 'stripe-key', re: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { rule: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { rule: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { rule: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
];

/**
 * Scan a text. Returns `{ rule, line, excerpt, value }` per finding (`value` is for the allow-list check only; reports print `excerpt`).
 * Values of ALLOWED_DEMO_VALUES are dropped here: the caller decides, per file, whether that is a documented place.
 * @param {string} text
 * @returns {Array<{ rule: string, line: number, excerpt: string, value: string }>}
 */
export function scanForSecretShapes(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const add = (rule, line, value) => findings.push({ rule, line, excerpt: mask(value), value });

  lines.forEach((line, index) => {
    const n = index + 1;
    if (line.length > 20000) return; // minified or data lines: not hand-written configuration
    for (const { rule, re } of SHAPE_RULES) {
      for (const m of line.matchAll(re)) add(rule, n, m[0]);
    }
    // Authorization schemes
    for (const m of line.matchAll(/\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/g)) {
      if (!isPlaceholder(m[1]) && /[0-9]/.test(m[1])) add('bearer-token', n, m[1]);
    }
    for (const m of line.matchAll(/\bBasic\s+([A-Za-z0-9+/]{12,}={0,2})(?![A-Za-z0-9+/=])/g)) {
      if (!isPlaceholder(m[1]) && (/[0-9+/=]/.test(m[1]) || (/[a-z]/.test(m[1]) && /[A-Z]/.test(m[1])))) add('basic-auth', n, m[1]);
    }
    // password=… / pwd=… / secret=… (query strings, connection strings, shell, .ini)
    for (const m of line.matchAll(/(?<![A-Za-z0-9_])(?:password|passwd|pwd|secret)=["']?([^\s"'`&;,)}\]]+)/gi)) {
      if (!isPlaceholder(m[1])) add('credential-assignment', n, m[1]);
    }
    // "password": "literal" (JSON, YAML, object literals with a quoted literal)
    for (const m of line.matchAll(/["']?(?:password|passwd|pwd|secret|client_secret|api_?key|access_?token)["']?\s*[:=]\s*["']([^"'\s$<{][^"']{3,})["']/gi)) {
      if (!isPlaceholder(m[1])) add('credential-literal', n, m[1]);
    }
    // Cookie header lines with an actual name=value
    for (const m of line.matchAll(/(?:^|["'`\s])(?:Set-)?Cookie:\s*([A-Za-z0-9_.-]+=[^\s;"'`]{4,})/gi)) {
      if (!isPlaceholder(m[1].split('=').slice(1).join('='))) add('cookie-header', n, m[1]);
    }
    // KEY=value with a sensitive name (.env, shell, README commands)
    for (const m of line.matchAll(new RegExp(`(?:^|[\\s"'\`;])(?:export\\s+|set\\s+|\\$env:)?(${SENSITIVE_NAME})=["']?([^\\s"'\`;|&]+)`, 'g'))) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(m[1])) continue; // an UPPER_CASE variable, not code like `cookieHeader=`
      if (!isPlaceholder(m[2]) && !/^[A-Z][A-Z0-9_]*$/.test(m[2])) add('env-assignment', n, m[2]);
    }
    // Long random-looking tokens: hex of 40+ or base64-like of 40+ with high entropy.
    // Hashes and lockfile integrity strings are not credentials: skip lines that name them.
    if (/integrity|sha(?:1|256|512)-|hash|checksum|digest|"resolved"|sourceMappingURL|data:image|etag|screenId|"id"\s*:|uuid|nonce/i.test(line)) return;
    for (const m of line.matchAll(/(?<![A-Za-z0-9+/_=-])([A-Za-z0-9+/_-]{40,}={0,2})(?![A-Za-z0-9+/_=-])/g)) {
      const token = m[1];
      if (token.startsWith('iVBORw0KGgo')) continue; // a PNG in base64
      if (/^[A-Fa-f0-9]+$/.test(token) || (entropy(token) >= 4.2 && /[0-9]/.test(token) && /[A-Za-z]/.test(token) && !/\/.*\//.test(token) && !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/i.test(token))) {
        add(/^[A-Fa-f0-9]+$/.test(token) ? 'long-hex-token' : 'long-base64-token', n, token);
      }
    }
  });
  return findings.filter((f) => !Object.keys(ALLOWED_DEMO_VALUES).some((demo) => f.value === demo || f.value.includes(demo)));
}

/** Which allowed demo values does this text contain? */
export function demoValuesIn(text) {
  return Object.keys(ALLOWED_DEMO_VALUES).filter((value) => text.includes(value));
}

/** True when the buffer looks binary (a NUL byte in the first 8 KB, or a PNG/zip/ico/font signature). */
export function isBinary(buffer) {
  const head = buffer.subarray(0, 8192);
  return head.includes(0) || (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47);
}

/** Files that are scanned by name only because their content is machine-written noise. */
const SKIP_FILES = new Set(['package-lock.json']);

/**
 * Scan one file on disk. Binary files, the lockfile and files over 5 MB are skipped.
 * @returns {Array<{ file: string, rule: string, line: number, excerpt: string }>}
 */
export function scanFile(root, relativePath) {
  const full = join(root, relativePath);
  const name = relativePath.split('/').pop();
  if (SKIP_FILES.has(name)) return [];
  let info;
  try {
    info = statSync(full);
  } catch {
    return [];
  }
  if (!info.isFile() || info.size > 5 * 1024 * 1024) return [];
  const buffer = readFileSync(full);
  if (isBinary(buffer)) return [];
  const text = buffer.toString('utf8');
  const synthetic = SYNTHETIC_FIXTURE_FILES.includes(relativePath);
  const out = (synthetic ? [] : scanForSecretShapes(text)).map(({ rule, line, excerpt }) => ({ file: relativePath, rule, line, excerpt }));
  // A demo value outside its documented files is a finding too
  for (const demo of demoValuesIn(text)) {
    if (!ALLOWED_DEMO_VALUES[demo].includes(relativePath)) {
      out.push({ file: relativePath, rule: 'demo-value-outside-documented-files', line: 1, excerpt: mask(demo) });
    }
  }
  return out;
}

/**
 * Files git knows: tracked, plus untracked ones that are not ignored (what the next commit could contain).
 * Returns undefined when `root` is not inside a git work tree.
 * @param {string} root
 * @param {{ changedOnly?: boolean }} [options]
 * @returns {string[] | undefined}
 */
export function listCommittableFiles(root, options = {}) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return undefined;
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '') : [];
  };
  const files = options.changedOnly
    ? [...run(['diff', '--name-only', 'HEAD']), ...run(['ls-files', '--others', '--exclude-standard'])]
    : run(['ls-files', '--cached', '--others', '--exclude-standard']);
  return [...new Set(files.map((f) => f.replace(/\\/g, '/').replace(/^"|"$/g, '')))];
}

/** Scan a list of files. */
export function scanFiles(root, files) {
  return files.flatMap((file) => scanFile(root, file));
}
