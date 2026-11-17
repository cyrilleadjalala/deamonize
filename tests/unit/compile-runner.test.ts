import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompileRunner, InstallTimeout, scrubMessage, StudioCompileRunner } from '../../src/studio/compile-runner.js';
import type { CompileOptions } from '../../src/cli/commands/compile.js';
import { removeDir } from '../helpers/cleanup.js';

type Fake = (file: string, out: string, options: CompileOptions) => Promise<never>;

describe('Compile_Runner', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'compile-runner-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await removeDir(dir);
  });

  const make = (compile: Fake, extra: Partial<ConstructorParameters<typeof StudioCompileRunner>[0]> = {}, stop = vi.fn(async () => undefined)) => {
    const runner = new StudioCompileRunner({
      workflowFile: join(dir, 'daemonize.workflows.json'),
      target: async () => ({ outDir: join(dir, 'out'), slug: 'app' }),
      playground: () => ({ stop }) as never,
      scrub: (t) => t,
      paths: [dir],
      compile: compile as never,
      ...extra,
    });
    return { runner, stop };
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 200; i += 1) await new Promise((r) => setImmediate(r));
    // The runner now reads the folder (real file system I/O) before it compiles: give that I/O time, also on a loaded machine
    // (Only setImmediate and Date are used: timers may be faked by the test)
    for (const end = Date.now() + 100; Date.now() < end; ) await new Promise((r) => setImmediate(r));
  };

  it('passes install: true only when node_modules is absent, with the default options', async () => {
    const seen: CompileOptions[] = [];
    const { runner } = make(async (_f, _o, options) => {
      seen.push(options);
      return undefined as never;
    });
    await runner.runExclusive();
    await mkdir(join(dir, 'out', 'node_modules'), { recursive: true });
    await runner.runExclusive();
    expect(seen[0]).toMatchObject({ http: 'off', healSupport: false, install: true });
    expect(seen[0]?.suggest).toBeUndefined();
    expect(seen[0]?.sandbox).toBeUndefined();
    expect(seen[1]?.install).toBeUndefined();
  });

  it('shows running with the phase, refuses a second start, then stops the playground after success', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let phase!: (p: 'generating' | 'writing' | 'installing') => void;
    const { runner, stop } = make(async (_f, _o, options) => {
      phase = options.onPhase!;
      await gate;
      return undefined as never;
    });
    expect(runner.status()).toEqual({ state: 'idle', phase: null });
    expect(runner.tryStart()).toBe(true);
    expect(runner.tryStart()).toBe(false);
    await settle();
    expect(runner.status()).toEqual({ state: 'running', phase: 'generating' });
    phase('writing');
    expect(runner.status().phase).toBe('generating');
    phase('installing');
    expect(runner.status()).toEqual({ state: 'running', phase: 'installing' });
    release();
    await settle();
    expect(runner.status()).toEqual({ state: 'done', phase: null });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('reports an unchanged folder when nothing was written, and stops the playground only after writing', async () => {
    const early = make(async () => {
      throw new Error('bad file');
    });
    const outcome = await early.runner.runExclusive();
    expect(outcome).toMatchObject({ ok: false, outputMayBeIncomplete: false });
    expect(early.runner.status().state).toBe('error');
    expect(early.stop).not.toHaveBeenCalled();

    const late = make(async (_f, _o, options) => {
      options.onPhase?.('writing');
      throw new Error('disk full');
    });
    const out2 = await late.runner.runExclusive();
    expect(out2).toMatchObject({ ok: false, outputMayBeIncomplete: true });
    expect(late.stop).toHaveBeenCalledTimes(1);
  });

  it('runExclusive waits for a running compile and then runs its own', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { runner } = make(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return undefined as never;
    });
    runner.tryStart();
    const second = runner.runExclusive();
    await settle();
    expect(calls).toBe(1);
    release();
    await expect(second).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('turns an install past the time limit into a plain timeout message', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { runner } = make(
      async (_f, _o, options) => {
        await new Promise<void>((_resolve, reject) => setTimeout(() => reject(new InstallTimeout()), 600_000));
        return options as never;
      },
      {}
    );
    const outcome = runner.runExclusive();
    await settle();
    await vi.advanceTimersByTimeAsync(600_001);
    const result = await outcome;
    expect(result.ok).toBe(false);
    expect(runner.status().error).toMatch(/took too long/);
  });

  it('close() stops a real install through the quiet installer', async () => {
    const runner = createCompileRunner({
      workflowFile: join(dir, 'w.json'),
      target: async () => ({ outDir: join(dir, 'out'), slug: 'app' }),
      playground: () => undefined,
      scrub: (t) => t,
      paths: [],
    });
    await expect(runner.close()).resolves.toBeUndefined();
  });

  it('scrubs folders and absolute paths from messages', () => {
    const text = scrubMessage(`failed in ${dir} and C:\\Users\\bob\\x.txt and /var/lib/app/file`, [dir]);
    expect(text).not.toContain(dir);
    expect(text).toContain('<folder>');
    expect(text).not.toContain('bob');
    expect(text).not.toContain('/var/lib');
    expect(scrubMessage('x'.repeat(500), []).length).toBeLessThanOrEqual(300);
  });
});
