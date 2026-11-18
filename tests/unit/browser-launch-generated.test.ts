import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { WorkflowSet } from '../../src/types.js';
import { launchBrowser, type LaunchFn } from '../../src/recorder/browser-launcher.js';
import { removeDir } from '../helpers/cleanup.js';

const set: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: 'Launch Parity',
  startUrl: 'http://localhost:8080/',
  workflows: [{ id: 'd4444444-4444-4444-8444-444444444444', label: 'Go', steps: [{ actionType: 'click', selectors: ['#go'] }], variables: [], observedPayloads: [] }],
};

async function compileTo(dir: string): Promise<void> {
  const log = console.log;
  console.log = () => {};
  try {
    await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
  } finally {
    console.log = log;
  }
}

const MESSAGES = ["browserType.launch: Executable doesn't exist at /x", "Chromium distribution 'chrome' is not found at /x", "Chromium distribution 'msedge' is not found at /x"];

// Feature: kiro-thin-extension, Property 22: The generated launcher matches src/recorder/browser-launcher.ts
describe('Property 22: The generated launcher matches src/recorder/browser-launcher.ts', () => {
  let dirA = '';
  let dirB = '';
  beforeAll(async () => {
    dirA = await mkdtemp(join(tmpdir(), 'daemonize-launch-a-'));
    dirB = await mkdtemp(join(tmpdir(), 'daemonize-launch-b-'));
    await compileTo(dirA);
    await compileTo(dirB);
  });
  afterAll(async () => {
    await removeDir(dirA);
    await removeDir(dirB);
  });

  it('**Validates: Requirements 15.9, 15.11** has the same attempt order as the recorder launcher', async () => {
    const generated = (await import(/* @vite-ignore */ new URL(`file:///${join(dirA, 'browser-launch.js').replace(/\\/g, '/')}`).href)) as typeof import('../../src/replay/runtime/browser-launch.js');
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom('ok', 'missing', 'other'), { minLength: 3, maxLength: 3 }), async (outcomes) => {
        const respond = (calls: unknown[]) => {
          const index = calls.length - 1;
          if (outcomes[index] === 'ok') return {} as never;
          throw new Error(outcomes[index] === 'missing' ? MESSAGES[index] : 'boom');
        };
        const recorded: Array<{ channel?: string }> = [];
        const replayed: Array<{ channel?: string }> = [];
        const recorderLaunch: LaunchFn = async (o) => (recorded.push(o), respond(recorded));
        await launchBrowser({ env: {}, launch: recorderLaunch }).catch(() => undefined);
        await generated
          .launchReplayBrowser({ launch: async (o) => (replayed.push(o), respond(replayed)) }, {})
          .catch(() => undefined);
        expect(replayed.map((c) => c.channel)).toEqual(recorded.map((c) => c.channel));
      }),
      { numRuns: 100 }
    );
  });

  it('**Validates: Requirements 15.9** two compiles give the same bytes', async () => {
    for (const name of ['browser-launch.ts', 'browser-launch.js']) {
      expect(await readFile(join(dirA, name), 'utf-8')).toBe(await readFile(join(dirB, name), 'utf-8'));
    }
    expect(await readFile(join(dirA, 'browser-launch.ts'), 'utf-8')).toBe(await readFile('src/replay/runtime/browser-launch.ts', 'utf-8'));
  });
});
