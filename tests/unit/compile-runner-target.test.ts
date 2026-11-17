import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationLocator } from '../../src/studio/active-app';
import { createAppNames } from '../../src/studio/app-names';
import { StudioCompileRunner } from '../../src/studio/compile-runner';
import { APP_NAME_NOT_SAVED } from '../../src/studio/messages/compile';
import type { AppData } from '../../src/studio/contracts';

describe('compile target', () => {
  let root: string;
  let base: string;
  let data: string;
  const set = { targetType: 'web', targetName: 'Cycyly', startUrl: 'https://cycyly.vercel.app/x', workflows: [] } as never;
  const appData = (): AppData => ({ dir: data, ensure: async () => ({ ok: true, dir: data }), check: async () => ({ ok: true, dir: data }) });
  const locator = () => createApplicationLocator({ baseOutDir: base, apps: createAppNames({ appData: appData() }), loadSet: async () => ({ set }) });
  const runner = (compile: (file: string, out: string, options: Record<string, unknown>) => Promise<unknown>, loc = locator()) =>
    new StudioCompileRunner({
      workflowFile: join(root, 'w.json'),
      target: () => loc.prepareCompile(),
      playground: () => undefined,
      scrub: (t) => t,
      paths: [root],
      compile: compile as never,
      installer: async () => undefined,
    });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'compile-target-'));
    base = join(root, 'daemonize-out');
    data = join(root, 'data');
    await mkdir(data);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the Name_Map entry before compile, writes into the sibling folder and passes powerName', async () => {
    let seen: { out: string; options: Record<string, unknown>; mapped: boolean } | undefined;
    const outcome = await runner(async (_f, out, options) => {
      seen = { out, options, mapped: (await readFile(join(data, 'app-names.json'), 'utf8')).includes('cycyly-vercel-app') };
    }).runExclusive();
    expect(outcome.ok).toBe(true);
    expect(seen?.out).toBe(join(root, 'cycyly-vercel-app'));
    expect(seen?.options.powerName).toBe('cycyly-vercel-app');
    expect(seen?.mapped).toBe(true);
    await expect(readdir(base)).rejects.toThrow();
  });

  it('leaves a legacy folder byte-identical and keeps serving it until the first Studio compile', async () => {
    await mkdir(base);
    await writeFile(join(base, 'mcp-server.js'), '// legacy');
    const mcp = JSON.stringify({ mcpServers: { 'old-name': {} } });
    await writeFile(join(base, 'mcp.json'), mcp);
    const loc = locator();
    expect(await loc.current()).toMatchObject({ slug: 'old-name', outDir: base, legacy: true });
    await runner(async () => undefined, loc).runExclusive();
    expect(await readFile(join(base, 'mcp.json'), 'utf8')).toBe(mcp);
    expect(await readdir(base)).toEqual(['mcp-server.js', 'mcp.json']);
    // Entry exists but the sibling is not compiled yet: still legacy
    expect((await loc.current()).legacy).toBe(true);
    await mkdir(join(root, 'cycyly-vercel-app'));
    await writeFile(join(root, 'cycyly-vercel-app', 'mcp-server.js'), '//');
    expect(await loc.current()).toMatchObject({ slug: 'cycyly-vercel-app', outDir: join(root, 'cycyly-vercel-app'), legacy: false });
  });

  it('writes nothing and reports a plain message when the Name_Map is unusable', async () => {
    await writeFile(join(data, 'app-names.json'), '{bad');
    let called = false;
    const outcome = await runner(async () => {
      called = true;
    }).runExclusive();
    expect(called).toBe(false);
    expect(outcome).toEqual({ ok: false, message: APP_NAME_NOT_SAVED, outputMayBeIncomplete: false });
    expect(await readFile(join(data, 'app-names.json'), 'utf8')).toBe('{bad');
    await expect(readdir(base)).rejects.toThrow();
  });

  it('current() answers the peeked sibling for a fresh application without touching disk', async () => {
    const loc = locator();
    expect(await loc.current()).toMatchObject({ slug: 'cycyly-vercel-app', legacy: false, applicationKey: 'https://cycyly.vercel.app' });
    expect(await readdir(data)).toEqual([]);
    await expect(loc.prepareCompile()).resolves.toMatchObject({ slug: 'cycyly-vercel-app' });
  });
});
