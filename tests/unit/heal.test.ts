import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Compiler } from '../../src/compiler/compiler.js';
import { HealCache } from '../../src/heal/cache.js';
import { createHealSession, loadHealer, cleanEnv, type HealPage, type HealStepData } from '../../src/heal/heal-step.js';
import { parseServeMode } from '../../src/cli/index.js';
import {
  hasNoDomTarget,
  healEligible,
  parseMode,
  shouldHeal,
  type StepLike,
} from '../../src/replay/runtime/step-plan.js';
import type { HealerResolution } from '../../src/heal/providers/index.js';
import type { WorkflowSet } from '../../src/types.js';
import { FakeHealer } from '../helpers/fake-healer.js';
import { removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');

const click = (extra: Partial<StepLike> = {}): StepLike => ({ actionType: 'click', selectors: ['#a'], ...extra });

describe('shouldHeal and healEligible', () => {
  it('follows the truth table of modes, risks and allowHeal', () => {
    const rows: Array<{ mode: 'strict' | 'heal'; risk?: 'read' | 'write' | 'delete'; allowHeal?: boolean; eligible: boolean }> = [
      { mode: 'strict', risk: 'read', eligible: false },
      { mode: 'strict', risk: 'write', allowHeal: true, eligible: false },
      { mode: 'heal', eligible: true },
      { mode: 'heal', risk: 'read', eligible: true },
      { mode: 'heal', risk: 'read', allowHeal: false, eligible: true },
      { mode: 'heal', risk: 'write', eligible: false },
      { mode: 'heal', risk: 'write', allowHeal: false, eligible: false },
      { mode: 'heal', risk: 'write', allowHeal: true, eligible: true },
      { mode: 'heal', risk: 'delete', eligible: false },
      { mode: 'heal', risk: 'delete', allowHeal: true, eligible: true },
    ];
    for (const row of rows) {
      const step = click({ risk: row.risk, allowHeal: row.allowHeal });
      expect(healEligible(step, row.mode), JSON.stringify(row)).toBe(row.eligible);
      // A model is asked only when heal is eligible and one is configured
      expect(shouldHeal(step, row.mode, true), JSON.stringify(row)).toBe(row.eligible);
      expect(shouldHeal(step, row.mode, false), JSON.stringify(row)).toBe(false);
    }
  });

  it('never heals a page switch or a step bound to a table row', () => {
    expect(healEligible({ actionType: 'switch_page', selectors: [] }, 'heal')).toBe(false);
    expect(healEligible(click({ rowBinding: { container: { kind: 'row' } } }), 'heal')).toBe(false);
  });

  it('reads the mode strictly: only the word heal turns it on', () => {
    expect(parseMode('heal')).toBe('heal');
    expect(parseMode(' HEAL ')).toBe('heal');
    for (const value of [undefined, '', 'strict', 'healing', 'true', '1']) expect(parseMode(value)).toBe('strict');
  });

  it('recognises a step without DOM target', () => {
    const visual = { rect: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, intent: 'Click' };
    expect(hasNoDomTarget({ actionType: 'click', selectors: [], anchor: { role: 'canvas', name: '', frame: [] }, visual })).toBe(true);
    expect(hasNoDomTarget({ actionType: 'click', selectors: [], visual })).toBe(true);
    // No picture of where to click, or something to look for: not a canvas step
    expect(hasNoDomTarget({ actionType: 'click', selectors: [], anchor: { role: 'canvas', name: '', frame: [] } })).toBe(false);
    expect(hasNoDomTarget({ actionType: 'click', selectors: ['#a'], visual })).toBe(false);
    expect(hasNoDomTarget({ actionType: 'click', selectors: [], anchor: { role: 'button', name: 'Save', frame: [] }, visual })).toBe(false);
  });
});

describe('--strict and --heal', () => {
  it('are mutually exclusive, and strict is the default', () => {
    expect(() => parseServeMode({ strict: true, heal: true })).toThrow(/cannot be used together/);
    expect(parseServeMode({})).toBe('strict');
    expect(parseServeMode({ strict: true })).toBe('strict');
    expect(parseServeMode({ heal: true })).toBe('heal');
  });
});

/** A page whose picture changes when something is clicked, as a real page does when an action has an effect. */
function fakePage(options: { effect?: boolean } = {}) {
  const clicks: Array<[number, number]> = [];
  const typed: string[] = [];
  let version = 0;
  let roleMatches = 1;
  const touch = () => {
    if (options.effect !== false) version += 1;
  };
  const locator = () => ({
    count: async () => roleMatches,
    click: async () => touch(),
    hover: async () => undefined,
    fill: async (text: string) => {
      typed.push(text);
      touch();
    },
    selectOption: async () => touch(),
    press: async () => touch(),
    scrollIntoViewIfNeeded: async () => undefined,
  });
  const page = {
    url: () => 'http://app.test/',
    viewportSize: () => ({ width: 1000, height: 500 }),
    evaluate: async (script: string) =>
      script.includes('const candidates')
        ? { candidates: [{ box: { x: 100, y: 100, width: 80, height: 30 }, role: 'button', name: 'Delete item' }], secrets: [] }
        : undefined,
    screenshot: async () => Buffer.from(`shot-${version}`),
    mouse: {
      click: async (x: number, y: number) => {
        clicks.push([x, y]);
        touch();
      },
      move: async () => undefined,
    },
    keyboard: { press: async () => undefined, insertText: async (t: string) => void typed.push(t), type: async () => undefined },
    getByRole: locator,
    getByText: locator,
    locator,
  };
  return { page: page as unknown as HealPage, clicks, typed, setRoleMatches: (n: number) => void (roleMatches = n) };
}

const resolution = (healer: FakeHealer): HealerResolution => ({ available: true, healer, provider: 'fake', model: 'fake' });
const unavailable: HealerResolution = { available: false, reason: 'DAEMONIZE_MODEL_PROVIDER is not set' };

const removeButton: HealStepData = {
  actionType: 'click',
  selectors: ['role=button[name="Remove"]'],
  anchor: { role: 'button', name: 'Remove' },
  risk: 'read',
  visual: { rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, intent: "Click the button 'Remove'" },
};

describe('heal session', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-heal-unit-'));
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  const session = (healer: FakeHealer | undefined, extra: { workflowId?: string } = {}) =>
    createHealSession({
      env: {},
      workflowId: extra.workflowId ?? 'wf-1',
      baseDir: dir,
      loadHealer: async () => (healer === undefined ? unavailable : resolution(healer)),
    });
  const input = (page: HealPage, step: HealStepData = removeButton, extra: { noDomTarget?: boolean; stepIndex?: number } = {}) => ({
    page,
    step,
    stepIndex: extra.stepIndex ?? 0,
    noDomTarget: extra.noDomTarget ?? false,
    timeoutMs: 1000,
  });

  it('asks the model, performs the action at the mark, and caches a locator for the next call', async () => {
    const healer = new FakeHealer([{ kind: 'mark', markId: 1 }]);
    const first = fakePage();
    expect(await session(healer).heal(input(first.page))).toEqual({ ok: true, source: 'model' });
    expect(healer.calls).toHaveLength(1);
    expect(healer.calls[0].intent).toBe("Click the button 'Remove'");
    expect(first.clicks).toEqual([[140, 115]]);

    // A new session (a new call) finds the entry in the cache: no model call
    const second = fakePage();
    expect(await session(healer).heal(input(second.page))).toEqual({ ok: true, source: 'cache' });
    expect(healer.calls).toHaveLength(1);

    const file = JSON.parse(await readFile(join(dir, '.daemonize', 'heal-cache.json'), 'utf8'));
    const [entry] = Object.values(file.entries) as Array<{ locator: unknown }>;
    expect(entry.locator).toEqual({ role: 'button', name: 'Delete item' });
  });

  it('caches the point, as fractions of the viewport, when the element has no unique name', async () => {
    const healer = new FakeHealer([{ kind: 'point', x: 250, y: 100 }]);
    const first = fakePage();
    expect(await session(healer).heal(input(first.page))).toEqual({ ok: true, source: 'model' });
    expect(first.clicks).toEqual([[250, 100]]);

    const second = fakePage();
    expect(await session(healer).heal(input(second.page))).toEqual({ ok: true, source: 'cache' });
    expect(second.clicks).toEqual([[250, 100]]);
    expect(healer.calls).toHaveLength(1);
  });

  it('tries the cache before anything else, and drops an entry that no longer works', async () => {
    const healer = new FakeHealer([{ kind: 'mark', markId: 1 }]);
    const warm = fakePage();
    await session(healer).heal(input(warm.page));

    // The cached role locator now matches two elements: not used, the entry goes and the model is asked again
    const crowded = fakePage();
    crowded.setRoleMatches(2);
    const outcome = await session(healer).heal(input(crowded.page));
    expect(healer.calls).toHaveLength(2);
    // The model answer still works on this page
    expect(outcome).toEqual({ ok: true, source: 'model' });
  });

  it('reports heal as unavailable, naming the reason, when no model is configured', async () => {
    const page = fakePage();
    const outcome = await session(undefined).heal(input(page.page));
    expect(outcome).toEqual({ ok: false, unavailable: true, reason: 'DAEMONIZE_MODEL_PROVIDER is not set' });
    expect(page.clicks).toHaveLength(0);
  });

  it('fails without acting when the model answer is not valid for the marks offered', async () => {
    const page = fakePage();
    const healer = new FakeHealer([{ kind: 'mark', markId: 99 }]);
    const outcome = await session(healer).heal(input(page.page));
    expect(outcome).toMatchObject({ ok: false, unavailable: false });
    expect((outcome as { reason: string }).reason).toMatch(/unknown mark id 99/);
    expect(page.clicks).toHaveLength(0);
  });

  it('fails with the reason of a model that finds nothing, or that throws', async () => {
    const none = await session(new FakeHealer([{ kind: 'none', reason: 'the button is gone' }])).heal(input(fakePage().page));
    expect(none).toEqual({ ok: false, unavailable: false, reason: 'the button is gone' });
    const broken = await session(new FakeHealer([new Error('HTTP 500')])).heal(input(fakePage().page));
    expect(broken).toMatchObject({ ok: false, unavailable: false });
    expect((broken as { reason: string }).reason).toMatch(/model call failed: HTTP 500/);
  });

  it('does not store anything in the cache when the action had no visible effect', async () => {
    const page = fakePage({ effect: false });
    const outcome = await session(new FakeHealer([{ kind: 'mark', markId: 1 }])).heal(input(page.page));
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toMatch(/no visible effect/);
    await expect(readdir(join(dir, '.daemonize'))).rejects.toThrow();
  }, 10000);

  it('uses the recorded rectangle of a step without DOM before it calls any model, even with none configured', async () => {
    const page = fakePage();
    const canvasStep: HealStepData = { ...removeButton, selectors: [], anchor: { role: 'canvas', name: '' } };
    const outcome = await session(undefined).heal(input(page.page, canvasStep, { noDomTarget: true }));
    expect(outcome).toEqual({ ok: true, source: 'coordinates' });
    // The centre of x 0.5..0.6, y 0.5..0.6 of a 1000 x 500 viewport
    expect(page.clicks).toEqual([[550, 275]]);
  });

  it('does not repeat a write step whose cached locator acted without effect', async () => {
    const healer = new FakeHealer([{ kind: 'point', x: 10, y: 10 }]);
    const write: HealStepData = { ...removeButton, risk: 'write', allowHeal: true };
    await session(healer).heal(input(fakePage().page, write));
    expect(healer.calls).toHaveLength(1);

    const silent = fakePage({ effect: false });
    const outcome = await session(healer).heal(input(silent.page, write));
    expect(outcome).toMatchObject({ ok: false, unavailable: false });
    expect((outcome as { reason: string }).reason).toMatch(/write step is not repeated/);
    expect(healer.calls).toHaveLength(1);
    expect(silent.clicks).toHaveLength(1);
  }, 10000);

  it('refuses a cache file that is the workflow file', async () => {
    const workflowFile = join(dir, 'workflows.json');
    await writeFile(workflowFile, '{"keep":"me"}');
    const guarded = createHealSession({
      env: { DAEMONIZE_HEAL_CACHE: workflowFile },
      workflowId: 'wf-1',
      baseDir: dir,
      protectedPaths: [workflowFile],
      loadHealer: async () => resolution(new FakeHealer([{ kind: 'mark', markId: 1 }])),
    });
    const outcome = await guarded.heal(input(fakePage().page));
    expect(outcome).toEqual({ ok: true, source: 'model' });
    expect(await readFile(workflowFile, 'utf8')).toBe('{"keep":"me"}');
  });
});

describe('heal cache path protection', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-heal-protect-'));
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('refuses the workflow file, its assets folder, anything inside, and a folder holding it, under any spelling', async () => {
    const wfDir = join(dir, 'wf');
    const file = join(wfDir, 'workflows.json');
    await mkdir(`${file}.assets`, { recursive: true });
    await writeFile(file, '{}');
    const protectedPaths = [file, `${file}.assets`];
    const refused = [
      file,
      `${wfDir}/../wf/./workflows.json`,
      join(`${file}.assets`, 'heal-cache.json'),
      `${file}.assets`,
      wfDir,
      ...(process.platform === 'win32' || process.platform === 'darwin' ? [file.toUpperCase()] : []),
    ];
    for (const path of refused) expect(() => new HealCache(path, { protectedPaths }), path).toThrow(/must not be the workflow file/);

    // A junction to the workflow folder is the same file
    const link = join(dir, 'lnk');
    await symlink(wfDir, link, 'junction');
    expect(() => new HealCache(join(link, 'workflows.json'), { protectedPaths })).toThrow(/must not be the workflow file/);

    expect(() => new HealCache(join(dir, 'server', '.daemonize', 'heal-cache.json'), { protectedPaths })).not.toThrow();
  });
});

describe('the healer of a server', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-heal-module-'));
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('honours DAEMONIZE_HEALER_MODULE only under NODE_ENV=test or the unsafe flag', async () => {
    const module = join(dir, 'healer.mjs');
    await writeFile(module, "export default { async locate() { return { kind: 'none', reason: 'from the module' }; } };\n");
    const env = { DAEMONIZE_HEALER_MODULE: module };

    expect((await loadHealer({ ...env, NODE_ENV: 'test' })).available).toBe(true);
    expect((await loadHealer({ ...env, DAEMONIZE_UNSAFE_HEALER_MODULE: '1' })).available).toBe(true);
    // Anywhere else the module is ignored, and the model settings decide (none here)
    for (const other of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'development' }, { DAEMONIZE_UNSAFE_HEALER_MODULE: '0' }]) {
      expect(await loadHealer({ ...env, ...other })).toEqual({ available: false, reason: 'DAEMONIZE_MODEL_PROVIDER is not set' });
    }
  });

  it('reports a module that cannot be loaded instead of falling back to a model', async () => {
    const outcome = await loadHealer({ NODE_ENV: 'test', DAEMONIZE_HEALER_MODULE: join(dir, 'missing.mjs') });
    expect(outcome.available).toBe(false);
  });

  it('treats a ${NAME} placeholder that nobody expanded as not set', () => {
    expect(cleanEnv({ A: '${A}', B: ' ${B} ', C: 'value', D: undefined })).toEqual({ C: 'value' });
  });
});

describe('compiled output', () => {
  const set: WorkflowSet = {
    version: '1',
    targetType: 'web',
    targetName: 'Heal Unit',
    startUrl: 'http://localhost:8080/',
    workflows: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        label: 'Remove item',
        steps: [
          {
            actionType: 'click',
            selectors: ['#remove'],
            anchor: { role: 'button', name: 'Remove', frame: [] },
            risk: 'read',
            visual: { rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, intent: "Click the button 'Remove'", thumbnailPath: 'workflows.json.assets/step-1.png' },
          },
        ],
        variables: [],
        observedPayloads: [],
      },
    ],
  };

  let strictDir: string;
  let healDir: string;

  async function compileTo(options: { healSupport?: boolean; workflowFile?: string }): Promise<string> {
    const out = await mkdtemp(join(workspaceRoot, '.heal-unit-'));
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(set, out, options);
    } finally {
      console.log = log;
    }
    return out;
  }

  async function filesOf(dir: string, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) out.push(...(await filesOf(dir, relative)));
      else out.push(relative);
    }
    return out;
  }

  beforeEach(async () => {
    strictDir = await compileTo({});
    const source = await mkdtemp(join(tmpdir(), 'daemonize-heal-src-'));
    await mkdir(join(source, 'workflows.json.assets'));
    await writeFile(join(source, 'workflows.json.assets', 'step-1.png'), Buffer.from('not-really-a-png'));
    healDir = await compileTo({ healSupport: true, workflowFile: join(source, 'workflows.json') });
    await removeDir(source);
  });
  afterEach(async () => {
    await removeDir(strictDir);
    await removeDir(healDir);
  });

  it('contains no model code, no heal module and no model setting when compiled without --heal-support', async () => {
    const files = await filesOf(strictDir);
    expect(files.some((f) => f.startsWith('heal/'))).toBe(false);
    expect(files).not.toContain('.daemonize/anchors/step-1.png');
    for (const file of files) {
      const text = await readFile(join(strictDir, file), 'utf8');
      expect(text, file).not.toMatch(/anthropic|openai|DAEMONIZE_MODEL/i);
      expect(text, file).not.toMatch(/heal-step|heal\/|createHealSession/);
    }
    const mcp = JSON.parse(await readFile(join(strictDir, 'mcp.json'), 'utf8'));
    expect(Object.values(mcp.mcpServers)[0]).toMatchObject({ env: { DAEMONIZE_MODE: 'strict' } });
    const skill = await readFile(join(strictDir, 'skills', 'heal-unit', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/compiled without heal support/);
    expect(skill).toMatch(/--heal-support/);
    expect(await readFile(join(strictDir, 'sandbox', 'Dockerfile'), 'utf8')).not.toMatch(/heal/i);
  });

  it('emits the heal modules, the thumbnails and the model placeholders with --heal-support', async () => {
    const files = await filesOf(healDir);
    for (const file of ['heal/heal-step.js', 'heal/healer.js', 'heal/marks.js', 'heal/cache.js', 'heal/providers/index.js']) {
      expect(files).toContain(file);
    }
    // The generated modules import nothing from src/
    for (const file of files.filter((f) => f.startsWith('heal/') && f.endsWith('.js'))) {
      const text = await readFile(join(healDir, file), 'utf8');
      expect(text, file).not.toMatch(/from ['"](?:\.\.\/)+(?:src|replay|compiler)/);
    }
    expect(await readFile(join(healDir, '.daemonize', 'anchors', 'step-1.png'), 'utf8')).toBe('not-really-a-png');

    const server = await readFile(join(healDir, 'mcp-server.ts'), 'utf8');
    expect(server).toContain('.daemonize/anchors/step-1.png');
    expect(server).not.toContain('.assets');

    const mcp = JSON.parse(await readFile(join(healDir, 'mcp.json'), 'utf8'));
    const env = (Object.values(mcp.mcpServers)[0] as { env: Record<string, string> }).env;
    expect(env.DAEMONIZE_MODE).toBe('strict');
    expect(env.DAEMONIZE_MODEL_API_KEY).toBe('${DAEMONIZE_MODEL_API_KEY}');
    expect(JSON.stringify(mcp)).not.toMatch(/sk-/);
    expect(await readFile(join(healDir, 'skills', 'heal-unit', 'SKILL.md'), 'utf8')).toMatch(/daemonize serve --heal/);
    expect(await readFile(join(healDir, 'sandbox', 'Dockerfile'), 'utf8')).toContain('COPY heal ./heal');
  });

  it('does not import the heal modules statically from the replay', async () => {
    const replay = await readFile(join(healDir, 'replay.ts'), 'utf8');
    expect(replay).not.toMatch(/^import .*from ["']\.\/heal/m);
    expect(replay).toMatch(/await import\("\.\/heal\/heal-step\.js"\)/);
  });

  it('passes the mode and the model settings, by name, to the container of a heal call', async () => {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(join(healDir, 'docker-replay.js')).href)) as {
      buildDockerArgs: (o: unknown) => string[];
    };
    const anchors = join(healDir, '.daemonize', 'anchors');
    const heal = { cacheDir: join(healDir, '.daemonize'), cacheFile: 'heal-cache.json', anchorsDir: anchors };
    process.env.DAEMONIZE_MODEL_API_KEY = 'sk-should-never-appear-in-argv';
    try {
      const args = mod.buildDockerArgs({ name: 'n', timeoutEnv: [], steps: [], mode: 'heal', heal });
      expect(args).toContain('DAEMONIZE_MODE=heal');
      expect(args[args.indexOf('DAEMONIZE_MODE=heal') - 1]).toBe('-e');
      for (const name of ['DAEMONIZE_MODEL_PROVIDER', 'DAEMONIZE_MODEL_NAME', 'DAEMONIZE_MODEL_API_KEY', 'DAEMONIZE_MODEL_BASE_URL']) {
        expect(args[args.indexOf(name) - 1], name).toBe('-e');
      }
      expect(args.join(' ')).not.toContain('sk-should-never-appear-in-argv');
      expect(args).toContain(`${anchors}:/run/daemonize/anchors:ro`);
      expect(args).toContain('DAEMONIZE_ANCHORS_DIR=/run/daemonize/anchors');
      expect(args).toContain('DAEMONIZE_HEAL_CACHE=/run/daemonize/heal/heal-cache.json');

      const strict = mod.buildDockerArgs({ name: 'n', timeoutEnv: [], steps: [], mode: 'strict', heal });
      expect(strict).toContain('DAEMONIZE_MODE=strict');
      expect(strict.join(' ')).not.toMatch(/DAEMONIZE_MODEL|anchors/);
      expect(mod.buildDockerArgs({ name: 'n', timeoutEnv: [], steps: [] })).toContain('DAEMONIZE_MODE=strict');
    } finally {
      delete process.env.DAEMONIZE_MODEL_API_KEY;
    }
  });

  it('never forwards a model setting to the container of a server compiled without --heal-support', async () => {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(join(strictDir, 'docker-replay.js')).href)) as {
      buildDockerArgs: (o: unknown) => string[];
    };
    const args = mod.buildDockerArgs({
      name: 'n',
      timeoutEnv: [],
      steps: [],
      mode: 'heal',
      heal: { cacheDir: strictDir, cacheFile: 'c.json', anchorsDir: strictDir },
    });
    expect(args).toContain('DAEMONIZE_MODE=heal');
    expect(args.join(' ')).not.toMatch(/DAEMONIZE_MODEL|ANTHROPIC|OPENAI|anchors/);
  });
});
