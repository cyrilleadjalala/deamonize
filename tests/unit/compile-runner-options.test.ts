import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioCompileRunner } from '../../src/studio/compile-runner.js';
import { compileRoutes } from '../../src/studio/routes/compile.js';
import type { StudioServices } from '../../src/studio/contracts.js';
import type { RouteContext, RouteRequest } from '../../src/studio/routes/types.js';
import { removeDir } from '../helpers/cleanup.js';

const req = (body: Record<string, unknown> = {}): RouteRequest => ({ method: 'POST', query: new URLSearchParams(), body, signal: new AbortController().signal });

describe('Compile_Runner stored options', () => {
  let dir: string;
  let seen: Array<{ http: unknown; healSupport: unknown }>;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'compile-options-'));
    seen = [];
    release = undefined;
    gate = undefined;
  });
  afterEach(async () => {
    release?.();
    await removeDir(dir);
  });

  const make = () =>
    new StudioCompileRunner({
      workflowFile: join(dir, 'w.json'),
      target: async () => ({ outDir: join(dir, 'out'), slug: 'app' }),
      playground: () => undefined,
      scrub: (t) => t,
      paths: [dir],
      compile: (async (_f: string, _o: string, options: { http: unknown; healSupport: unknown }) => {
        seen.push({ http: options.http, healSupport: options.healSupport });
        await gate;
      }) as never,
      installer: async () => undefined,
    });
  const waitIdle = async (runner: StudioCompileRunner): Promise<void> => {
    while (runner.status().state === 'running') await new Promise((r) => setTimeout(r, 2));
  };
  const post = (runner: StudioCompileRunner, body: Record<string, unknown>) =>
    compileRoutes({ services: { compiler: runner } as unknown as StudioServices } as RouteContext)[0]!.handlers.POST!(req(body));
  const hold = (): void => {
    gate = new Promise<void>((r) => (release = r));
  };

  it('passes the given options to compile and keeps them for later compiles', async () => {
    const runner = make();
    expect(runner.tryStart({ http: 'auto', healSupport: true })).toBe(true);
    await waitIdle(runner);
    expect(runner.options()).toEqual({ http: 'auto', healSupport: true });
    // A compile started by a recording or by the editor passes no options
    expect((await runner.runExclusive()).ok).toBe(true);
    expect(runner.tryStart()).toBe(true);
    await waitIdle(runner);
    expect(seen).toEqual([
      { http: 'auto', healSupport: true },
      { http: 'auto', healSupport: true },
      { http: 'auto', healSupport: true },
    ]);
  });

  it('replaces the options only when a compile starts with new ones', async () => {
    const runner = make();
    runner.tryStart({ http: 'auto', healSupport: false });
    await waitIdle(runner);
    runner.tryStart({ http: 'off', healSupport: true });
    await waitIdle(runner);
    expect(runner.options()).toEqual({ http: 'off', healSupport: true });
    expect(seen.at(-1)).toEqual({ http: 'off', healSupport: true });
  });

  it('keeps the stored options after a 400 and after a 409, and starts nothing', async () => {
    const runner = make();
    runner.tryStart({ http: 'auto', healSupport: true });
    await waitIdle(runner);
    expect((await post(runner, { http: 'sometimes' })).status).toBe(400);
    expect((await post(runner, { other: 1 })).status).toBe(400);
    expect(seen).toHaveLength(1);
    expect(runner.options()).toEqual({ http: 'auto', healSupport: true });

    hold();
    expect(runner.tryStart()).toBe(true);
    expect((await post(runner, { http: 'off', healSupport: false })).status).toBe(409);
    expect(runner.options()).toEqual({ http: 'auto', healSupport: true });
    release?.();
    await waitIdle(runner);
    expect(seen).toHaveLength(2);
  });

  it('writes nothing to disk', async () => {
    const runner = make();
    runner.tryStart({ http: 'auto', healSupport: true });
    await waitIdle(runner);
    expect(await readdir(dir)).toEqual([]);
  });
});
