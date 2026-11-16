/**
 * Task 21.5: no password, cookie or secret in any committed file or compiled artifact of the examples
 * (requirements 19.5 and 16.9). Needs neither Docker nor the example applications: the committed workflow files are
 * compiled as they are, with RANDOM secret values in the environment, and every output is searched for those values.
 *
 *   1. The committed files of examples/ and docs/ and the workflow files with their .assets.
 *   2. The compiled output (several flag combinations), the Studio API and the static Studio demo.
 *   3. Every file git would commit, plus the .gitignore that keeps generated and local files out.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 180000, hookTimeout: 300000 });
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { compile, type CompileOptions } from '../../src/cli/commands/compile.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import type { WorkflowSet, WorkflowStep } from '../../src/types.js';
import { deserializeWorkflowSet, findPlainSecrets } from '../../src/workflow/workflow-set.js';
import { ALLOWED_DEMO_VALUES, demoValuesIn, listCommittableFiles, scanFile, scanFiles, scanForSecretShapes } from '../../scripts/lib/secret-scan.mjs';
import { removeDir } from '../helpers/cleanup.js';
import { scanForValues } from '../helpers/scan-artifacts.js';

const root = resolve(import.meta.dirname, '../..');
const examplesDir = join(root, 'examples');
const SKIP_DIRS = new Set(['node_modules', 'out', '.git']);
const posix = (p: string): string => p.split(sep).join('/');
const DEMO_VALUE = Object.keys(ALLOWED_DEMO_VALUES)[0];

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...(await walk(path)));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/** examples/<name>/daemonize.workflows.json, or any other committed *.workflows.json under examples/. */
async function committedWorkflowFiles(): Promise<string[]> {
  return (await walk(examplesDir)).filter((f) => f.endsWith('.workflows.json')).sort();
}

const secretNamesOf = (set: WorkflowSet): string[] => {
  const names = new Set<string>();
  for (const workflow of set.workflows) {
    for (const secret of workflow.secrets ?? []) names.add(typeof secret === 'string' ? secret : secret.name);
    for (const step of workflow.steps) if (step.secretRef !== undefined) names.add(step.secretRef);
  }
  return [...names];
};

const typesPassword = (step: WorkflowStep): boolean =>
  step.actionType === 'type' && [...step.selectors, step.label ?? '', step.anchor?.name ?? ''].some((s) => /pass(word|wd)?|pwd|secret/i.test(s));

const files = await committedWorkflowFiles();
const workflowSets = new Map(files.map((f) => [f, deserializeWorkflowSet(readFileSync(f, 'utf8'))]));

// ---------------------------------------------------------------------------------------------------------------------
describe('the scanner itself', () => {
  it('finds the shapes of credentials', () => {
    const sample = [
      `token: ey${'J'}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop12345`,
      `Authorization: Bearer abc123def456ghi789`,
      `Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==`,
      `aws=AKI${'A'}IOSFODNN7EXAMPLE`,
      `-----BEGIN RSA PRIVATE ${'KEY'}-----`,
      `postgres://u?password=hunter2hunter2`,
      `Cookie: sid=9f8e7d6c5b4a39281706`,
      `DAEMONIZE_SECRET_X=realvalue12345`,
      `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`,
      `xoxb-1234567890-abcdefghij`,
      `sk_live_abcdefghij1234567890`,
      `sk-ant-api03-abcdefghijklmnop`,
      `sk-abcdefghijklmnopqrstuvwxyz123456`,
      `key: ${'0123456789abcdef'.repeat(3)}`,
    ];
    for (const line of sample) expect(scanForSecretShapes(line), line).not.toEqual([]);
  });

  it('accepts placeholders, references and names, and reports a masked excerpt only', () => {
    const clean = [
      'DAEMONIZE_SECRET_PASSWORD=${DAEMONIZE_SECRET_PASSWORD}',
      '"DAEMONIZE_SECRET_PASSWORD": "${DAEMONIZE_SECRET_PASSWORD}"',
      'Authorization: Bearer ${TOKEN}',
      'password=<your password>',
      'const secret = options.secret;',
      'Basic authentication and Basic functionality',
      '"secretRef": "PASSWORD"',
      `POSTGRES_PASSWORD: \${DEMO_DB_PASSWORD:-${DEMO_VALUE}}`,
    ];
    for (const line of clean) expect(scanForSecretShapes(line), line).toEqual([]);
    const [finding] = scanForSecretShapes('password=averylongplainpasswordvalue');
    expect(JSON.stringify({ ...finding, value: undefined })).not.toContain('averylongplainpasswordvalue');
  });

  it('allows exactly one documented demo value, in exactly the documented files', () => {
    expect(Object.keys(ALLOWED_DEMO_VALUES)).toEqual(['demo-password-' + 'change-me']);
    expect([...ALLOWED_DEMO_VALUES[DEMO_VALUE]].sort()).toEqual([
      'examples/adminer/README.md',
      'examples/adminer/docker-compose.yml',
      'examples/adminer/record-workflows.mjs',
      'scripts/lib/secret-scan.mjs',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('committed files of the examples', () => {
  it('has the committed workflow files of both examples', () => {
    expect(files.map((f) => posix(relative(root, f)))).toEqual(['examples/adminer/daemonize.workflows.json', 'examples/cli-sqlite/daemonize.workflows.json']);
  });

  it.each(files.map((f) => [posix(relative(root, f)), f]))('%s is a valid workflow set with no plain secret', (_name, file) => {
    const set = deserializeWorkflowSet(readFileSync(file, 'utf8'));
    expect(findPlainSecrets(set)).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toContain(DEMO_VALUE);
  });

  it('holds no secret shape in any file of examples/ or docs/ (PNG thumbnails are not text and are skipped)', async () => {
    const all = [...(await walk(examplesDir)), ...(await walk(join(root, 'docs')))];
    expect(all.length).toBeGreaterThan(10);
    const relatives = all.map((f) => posix(relative(root, f)));
    expect(scanFiles(root, relatives)).toEqual([]);
    expect(relatives.some((f) => f.endsWith('.png'))).toBe(true); // they exist and are skipped by the text scanner
    expect(relatives.filter((f) => f.endsWith('.png')).flatMap((f) => scanFile(root, f))).toEqual([]);
  });

  it('writes the documented demo value only in the documented files, never in a workflow file', async () => {
    const holders: string[] = [];
    for (const dir of ['examples', 'docs', 'scripts', 'src', 'tests', 'README.md']) {
      const path = join(root, dir);
      if (!existsSync(path)) continue;
      const candidates = dir === 'README.md' ? [path] : await walk(path);
      for (const file of candidates) {
        if (/\.(png|ico|woff2?)$/i.test(file)) continue;
        if (demoValuesIn(readFileSync(file, 'utf8')).length > 0) holders.push(posix(relative(root, file)));
      }
    }
    expect(holders.sort()).toEqual([...ALLOWED_DEMO_VALUES[DEMO_VALUE]].filter((f) => holders.includes(f)).sort());
    expect(holders.length).toBeGreaterThan(0);
    expect(holders.some((f) => f.endsWith('.workflows.json'))).toBe(false);
  });

  it.each(files.map((f) => [posix(relative(root, f)), f]))('%s: a secret step and a password field have no thumbnail', async (_name, file) => {
    const set = workflowSets.get(file)!;
    const assets = `${file}.assets`;
    const onDisk = existsSync(assets) ? (await readdir(assets)).filter((n) => n.endsWith('.png')) : [];
    const referenced: string[] = [];
    for (const workflow of set.workflows) {
      for (const step of workflow.steps) {
        const thumbnail = step.visual?.thumbnailPath;
        if (step.secretRef !== undefined || typesPassword(step) || step.totp === true) {
          expect(thumbnail, `${workflow.label}: ${step.label}`).toBeUndefined();
        }
        if (thumbnail !== undefined) {
          referenced.push(basename(thumbnail));
          expect(existsSync(resolve(dirname(file), thumbnail)), thumbnail).toBe(true);
        }
      }
    }
    // Every picture on disk belongs to a step that is not secret
    expect(onDisk.filter((n) => !referenced.includes(n))).toEqual([]);
  });

  it('uses secret references for the password of the web example', () => {
    const adminer = workflowSets.get(files.find((f) => f.includes('adminer'))!)!;
    expect(secretNamesOf(adminer)).toEqual(['PASSWORD']);
    const typed = adminer.workflows.flatMap((w) => w.steps).filter(typesPassword);
    expect(typed.length).toBeGreaterThan(0);
    for (const step of typed) {
      expect(step.secretRef).toBe('PASSWORD');
      expect(step.value).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('compiled output of the committed workflow files', () => {
  const dirs: string[] = [];
  const saved = new Map<string, string | undefined>();
  const values: string[] = [];
  const outputs: Array<{ name: string; example: string; outDir: string; workflowFile: string }> = [];
  const FIXED_ENV = ['DAEMONIZE_COOKIE_HEADER', 'DAEMONIZE_MODEL_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

  const variants: Array<{ name: string; options: CompileOptions }> = [
    { name: 'default', options: {} },
    { name: 'http-auto', options: { http: 'auto' } },
    { name: 'heal-support', options: { healSupport: true } },
    { name: 'suggest-deterministic', options: { suggest: { mode: 'deterministic' } } },
    { name: 'sandbox-package', options: { sandbox: { packages: ['sqlite3'] } } },
    { name: 'all-flags', options: { http: 'auto', healSupport: true, suggest: { mode: 'deterministic' }, sandbox: { packages: ['sqlite3'] } } },
  ];

  const randomSecret = (): string => {
    const value = `Zq${randomBytes(18).toString('hex')}!${randomBytes(6).toString('base64url')}`;
    values.push(value);
    return value;
  };

  beforeAll(async () => {
    const names = new Set<string>(FIXED_ENV);
    for (const set of workflowSets.values()) for (const name of secretNamesOf(set)) names.add(`DAEMONIZE_SECRET_${name}`);
    for (const name of names) {
      saved.set(name, process.env[name]);
      process.env[name] = randomSecret();
    }
    const log = console.log;
    const warn = console.warn;
    console.log = () => { };
    console.warn = () => { };
    try {
      for (const file of files) {
        const example = basename(dirname(file));
        for (const variant of variants) {
          // A copy outside the workspace: --sandbox-package and --suggest rewrite or add files next to the workflow file
          const base = await mkdtemp(join(tmpdir(), `daemonize-leak-${example}-${variant.name}-`));
          dirs.push(base);
          const copy = join(base, 'daemonize.workflows.json');
          await cp(file, copy);
          if (existsSync(`${file}.assets`)) await cp(`${file}.assets`, `${copy}.assets`, { recursive: true });
          const outDir = join(base, 'out');
          await compile(copy, outDir, variant.options);
          outputs.push({ name: `${example}/${variant.name}`, example, outDir, workflowFile: copy });
        }
      }
    } finally {
      console.log = log;
      console.warn = warn;
    }
  });

  afterAll(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of dirs) await removeDir(dir);
  });

  it('compiled every variant of both examples', () => {
    expect(outputs).toHaveLength(files.length * variants.length);
    expect(values.length).toBeGreaterThanOrEqual(FIXED_ENV.length + 1);
  });

  it('contains none of the secret values in any file of the output (raw, base64, hex, URL- and JSON-escaped)', async () => {
    for (const out of outputs) {
      const hits = await scanForValues(out.outDir, [...values, DEMO_VALUE]);
      expect(hits.map((h) => `${h.file} (${h.form})`), out.name).toEqual([]);
    }
  });

  it('contains none of the values in the workflow file next to it, or in the suggestions file', async () => {
    for (const out of outputs) {
      expect((await scanForValues(dirname(out.workflowFile), [...values, DEMO_VALUE], { skipDirs: ['out', 'node_modules'] })).map((h) => h.file), out.name).toEqual([]);
      expect(scanFiles(dirname(out.workflowFile), (await walk(dirname(out.workflowFile))).map((f) => posix(relative(dirname(out.workflowFile), f)))), out.name).toEqual([]);
    }
  });

  it('holds no secret shape in the compiled files that are text (mcp.json, plugin.json, SKILL.md, POWER.md, OpenAPI, tests)', async () => {
    for (const out of outputs) {
      const rels = (await walk(out.outDir)).map((f) => posix(relative(out.outDir, f)));
      expect(rels.some((r) => r.endsWith('mcp.json')), out.name).toBe(true);
      expect(rels.some((r) => r.startsWith('tests/')), out.name).toBe(true);
      expect(scanFiles(out.outDir, rels), out.name).toEqual([]);
    }
  });

  it('writes only ${NAME} placeholders in the env of every mcp.json, and no value in the manifests', async () => {
    let seenEnv = 0;
    for (const out of outputs) {
      for (const file of await walk(out.outDir)) {
        if (basename(file) !== 'mcp.json') continue;
        const config = JSON.parse(await readFile(file, 'utf8')) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
        for (const server of Object.values(config.mcpServers ?? {})) {
          for (const [name, value] of Object.entries(server.env ?? {})) {
            seenEnv++;
            // Every variable that can carry a credential is a reference; settings such as DAEMONIZE_MODE=strict are plain
            if (/SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|COOKIE|CREDENTIAL/i.test(name)) {
              expect(value, `${out.name}: ${name}`).toMatch(/^\$\{[A-Z][A-Z0-9_]*\}$/);
            } else {
              expect(value, `${out.name}: ${name}`).not.toMatch(/^Zq[0-9a-f]{20}/);
            }
          }
        }
      }
    }
    const adminerSecrets = outputs.filter((o) => o.example === 'adminer').length;
    expect(seenEnv).toBeGreaterThanOrEqual(adminerSecrets); // the web example declares DAEMONIZE_SECRET_PASSWORD in every output
  });

  describe('Studio API pointed at the output', () => {
    let handle: StudioHandle | undefined;
    afterAll(async () => {
      await handle?.close();
    });

    it('serves no secret value in any answer, with the secrets in the environment of the process', async () => {
      for (const out of outputs.filter((o) => ['default', 'all-flags'].includes(o.name.split('/')[1]))) {
        handle = await startStudio({ workflowFile: out.workflowFile, outDir: out.outDir, port: 0, token: randomBytes(24).toString('base64url'), env: process.env });
        const answers: string[] = [];
        try {
          for (const path of ['/api/health', '/api/overview', '/api/workflows', '/api/graph', '/api/schemas', '/api/pbt', '/api/playground', '/api/playground/history']) {
            const response = await fetch(`${handle.origin}${path}`, { headers: { 'x-studio-token': handle.token } });
            answers.push(await response.text());
            expect([200, 404], `${out.name} ${path}`).toContain(response.status);
          }
          const overview = JSON.parse(answers[1]) as { targets?: unknown[] };
          expect(overview.targets, out.name).toBeDefined();
          const page = await fetch(`${handle.origin}/?token=${handle.token}`);
          answers.push(await page.text());
        } finally {
          await handle.close();
          handle = undefined;
        }
        const body = answers.join('\n');
        for (const value of values) {
          for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex')]) {
            expect(body.includes(form), `${out.name}: a secret value reached the Studio API`).toBe(false);
          }
        }
        expect(body).not.toContain(DEMO_VALUE);
      }
    });
  });

  describe('static Studio demo', () => {
    const builtOnce = existsSync(join(root, 'dist', 'studio', 'model.js'));
    it.skipIf(!builtOnce)('is built with the secrets in the environment and contains none of them', async () => {
      const demoDir = await mkdtemp(join(tmpdir(), 'daemonize-leak-demo-'));
      dirs.push(demoDir);
      const target = join(demoDir, 'site');
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'build-studio-demo.mjs'), '--out', target], {
        cwd: root,
        encoding: 'utf8',
        env: process.env,
        timeout: 120000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(await scanForValues(target, [...values, DEMO_VALUE])).toEqual([]);
      const rels = (await walk(target)).map((f) => posix(relative(target, f)));
      expect(rels.length).toBeGreaterThan(3);
      expect(scanFiles(target, rels)).toEqual([]);
    });
    if (!builtOnce) it.skip('static Studio demo: skipped, run "npm run build" first (dist/studio/model.js not found)', () => { });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('repository guard', () => {
  const committable = listCommittableFiles(root);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

  if (committable === undefined) {
    it.skip('repository guard: skipped, this folder is not inside a git work tree', () => { });
    return;
  }

  it('finds no secret shape in any file git tracks or would commit (binary files skipped)', () => {
    expect(committable.length).toBeGreaterThan(100);
    expect(scanFiles(root, committable)).toEqual([]);
  });

  it('keeps the demo value out of every tracked file but the documented ones', () => {
    const holders = committable.filter((f) => !/\.(png|ico|woff2?)$/i.test(f) && existsSync(join(root, f)) && demoValuesIn(readFileSync(join(root, f), 'utf8')).length > 0);
    for (const holder of holders) expect(ALLOWED_DEMO_VALUES[DEMO_VALUE], holder).toContain(holder);
  });

  it('ignores the generated and local files, and tracks none of them', () => {
    const mustIgnore = [
      'examples/adminer/out/mcp-server.js',
      'examples/cli-sqlite/out/mcp.json',
      'examples/another/out/x',
      '.daemonize/anchors/a.png',
      'sub/.daemonize/cache.json',
      'session.storage-state.json',
      'examples/adminer/session.storage-state.json',
      '.env',
      '.env.local',
      '.env.production',
      'dist-demo/index.html',
    ];
    for (const path of mustIgnore) {
      const result = git('check-ignore', '-q', '--no-index', '--', path);
      expect(result.status, `${path} must be ignored by .gitignore`).toBe(0);
    }
    const ignoreFile = readFileSync(join(root, '.gitignore'), 'utf8');
    for (const entry of ['examples/*/out/', '.daemonize/', '*.storage-state.json', '.env', 'dist-demo/']) {
      expect(ignoreFile.split(/\r?\n/), entry).toContain(entry);
    }
    const tracked = git('ls-files').stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const forbidden = tracked.filter((f) => /^examples\/[^/]+\/out\//.test(f) || /(^|\/)\.daemonize\//.test(f) || /\.storage-state\.json$/.test(f) || /(^|\/)\.env(\.(?!example$)[^/]*)?$/.test(f) || /^dist-demo\//.test(f));
    expect(forbidden).toEqual([]);
  });
});
