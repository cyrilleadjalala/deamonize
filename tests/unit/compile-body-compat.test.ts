import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioCompileRunner } from '../../src/studio/compile-runner.js';
import { compileRoutes } from '../../src/studio/routes/compile.js';
import type { StudioServices } from '../../src/studio/contracts.js';
import type { RouteContext, RouteRequest } from '../../src/studio/routes/types.js';
import { removeDir } from '../helpers/cleanup.js';

const req = (body: Record<string, unknown> = {}): RouteRequest => ({ method: 'POST', query: new URLSearchParams(), body, signal: new AbortController().signal });

describe('compile request compatibility (Requirements 21.4, 21.7, 21.15)', () => {
  let dir: string;
  let seen: Array<{ http: unknown; healSupport: unknown }>;
  const WORKFLOWS = '{"version":1,"targets":[]}\n';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'compile-compat-'));
    seen = [];
    await writeFile(join(dir, 'daemonize.workflows.json'), WORKFLOWS);
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  const make = () =>
    new StudioCompileRunner({
      workflowFile: join(dir, 'daemonize.workflows.json'),
      target: async () => ({ outDir: join(dir, 'out'), slug: 'app' }),
      playground: () => undefined,
      scrub: (t) => t,
      paths: [dir],
      compile: (async (_f: string, _o: string, options: { http: unknown; healSupport: unknown }) => {
        seen.push({ http: options.http, healSupport: options.healSupport });
      }) as never,
      installer: async () => undefined,
    });
  const post = (runner: StudioCompileRunner, body?: Record<string, unknown>) =>
    compileRoutes({ services: { compiler: runner } as unknown as StudioServices } as RouteContext)[0]!.handlers.POST!(req(body));
  const idle = async (runner: StudioCompileRunner): Promise<void> => {
    while (runner.status().state === 'running' || runner.status().state === 'idle') await new Promise((r) => setTimeout(r, 5));
  };

  it('compiles with off and false for a request with no field, and writes nothing to daemonize.workflows.json', async () => {
    const runner = make();
    expect((await post(runner)).status).toBe(202);
    await idle(runner);
    expect(seen).toEqual([{ http: 'off', healSupport: false }]);
    expect(await readFile(join(dir, 'daemonize.workflows.json'), 'utf8')).toBe(WORKFLOWS);
    expect(await readdir(dir)).toEqual(['daemonize.workflows.json']);
  });

  it('accepts the empty body of an earlier Studio version and a body with one field', async () => {
    const runner = make();
    expect((await post(runner, {})).status).toBe(202);
    await idle(runner);
    expect((await post(runner, { healSupport: true })).status).toBe(202);
    while (seen.length < 2 || runner.status().state === 'running') await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([
      { http: 'off', healSupport: false },
      { http: 'off', healSupport: true },
    ]);
  });

  it('starts a new runner with the default options', () => {
    expect(make().options()).toEqual({ http: 'off', healSupport: false });
  });
});
