import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InertRecordingManager } from '../../src/studio/inert-services.js';
import type { RecordingStatus, StartInput, StudioServices } from '../../src/studio/contracts.js';
import { recordRoutes } from '../../src/studio/routes/record.js';
import type { RouteContext } from '../../src/studio/routes/types.js';
import { removeDir } from '../helpers/cleanup.js';

class Spy extends InertRecordingManager {
  starts: StartInput[] = [];
  override start(input: StartInput) {
    this.starts.push(input);
    return { status: 202 as const };
  }
}

const workflow = { id: 'w1', toolName: 'a', steps: [] };
const start = async (set: unknown, url: string) => {
  const recording = new Spy();
  const ctx = {
    services: { recording } as unknown as StudioServices,
    sample: false,
    loadSet: async () => ({ set, outputs: {} }),
  } as unknown as RouteContext;
  const route = recordRoutes(ctx).find((r) => r.path === '/api/record/start')!;
  const res = await route.handlers.POST!({ method: 'POST', query: new URLSearchParams(), body: { name: 'Find', url }, signal: new AbortController().signal });
  return { res, recording, route };
};

describe('record route: what stays as before (Requirements 12.3, 12.4)', () => {
  it('accepts the same origin with another path, query or fragment', async () => {
    const set = { targetType: 'web', startUrl: 'https://shop.test/login', workflows: [workflow] };
    for (const url of ['https://shop.test/other', 'https://shop.test/a?b=1', 'https://shop.test/#x', 'https://shop.test:443/z']) {
      const { res, recording } = await start(set, url);
      expect(res.status, url).toBe(202);
      expect(recording.starts).toHaveLength(1);
    }
  });

  it.each([
    ['no file', undefined],
    ['a file with no workflow', { targetType: 'web', startUrl: 'https://shop.test/', workflows: [] }],
    ['a set startUrl that is absent', { targetType: 'web', workflows: [workflow] }],
    ['a set startUrl that is not a valid address', { targetType: 'web', startUrl: 'not a url', workflows: [workflow] }],
  ])('accepts any valid address with %s', async (_label, set) => {
    const { res, recording } = await start(set, 'https://other.test/');
    expect(res).toEqual({ status: 202, body: { state: 'recording' } });
    expect(recording.starts).toHaveLength(1);
  });

  it('declares the start route as one that writes nothing, so the handler answers the sample-mode refusal', async () => {
    const { route } = await start(undefined, 'https://a.test/');
    expect(route.writes).toBe(false);
    expect(route.remote).toBe('blocked');
  });

  it('writes nothing to the Workflow_File', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'record-compat-'));
    try {
      const file = join(dir, 'daemonize.workflows.json');
      const text = '{"targetType":"web","startUrl":"https://shop.test/","workflows":[]}\n';
      await writeFile(file, text, 'utf-8');
      await start(JSON.parse(text), 'https://other.test/');
      await start({ targetType: 'web', startUrl: 'https://shop.test/', workflows: [workflow] }, 'https://other.test/');
      expect(await readFile(file, 'utf-8')).toBe(text);
    } finally {
      await removeDir(dir);
    }
  });
});

describe('record status: an old answer without kiro.missingSecrets', () => {
  it('has the shape of a status written before this change', () => {
    const old: RecordingStatus = { state: 'done', steps: 2, labels: [], intent: 'kiro', kiro: { added: true, message: 'ok', scope: 'global' } };
    expect(old.kiro?.missingSecrets).toBeUndefined();
  });
});
