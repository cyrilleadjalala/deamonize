import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PowerError } from '../../src/studio/contracts.js';
import { StudioCompileRunner } from '../../src/studio/compile-runner.js';
import { buildSnippetText } from '../../src/studio/mcp-snippet.js';
import { createInstallRecords } from '../../src/studio/install-records.js';
import { createAutoAddStore } from '../../src/studio/auto-add-store.js';
import { createPowerInstaller } from '../../src/studio/power-installer.js';
import { SERVER, writeCompiledOutput } from '../helpers/power-fixture.js';
import { removeDir } from '../helpers/cleanup.js';

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const RUNS = { numRuns: 25 };
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};
const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{7,16}$/);

describe('studio compile and power properties', () => {
  let base: string;
  let counter = 0;
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'studio-cp-prop-'));
  });
  afterAll(async () => {
    await removeDir(base);
  });
  const fresh = async (): Promise<{ out: string; ws: string }> => {
    counter += 1;
    const root = join(base, `case-${counter}`);
    const out = join(root, 'out');
    const ws = join(root, 'ws');
    await mkdir(ws, { recursive: true });
    await writeCompiledOutput(out);
    return { out, ws };
  };
  const installerFor = (out: string, ws: string) =>
    createPowerInstaller({
      locate: async () => ({ slug: SERVER, outDir: out, legacy: false }),
      cwd: ws,
      home: join(out, '..', 'home'),
      // ensure works so the install record can be stored; check is not ok so the snippet carries no data folder
      appData: { dir: join(base, 'appdata'), ensure: async () => { await mkdir(join(base, 'appdata'), { recursive: true }); return { ok: true, dir: join(base, 'appdata') }; }, check: async () => ({ ok: false, problem: 'unresolved' }) },
      vault: { names: async () => new Set<string>(), namesFor: async () => new Set<string>() },
      records: createInstallRecords({ appData: { dir: join(base, 'appdata'), ensure: async () => { await mkdir(join(base, 'appdata'), { recursive: true }); return { ok: true, dir: join(base, 'appdata') }; }, check: async () => ({ ok: true, dir: join(base, 'appdata') }) } }),
      autoAdd: createAutoAddStore({ appData: { dir: join(base, 'appdata'), ensure: async () => ({ ok: true, dir: join(base, 'appdata') }), check: async () => ({ ok: true, dir: join(base, 'appdata') }) } }),
    });
  const files = async (dir: string, prefix = ''): Promise<string[]> => {
    const found: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) found.push(...(await files(join(dir, e.name), rel)));
      else found.push(rel);
    }
    return found.sort();
  };

  // Feature: studio-first-flow, Property 17: The compile status follows the phase events
  // **Validates: Requirements 7.4, 7.5, 7.7, 7.10, 7.11, 7.13**
  it('Property 17: the status follows the phase events', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('generating', 'writing', 'installing'), { maxLength: 6 }),
        fc.boolean(),
        async (events, fail) => {
          let emit!: (p: 'generating' | 'writing' | 'installing') => void;
          let release!: () => void;
          const gate = new Promise<void>((r) => (release = r));
          const runner = new StudioCompileRunner({
            workflowFile: join(base, 'w.json'),
            target: async () => ({ outDir: join(base, 'no-out'), slug: 'app' }),
            playground: () => undefined,
            scrub: (t) => t,
            paths: [],
            compile: (async (_f: string, _o: string, options: { onPhase: typeof emit }) => {
              emit = options.onPhase;
              await gate;
              if (fail) throw new Error('boom');
              return undefined;
            }) as never,
          });
          expect(runner.tryStart()).toBe(true);
          while (emit === undefined) await new Promise((r) => setTimeout(r, 1));
          let expected: 'generating' | 'installing' = 'generating';
          for (const event of events) {
            emit(event);
            if (event !== 'writing') expected = event;
            expect(runner.status()).toEqual({ state: 'running', phase: expected });
          }
          expect(runner.tryStart()).toBe(false);
          release();
          while (runner.status().state === 'running') await new Promise((r) => setTimeout(r, 1));
          const done = runner.status();
          expect(done.phase).toBeNull();
          expect(done.state).toBe(fail ? 'error' : 'done');
          expect(done.error === undefined).toBe(!fail);
        }
      ),
      RUNS
    );
  });

  // Feature: studio-first-flow, Property 18: Error messages carry no path and no secret
  // **Validates: Requirements 7.10, 7.11, 4.12**
  it('Property 18: compile failure messages hold no path and no secret value', async () => {
    await fc.assert(
      fc.asyncProperty(word, fc.constantFrom('C:\\Users\\bob\\proj', '/home/bob/proj', '\\\\server\\share\\x', join(base, 'x')), fc.boolean(), async (secret, path, wrote) => {
        const runner = new StudioCompileRunner({
          workflowFile: join(base, 'w.json'),
          target: async () => ({ outDir: join(base, 'no-out'), slug: 'app' }),
          playground: () => undefined,
          scrub: (t) => t.split(secret).join('***'),
          paths: [base],
          compile: (async (_f: string, _o: string, options: { onPhase: (p: 'writing') => void }) => {
            if (wrote) options.onPhase('writing');
            throw new Error(`cannot open ${path} with ${secret}\nstack line ${path}`);
          }) as never,
        });
        const outcome = await runner.runExclusive();
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.outputMayBeIncomplete).toBe(wrote);
        for (const text of [outcome.message, runner.status().error ?? '']) {
          expect(text).not.toContain(secret);
          expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
          expect(text).not.toContain(base);
          expect(text).not.toMatch(/\/home\/|\\\\server/);
          expect(text.length).toBeLessThanOrEqual(700);
        }
      }),
      RUNS
    );
  });

  // Feature: studio-first-flow, Property 20: Install needs the displayed path and id
  // **Validates: Requirements 11.3**
  it('Property 20: install needs the displayed path and id', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string(), fc.constant(undefined), fc.integer()), fc.string(), fc.boolean(), async (id, path, swap) => {
        const { out, ws } = await fresh();
        const power = installerFor(out, ws);
        const preview = await power.preview({ scope: 'project', workspacePath: ws });
        const before = await files(ws);
        const wrongId = id === preview.confirmationId ? 'x' : id;
        const wrongPath = path === preview.kiroPath ? `${path}x` : path;
        const attempts = swap
          ? [{ confirmationId: preview.confirmationId, kiroPath: wrongPath }, { confirmationId: wrongId, kiroPath: preview.kiroPath }]
          : [{ confirmationId: wrongId, kiroPath: wrongPath }];
        for (const attempt of attempts) {
          await expect(power.install({ ...attempt, scope: 'project' })).rejects.toMatchObject({ status: 409 });
        }
        expect(await files(ws)).toEqual(before);
        // The right pair still works after failed attempts
        await power.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope: 'project' });
      }),
      RUNS
    );
  });

  // Feature: studio-first-flow, Property 21: Workspace validation and write confinement
  // **Validates: Requirements 11.7, 11.8, 11.9, 11.11**
  it('Property 21: invalid workspaces are refused with nothing written, valid ones write only inside .kiro', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string().map((s) => `x${s}`),
          fc.constantFrom('relative/dir', '', '..', '../..', 'C:', '\0'),
          fc.constant(5 as unknown),
          word.map((w) => join(base, 'does-not-exist', w))
        ),
        async (candidate) => {
          const { out, ws } = await fresh();
          const root = join(out, '..');
          const before = await files(root);
          const power = installerFor(out, ws);
          const error = await power.preview({ scope: 'project', workspacePath: candidate }).then(() => undefined, (e: unknown) => e);
          expect(error).toBeInstanceOf(PowerError);
          expect(await files(root)).toEqual(before);
        }
      ),
      RUNS
    );
    await fc.assert(
      fc.asyncProperty(word, async (folder) => {
        const { out, ws } = await fresh();
        const target = join(ws, folder);
        await mkdir(target, { recursive: true });
        const root = join(out, '..');
        const before = (await files(root)).filter((f) => !f.startsWith('out/'));
        const power = installerFor(out, ws);
        const preview = await power.preview({ scope: 'project', workspacePath: target });
        await power.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope: 'project' });
        const added = (await files(root)).filter((f) => !f.startsWith('out/') && !before.includes(f));
        expect(added.length).toBe(2);
        for (const f of added) expect(f.startsWith(`ws/${folder}/.kiro/`)).toBe(true);
      }),
      RUNS
    );
  });

  // Feature: studio-first-flow, Property 22: Merging keeps other entries; invalid settings are untouched
  // **Validates: Requirements 11.4, 11.17, 11.18**
  it('Property 22: merging keeps other entries and invalid settings stay byte-identical', async () => {
    const entryName = fc.stringMatching(/^[a-z][a-z0-9-]{2,12}$/).filter((n) => n !== SERVER);
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(entryName, fc.record({ command: word, args: fc.array(word, { maxLength: 2 }) }), { maxKeys: 4 }),
        fc.dictionary(fc.stringMatching(/^[a-z][a-zA-Z]{2,8}$/).filter((k) => k !== 'mcpServers'), fc.oneof(fc.integer(), word, fc.boolean()), { maxKeys: 3 }),
        async (servers, top) => {
          const { out, ws } = await fresh();
          await mkdir(join(ws, '.kiro', 'settings'), { recursive: true });
          const file = join(ws, '.kiro', 'settings', 'mcp.json');
          await writeFile(file, JSON.stringify({ ...top, mcpServers: servers }));
          const power = installerFor(out, ws);
          const preview = await power.preview({ scope: 'project', workspacePath: ws });
          await power.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope: 'project' });
          const merged = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown> & { mcpServers: Record<string, unknown> };
          for (const [k, v] of Object.entries(top)) expect(merged[k]).toEqual(v);
          for (const [k, v] of Object.entries(servers)) expect(merged.mcpServers[k]).toEqual(v);
          expect(Object.keys(merged.mcpServers)).toContain(SERVER);
        }
      ),
      RUNS
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('{', '[]', 'null', '"x"', '{"mcpServers":[]}', '{"mcpServers":null}', ''), async (content) => {
        const { out, ws } = await fresh();
        await mkdir(join(ws, '.kiro', 'settings'), { recursive: true });
        const file = join(ws, '.kiro', 'settings', 'mcp.json');
        await writeFile(file, content);
        const power = installerFor(out, ws);
        await expect(power.preview({ scope: 'project', workspacePath: ws })).rejects.toMatchObject({ status: 409 });
        expect(await readFile(file, 'utf-8')).toBe(content);
        expect(await files(ws)).toEqual(['.kiro/settings/mcp.json']);
      }),
      RUNS
    );
  });

  // Feature: studio-first-flow, Property 23: Installed files and the snippet hold placeholders only
  // **Validates: Requirements 11.5, 11.6, 11.14, 11.15, 11.16**
  it('Property 23: installed files and the snippet hold placeholders only', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.stringMatching(/^DAEMONIZE_SECRET_[A-Z]{1,6}$/), word, { minKeys: 1, maxKeys: 4 }),
        fc.dictionary(fc.stringMatching(/^[A-Z][A-Z_]{2,8}$/), word, { maxKeys: 3 }),
        async (secretEnv, otherEnv) => {
          const { out, ws } = await fresh();
          await writeCompiledOutput(out);
          const source = JSON.parse(await readFile(join(out, 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, { env: Record<string, string> }> };
          source.mcpServers[SERVER]!.env = { ...otherEnv, ...secretEnv };
          await writeFile(join(out, 'mcp.json'), JSON.stringify(source));
          const power = installerFor(out, ws);
          const preview = await power.preview({ scope: 'project', workspacePath: ws });
          const result = await power.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope: 'project' });
          const values = [...Object.values(secretEnv), ...Object.values(otherEnv)];
          const written = await readFile(join(ws, '.kiro', 'settings', 'mcp.json'), 'utf-8');
          const snippet = await power.snippet();
          for (const text of [written, snippet, JSON.stringify(preview), JSON.stringify(result)]) {
            for (const value of values) expect(text).not.toContain(value);
          }
          expect(result.placeholders).toEqual(Object.keys(secretEnv).sort());
          const env = JSON.parse(snippet).mcpServers[SERVER].env as Record<string, string>;
          for (const [k, v] of Object.entries(env)) expect(v === '${' + k + '}' || k === 'DAEMONIZE_MODE').toBe(true);
          expect(buildSnippetText(SERVER, JSON.parse(snippet).mcpServers[SERVER])).toBe(snippet);
        }
      ),
      RUNS
    );
  });
});
