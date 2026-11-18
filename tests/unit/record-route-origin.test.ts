import { describe, expect, it } from 'vitest';
import { InertRecordingManager } from '../../src/studio/inert-services.js';
import type { StartInput, StudioServices } from '../../src/studio/contracts.js';
import { recordRoutes } from '../../src/studio/routes/record.js';
import type { RouteContext } from '../../src/studio/routes/types.js';
import { LOAD_UNREADABLE, SAMPLE_MODE } from '../../src/studio/messages/common.js';
import { foreignOriginMessage } from '../../src/workflow/origin-guard.js';

class Spy extends InertRecordingManager {
  starts: StartInput[] = [];
  override start(input: StartInput) {
    this.starts.push(input);
    return { status: 202 as const };
  }
}
const held = { targetType: 'web', startUrl: 'https://shop.test/login', workflows: [{ id: 'w', toolName: 't', steps: [] }] };

const start = async (over: { set?: unknown; sample?: boolean; fail?: boolean }, url: string) => {
  const recording = new Spy();
  const ctx = {
    services: { recording } as unknown as StudioServices,
    sample: over.sample === true,
    workflowFile: 'C:\\private\\folder\\daemonize.workflows.json',
    loadSet: async () => {
      if (over.fail === true) throw new Error('unreadable');
      return { set: 'set' in over ? over.set : held, outputs: {} };
    },
  } as unknown as RouteContext;
  const route = recordRoutes(ctx).find((r) => r.path === '/api/record/start')!;
  const res = await route.handlers.POST!({ method: 'POST', query: new URLSearchParams(), body: { name: 'Find', url }, signal: new AbortController().signal });
  return { res, recording };
};

describe('record route: another origin is refused (Requirements 12.1, 12.2, 12.3, 12.11, 12.13)', () => {
  it('answers 409 with field url, the held origin, and starts nothing', async () => {
    const { res, recording } = await start({}, 'https://other.test/');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: foreignOriginMessage('https://shop.test'), field: 'url' });
    expect((res.body as { error: string }).error).toContain('https://shop.test');
    expect((res.body as { error: string }).error).toMatch(/another folder/);
    expect((res.body as { error: string }).error).not.toMatch(/[\\/]daemonize|private/);
    expect(recording.starts).toEqual([]);
  });

  it('treats the default port as the same address', async () => {
    expect((await start({}, 'https://shop.test:443/x')).res.status).toBe(202);
    expect((await start({}, 'https://shop.test:8443/x')).res.status).toBe(409);
    expect((await start({}, 'http://shop.test/x')).res.status).toBe(409);
  });

  it('answers the standard unreadable message when the file cannot be read', async () => {
    const { res, recording } = await start({ fail: true }, 'https://shop.test/');
    expect(res).toEqual({ status: 409, body: { error: LOAD_UNREADABLE, field: 'url' } });
    expect(recording.starts).toEqual([]);
  });

  it('in sample mode gives the same 409 for another origin and the sample-mode message otherwise', async () => {
    const other = await start({ sample: true }, 'https://other.test/');
    expect(other.res.status).toBe(409);
    expect((other.res.body as { field?: string }).field).toBe('url');
    const same = await start({ sample: true }, 'https://shop.test/x');
    expect(same.res).toEqual({ status: 409, body: { error: SAMPLE_MODE } });
    expect(same.recording.starts).toEqual([]);
  });
});
