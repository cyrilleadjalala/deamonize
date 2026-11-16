// Feature: daemonize, Property 15: heal never mutates the workflow file
// **Validates: Requirements 12.9, 12.12**
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 240000, hookTimeout: 120000 });
import fc from 'fast-check';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { HealCache, healCacheKey, MAX_CACHE_ENTRIES } from '../../src/heal/cache.js';
import { createHealSession, type HealPage, type HealStepData } from '../../src/heal/heal-step.js';
import type { HealResult } from '../../src/heal/healer.js';
import type { Workflow, WorkflowSet, WorkflowStep } from '../../src/types.js';
import { FakeHealer } from '../helpers/fake-healer.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const fakeHealerModule = resolve(import.meta.dirname, '../fixtures/heal/fake-healer-module.mjs');
const chromiumEnv: Record<string, string> = process.env.DAEMONIZE_CHROMIUM_PATH
  ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH }
  : {};
const FS_RUNS = 100;
const BROWSER_RUNS = 8;
const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// ---------------------------------------------------------------------------
// A snapshot of a directory tree: what each file holds and when it was last written
// ---------------------------------------------------------------------------

async function snapshot(root: string, dir = root, out = new Map<string, string>()): Promise<Map<string, string>> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    const info = await lstat(full);
    if (info.isSymbolicLink()) out.set(rel, `link:${await readlink(full)}`);
    else if (info.isDirectory()) await snapshot(root, full, out);
    else out.set(rel, `${sha(await readFile(full))}@${info.mtimeMs}`);
  }
  return out;
}

/** Paths that appeared, vanished or changed between two snapshots. */
function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const all = new Set([...before.keys(), ...after.keys()]);
  return [...all].filter((p) => before.get(p) !== after.get(p)).sort();
}

// ---------------------------------------------------------------------------
// 1. Pure / file-system level
// ---------------------------------------------------------------------------

type PathKind =
  | 'default'
  | 'same'
  | 'dotdot'
  | 'dotslash'
  | 'upper'
  | 'insideAssets'
  | 'assetsDir'
  | 'workflowDir'
  | 'fileSymlink'
  | 'dirSymlink'
  | 'hardlink';
type CacheState = 'absent' | 'valid' | 'corrupted' | 'readOnly' | 'huge';
type ScriptItem = 'mark' | 'point' | 'none' | 'invalid' | 'throws';

const pathKinds: PathKind[] = ['default', 'same', 'dotdot', 'dotslash', 'upper', 'insideAssets', 'assetsDir', 'workflowDir', 'fileSymlink', 'dirSymlink', 'hardlink'];
/** Cache paths that are the workflow file, inside its assets folder, or hold it: the cache must refuse them. */
const refusedKinds = new Set<PathKind>(['same', 'dotdot', 'dotslash', 'upper', 'insideAssets', 'assetsDir', 'workflowDir', 'fileSymlink', 'dirSymlink']);

const scriptResult = (item: ScriptItem): HealResult | Error => {
  switch (item) {
    case 'mark':
      return { kind: 'mark', markId: 1 };
    case 'point':
      return { kind: 'point', x: 250, y: 100 };
    case 'none':
      return { kind: 'none', reason: 'nothing found' };
    case 'invalid':
      return { kind: 'mark', markId: 99 };
    case 'throws':
      return new Error('HTTP 500');
  }
};

/** A page whose picture changes whenever something is clicked, as a real page does when an action has an effect. */
function fakePage(): HealPage {
  let version = 0;
  const touch = async () => void (version += 1);
  const locator = () => ({
    count: async () => 1,
    click: touch,
    hover: async () => undefined,
    fill: touch,
    selectOption: touch,
    press: touch,
    scrollIntoViewIfNeeded: async () => undefined,
  });
  return {
    url: () => 'http://app.test/',
    viewportSize: () => ({ width: 1000, height: 500 }),
    evaluate: async (script: string) =>
      script.includes('const candidates')
        ? { candidates: [{ box: { x: 100, y: 100, width: 80, height: 30 }, role: 'button', name: 'Delete item' }], secrets: [] }
        : undefined,
    screenshot: async () => Buffer.from(`shot-${version}`),
    mouse: { click: touch, move: async () => undefined },
    keyboard: { press: async () => undefined, insertText: async () => undefined, type: async () => undefined },
    getByRole: locator,
    getByText: locator,
    locator,
  } as unknown as HealPage;
}

const step: HealStepData = {
  actionType: 'click',
  selectors: ['role=button[name="Remove"]'],
  anchor: { role: 'button', name: 'Remove' },
  risk: 'read',
  visual: { rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, intent: "Click the button 'Remove'" },
};
const stepKey = healCacheKey({ workflowId: 'wf-1', stepIndex: 0, anchor: 'button|Remove', intent: step.visual?.intent });

interface Scenario {
  kind: PathKind;
  state: CacheState;
  script: ScriptItem[];
  calls: number;
  assetCount: number;
}

const scenarios: fc.Arbitrary<Scenario> = fc.record({
  kind: fc.constantFrom(...pathKinds),
  state: fc.constantFrom<CacheState>('absent', 'valid', 'corrupted', 'readOnly', 'huge'),
  script: fc.array(fc.constantFrom<ScriptItem>('mark', 'point', 'none', 'invalid', 'throws'), { minLength: 1, maxLength: 4 }),
  calls: fc.integer({ min: 1, max: 3 }),
  assetCount: fc.integer({ min: 0, max: 3 }),
});

describe('Property 15, file-system level: a heal never writes the workflow file or its assets', () => {
  it('leaves the workflow file and its assets byte-identical, refuses an aliasing cache path, and writes only under .daemonize/', async () => {
    await fc.assert(
      fc.asyncProperty(scenarios, async (scenario) => {
        const root = await mkdtemp(join(tmpdir(), 'daemonize-heal-immut-'));
        const wfDir = join(root, 'wf');
        const serverDir = join(root, 'server');
        const workflowFile = join(wfDir, 'workflows.json');
        const assetsDir = `${workflowFile}.assets`;
        const cleanup: Array<() => Promise<void>> = [];
        try {
          await mkdir(assetsDir, { recursive: true });
          await mkdir(serverDir, { recursive: true });
          await writeFile(workflowFile, JSON.stringify({ version: '1', targetType: 'web', targetName: 'x', workflows: [], pad: scenario.script }));
          for (let i = 1; i <= scenario.assetCount; i += 1) await writeFile(join(assetsDir, `step-${i}.png`), PNG);

          // Where the cache is configured to be
          let cachePath: string | undefined; // undefined: the default, <server>/.daemonize/heal-cache.json
          let aliasBuilt = true;
          switch (scenario.kind) {
            case 'default':
              break;
            case 'same':
              cachePath = workflowFile;
              break;
            case 'dotdot':
              cachePath = `${wfDir}${sep}..${sep}wf${sep}x${sep}..${sep}workflows.json`;
              break;
            case 'dotslash':
              cachePath = `${wfDir}${sep}.${sep}.${sep}workflows.json`;
              break;
            case 'upper':
              cachePath = caseInsensitiveFs ? workflowFile.toUpperCase() : workflowFile;
              break;
            case 'insideAssets':
              cachePath = join(assetsDir, 'heal-cache.json');
              break;
            case 'assetsDir':
              cachePath = assetsDir;
              break;
            case 'workflowDir':
              cachePath = wfDir;
              break;
            case 'fileSymlink':
              cachePath = join(serverDir, 'alias.json');
              try {
                await symlink(workflowFile, cachePath, 'file');
              } catch {
                aliasBuilt = false; // no right to create file symlinks on this machine
              }
              break;
            case 'dirSymlink':
              try {
                await symlink(wfDir, join(serverDir, 'lnk'), 'junction');
                cachePath = join(serverDir, 'lnk', 'workflows.json');
              } catch {
                aliasBuilt = false;
              }
              break;
            case 'hardlink':
              cachePath = join(serverDir, 'hard.json');
              await link(workflowFile, cachePath);
              break;
          }

          // What the cache holds before the heals (only where it is the real cache)
          const realCache = join(serverDir, '.daemonize', 'heal-cache.json');
          if (scenario.kind === 'default' && scenario.state !== 'absent') {
            await mkdir(join(serverDir, '.daemonize'), { recursive: true });
            if (scenario.state === 'corrupted') await writeFile(realCache, '{"version":"1","entries":{"a":');
            else {
              const entries: Record<string, unknown> = {};
              const count = scenario.state === 'huge' ? MAX_CACHE_ENTRIES + 100 : 1;
              const stamp = new Date(0).toISOString();
              for (let i = 0; i < count; i += 1) {
                entries[i === 0 ? stepKey : `wf-1#${i}#k`] = { locator: { role: 'button', name: 'Delete item' }, healedAt: stamp, lastUsed: stamp, hits: 0 };
              }
              await writeFile(realCache, JSON.stringify({ version: '1', entries }));
              if (scenario.state === 'readOnly') {
                await chmod(realCache, 0o444);
                cleanup.push(() => chmod(realCache, 0o666));
              }
            }
          }

          const protectedPaths = [workflowFile, `${workflowFile}.assets`];
          const env: NodeJS.ProcessEnv = cachePath === undefined ? {} : { DAEMONIZE_HEAL_CACHE: cachePath };
          const before = await snapshot(root);
          const workflowBefore = await readFile(workflowFile);
          const workflowMtime = (await stat(workflowFile)).mtimeMs;

          // The cache itself refuses to be the workflow file, whatever name it is given
          if (aliasBuilt && cachePath !== undefined && refusedKinds.has(scenario.kind)) {
            expect(() => new HealCache(cachePath as string, { protectedPaths }), scenario.kind).toThrow(/must not be the workflow file/);
          }

          // Several calls, each with a new session as each call of the server has
          for (let call = 0; call < scenario.calls; call += 1) {
            const healer = new FakeHealer(scenario.script.map(scriptResult));
            const session = createHealSession({
              env,
              workflowId: 'wf-1',
              baseDir: serverDir,
              protectedPaths,
              loadHealer: async () => ({ available: true, healer, provider: 'fake', model: 'fake' }),
            });
            const outcome = await session.heal({ page: fakePage(), step, stepIndex: 0, noDomTarget: false, timeoutMs: 1000 });
            expect(typeof outcome.ok).toBe('boolean');
          }

          // The workflow file and every asset: same bytes (and same mtime)
          expect(sha(await readFile(workflowFile))).toBe(sha(workflowBefore));
          expect((await stat(workflowFile)).mtimeMs).toBe(workflowMtime);
          const after = await snapshot(root);
          const changed = changedPaths(before, after);
          for (const path of changed) {
            // The hard link is a cache file of its own: it may be replaced (the workflow file keeps its bytes)
            const own = scenario.kind === 'hardlink' && path === 'server/hard.json';
            expect(own || path.startsWith('server/.daemonize/'), `${scenario.kind}: ${path} changed outside .daemonize/`).toBe(true);
          }
          // A refused or aliased cache means nothing at all was written
          if (scenario.kind !== 'default') {
            expect(changed.filter((p) => p.startsWith('wf/'))).toEqual([]);
          }
          if (refusedKinds.has(scenario.kind)) expect(changed).toEqual([]);
        } finally {
          for (const undo of cleanup) await undo().catch(() => undefined);
          await removeDir(root);
        }
      }),
      { numRuns: FS_RUNS }
    );
  });

  it('writes its temporary file and the cache only next to the cache path', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom('put', 'get', 'drop'), { minLength: 1, maxLength: 8 }), async (ops) => {
        const root = await mkdtemp(join(tmpdir(), 'daemonize-heal-immut-ops-'));
        try {
          const workflowFile = join(root, 'workflows.json');
          await writeFile(workflowFile, '{"keep":"me"}');
          const before = sha(await readFile(workflowFile));
          const cache = new HealCache(join(root, '.daemonize', 'heal-cache.json'), { protectedPaths: [workflowFile] });
          for (const op of ops) {
            if (op === 'put') await cache.put(stepKey, { role: 'button', name: 'x' });
            else if (op === 'get') await cache.get(stepKey);
            else await cache.drop(stepKey);
          }
          expect(sha(await readFile(workflowFile))).toBe(before);
          const files = [...(await snapshot(root)).keys()].filter((p) => p !== 'workflows.json');
          for (const file of files) expect(file).toBe('.daemonize/heal-cache.json');
        } finally {
          await removeDir(root);
        }
      }),
      { numRuns: FS_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Static check: every write call of a heal-supported server is derived from the heal cache path
// ---------------------------------------------------------------------------

/**
 * The only places a generated server may write. A new writer fails the test until it is reviewed and listed here.
 *  - heal/cache: the temporary file `${this.path}.<pid>.<random>.tmp` and the rename onto `this.path` (the heal cache);
 *  - web-steps and docker-replay: a failure screenshot under `<os tmpdir>/daemonize-failures/`.
 * None of them can name the workflow file: the cache path is checked against it by `HealCache`, the screenshots go to tmpdir.
 */
const ALLOWED_WRITERS: Array<{ file: RegExp; call: RegExp; definedAs: RegExp }> = [
  { file: /^heal\/cache\.(js|ts)$/, call: /^writeFile\(tmp,/, definedAs: /const tmp = `\$\{this\.path\}\./ },
  { file: /^heal\/cache\.(js|ts)$/, call: /^rename\(tmp, this\.path\)/, definedAs: /const tmp = `\$\{this\.path\}\./ },
  { file: /^heal\/cache\.(js|ts)$/, call: /^rm\(tmp,/, definedAs: /const tmp = `\$\{this\.path\}\./ },
  { file: /^(web-steps|docker-replay)\.(js|ts)$/, call: /^writeFileSync\(path,/, definedAs: /tmpdir\(\), ["']daemonize-failures["']/ },
];
const WRITE_CALL = /(?<![\w$])(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|createWriteStream|unlink|unlinkSync|rm|rmSync|copyFile|copyFileSync|truncate|truncateSync|cp|cpSync|symlink|link|open|openSync)\s*\(/g;

async function sourceFiles(dir: string, root = dir, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, root, out);
    else if (/\.(js|ts)$/.test(entry.name)) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

describe('Property 15, static: the only write calls of a heal-supported server target the heal cache', () => {
  let outDir: string;
  beforeAll(async () => {
    outDir = await mkdtemp(join(workspaceRoot, '.heal-immut-static-'));
    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'Heal Static',
      startUrl: 'http://localhost:8080/',
      workflows: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          label: 'Remove item',
          steps: [{ actionType: 'click', selectors: ['#remove'], anchor: { role: 'button', name: 'Remove', frame: [] }, risk: 'read', visual: { rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, intent: 'Click Remove' } }],
          variables: [],
          observedPayloads: [],
        },
      ],
    };
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), outDir, { healSupport: true, workflowFile: join(tmpdir(), 'never-written', 'workflows.json') });
    } finally {
      console.log = log;
    }
  }, 120000);
  afterAll(async () => {
    if (outDir) await removeDir(outDir);
  });

  it('finds no write API call outside the allowed list', async () => {
    const files = await sourceFiles(outDir);
    expect(files).toContain('heal/cache.js');
    const sources = new Map<string, string>();
    for (const file of files) sources.set(file, await readFile(join(outDir, file), 'utf8'));

    let allowedSeen = 0;
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...files), async (file) => {
        const text = sources.get(file) as string;
        for (const match of text.matchAll(WRITE_CALL)) {
          const call = text.slice(match.index as number).split('\n')[0].trim().replace(/^.*?(?=(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|createWriteStream|unlink|unlinkSync|rm|rmSync|copyFile|copyFileSync|truncate|truncateSync|cp|cpSync|symlink|link|open|openSync)\s*\()/, '');
          const lineStart = text.lastIndexOf('\n', match.index as number) + 1;
          const line = text.slice(lineStart, text.indexOf('\n', lineStart) === -1 ? undefined : text.indexOf('\n', lineStart)).trim();
          // Imports and declarations are not calls
          if (/^(import|export)\b/.test(line) || /\bfunction\s+\w*$/.test(text.slice(lineStart, match.index as number))) continue;
          const rule = ALLOWED_WRITERS.find((r) => r.file.test(file) && r.call.test(call) && r.definedAs.test(text));
          expect(rule, `${file}: unlisted write call: ${line}`).toBeDefined();
          allowedSeen += 1;
        }
      }),
      { numRuns: Math.max(100, files.length * 3) }
    );
    // The scan sees the cache writer and the screenshot writers, so it is not vacuous
    expect(allowedSeen).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Browser level: through the generated server in heal mode
// ---------------------------------------------------------------------------

const DRIFTED_PAGE = `<!doctype html><html><head><title>Items</title></head><body>
<button id="x9" onclick="document.getElementById('out').textContent = 'removed'">Delete item</button>
<p id="out"></p>
</body></html>`;

function removeStep(extra: Partial<WorkflowStep>, index: number): WorkflowStep {
  return {
    actionType: 'click',
    selectors: ['role=button[name="Remove"]', '#remove'],
    anchor: { role: 'button', name: 'Remove', frame: [] },
    risk: 'read',
    visual: { rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.05 }, intent: "Click the button 'Remove'", thumbnailPath: `workflows.json.assets/step-${index}.png` },
    ...extra,
  };
}
const workflow = (id: string, label: string, steps: WorkflowStep[]): Workflow => ({ id, label, steps, variables: [], observedPayloads: [] });

describe('Property 15, browser level: the generated server in heal mode never touches the workflow file', () => {
  let httpServer: Server;
  let root: string;
  let workflowFile: string;
  let healDir: string;
  let logDir: string;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(DRIFTED_PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    const startUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'Heal Immutable',
      startUrl,
      workflows: [
        workflow('a1111111-1111-4111-8111-111111111111', 'Remove item', [removeStep({}, 1)]),
        workflow('a2222222-2222-4222-8222-222222222222', 'Remove write', [removeStep({ risk: 'write' }, 2)]),
      ],
    };
    root = await mkdtemp(join(tmpdir(), 'daemonize-heal-immut-e2e-'));
    logDir = await mkdtemp(join(tmpdir(), 'daemonize-heal-immut-log-'));
    workflowFile = join(root, 'workflows.json');
    await writeFile(workflowFile, JSON.stringify(set, null, 2));
    await mkdir(`${workflowFile}.assets`);
    for (const n of [1, 2]) await writeFile(join(`${workflowFile}.assets`, `step-${n}.png`), PNG);
    healDir = await mkdtemp(join(workspaceRoot, '.heal-immut-e2e-'));
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), healDir, { healSupport: true, workflowFile });
    } finally {
      console.log = log;
    }
  }, 120000);

  afterAll(async () => {
    await new Promise<void>((done) => httpServer?.close(() => done()));
    for (const dir of [healDir, root, logDir]) if (dir) await removeDir(dir);
  });

  it('keeps the workflow file and its assets byte-identical, with the same mtime, over random call sequences', async () => {
    let seed = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom('remove_item', 'remove_write'), { minLength: 2, maxLength: 4 }), fc.boolean(), async (tools, warmCache) => {
        seed += 1;
        const cacheFile = join(healDir, '.daemonize', 'heal-cache.json');
        await rm(cacheFile, { force: true });
        const calls = warmCache ? ['remove_item', ...tools] : tools;
        const before = await snapshot(root);
        const client = new Client({ name: 'heal-immutability', version: '1.0.0' });
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [join(healDir, 'mcp-server.js')],
          cwd: workspaceRoot,
          env: {
            ...chromiumEnv,
            NODE_ENV: 'test',
            DAEMONIZE_MODE: 'heal',
            DAEMONIZE_HEALER_MODULE: fakeHealerModule,
            DAEMONIZE_FAKE_HEALER_LOG: join(logDir, `calls-${seed}.log`),
            DAEMONIZE_FAKE_HEALER_TARGET: 'Delete item',
            DAEMONIZE_STEP_TIMEOUT_MS: '1000',
            DAEMONIZE_WORKFLOW_FILE: workflowFile,
          },
        });
        try {
          await client.connect(transport);
          let healedBefore = false;
          for (const tool of calls) {
            const response = await client.callTool({ name: tool, arguments: {} });
            const result = JSON.parse((response.content as Array<{ text: string }>)[0].text) as Record<string, any>;
            if (tool === 'remove_write') {
              // A write step is never healed without allowHeal: the call fails, and nothing was written
              expect(result).toMatchObject({ success: false, error: 'step_failed', healed: false });
            } else {
              expect(result).toMatchObject({ success: true, healed: true, healedSteps: [{ stepIndex: 0, source: healedBefore ? 'cache' : 'model' }] });
              healedBefore = true;
            }
          }
        } finally {
          await closeClient(client, transport);
        }
        // Nothing under the workflow's folder changed: same bytes, same mtimes, no new file
        expect(changedPaths(before, await snapshot(root))).toEqual([]);
      }),
      { numRuns: BROWSER_RUNS }
    );
  });
});
