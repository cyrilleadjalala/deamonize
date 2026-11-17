import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, type CompilePhase } from '../../src/cli/commands/compile.js';
import { removeDir } from '../helpers/cleanup.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const fixture = (steps: unknown[]): string =>
  JSON.stringify({
    version: '1',
    targetType: 'web',
    targetName: 'App',
    startUrl: 'http://localhost:8080/',
    workflows: [
      {
        id: 'd1111111-1111-4111-8111-111111111111',
        label: 'Create customer',
        steps,
        variables: [],
        observedPayloads: [],
      },
    ],
  });

describe('compile onPhase', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'compile-onphase-'));
  });
  afterAll(async () => {
    await removeDir(dir);
  });

  const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      return await run();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  };

  it('reports generating, writing, installing in order, and writing comes before the first file', async () => {
    const file = join(dir, 'ok.json');
    await writeFile(file, fixture([{ actionType: 'click', selectors: ['#go'] }]));
    const out = join(dir, 'out-ok');
    const events: string[] = [];
    await quiet(() =>
      compile(file, out, {
        install: true,
        installer: async () => {
          events.push('installer');
        },
        onPhase: (phase: CompilePhase) => {
          events.push(phase);
        },
      })
    );
    expect(events).toEqual(['generating', 'writing', 'installing', 'installer']);
    await expect(access(join(out, 'mcp-server.js'))).resolves.toBeUndefined();
  });

  it('creates nothing before writing is reported', async () => {
    const file = join(dir, 'order.json');
    await writeFile(file, fixture([{ actionType: 'click', selectors: ['#go'] }]));
    const out = join(dir, 'out-order');
    let seenAtWriting = true;
    await quiet(() =>
      compile(file, out, {
        onPhase: (phase) => {
          if (phase === 'writing') {
            seenAtWriting = false;
            void access(out).then(
              () => {
                seenAtWriting = true;
              },
              () => undefined
            );
          }
        },
      })
    );
    expect(seenAtWriting).toBe(false);
  });

  it('emits no writing event and leaves the output folder absent when a plain secret stops the compile', async () => {
    const file = join(dir, 'plain.json');
    await writeFile(
      file,
      fixture([{ actionType: 'type', selectors: ['#pw'], secretRef: 'PASSWORD', value: 'plain-value-1' }])
    );
    const out = join(dir, 'out-plain');
    const events: string[] = [];
    await expect(quiet(() => compile(file, out, { onPhase: (p) => events.push(p) }))).rejects.toThrow();
    expect(events).not.toContain('writing');
    await expect(access(out)).rejects.toThrow();
  });

  it('works without onPhase (the CLI passes none)', async () => {
    const file = join(dir, 'cli.json');
    await writeFile(file, fixture([{ actionType: 'click', selectors: ['#go'] }]));
    const result = await quiet(() => compile(file, join(dir, 'out-cli')));
    expect(result.toolNames.size).toBe(1);
  });
});
