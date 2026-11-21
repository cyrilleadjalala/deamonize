import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { InertActivityService, InertApprovalsService } from '../../src/studio/inert-services.js';
import { agentMayCall, AGENT_REFUSED } from '../../src/studio/agent-access.js';
import { rawRequest } from '../helpers/http.js';
import { removeDir } from '../helpers/cleanup.js';

describe('the agent principal on the approval and activity routes', () => {
  let dir: string | undefined;
  let handle: StudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    if (dir !== undefined) await removeDir(dir);
  });

  const start = async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-access-'));
    const decisions: string[] = [];
    handle = await startStudio({
      workflowFile: join(dir, 'none.json'),
      outDir: join(dir, 'out'),
      staticDir: join(dir, 'ui'),
      env: {},
      playground: false,
      services: {
        approvals: { start: async () => undefined, list: async () => new InertApprovalsService(true).list(), decide: async (_id: string, d: string) => (decisions.push(d), { ok: true as const, decision: d as 'approved' }), close: async () => undefined },
        activity: new InertActivityService(true),
      },
    });
    const h = handle;
    const call = (token: string, method: string, path: string, body?: string) =>
      rawRequest(h, method, path, { host: `127.0.0.1:${h.port}`, 'x-studio-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body);
    return { h, call, decisions };
  };

  it('gets 403 on decide and on the list of approvals, before any handler runs', async () => {
    const { h, call, decisions } = await start();
    const id = '0123456789abcdef0123456789abcdef';
    const decide = await call(h.agentToken, 'POST', '/api/approvals/decide', JSON.stringify({ id, decision: 'approved' }));
    expect(decide.status).toBe(403);
    expect(JSON.parse(decide.text).error).toBe(AGENT_REFUSED);
    expect((await call(h.agentToken, 'GET', '/api/approvals')).status).toBe(403);
    expect(decisions).toEqual([]);
  });

  it('lets the owner decide, and the agent read the activity', async () => {
    const { h, call, decisions } = await start();
    const id = '0123456789abcdef0123456789abcdef';
    const ok = await call(h.token, 'POST', '/api/approvals/decide', JSON.stringify({ id, decision: 'denied' }));
    expect(ok.status).toBe(200);
    expect(decisions).toEqual(['denied']);
    expect((await call(h.token, 'GET', '/api/approvals')).status).toBe(200);
    expect((await call(h.agentToken, 'GET', '/api/activity?limit=2')).status).toBe(200);
    // POST only
    expect((await call(h.token, 'GET', '/api/approvals/decide')).status).toBe(405);
  });

  it('keeps every approval, secret and install-removal route out of the agent list', () => {
    for (const [method, path] of [
      ['POST', '/api/approvals/decide'],
      ['GET', '/api/approvals'],
      ['POST', '/api/secrets'],
      ['POST', '/api/secrets/delete'],
      ['POST', '/api/power/approval'],
      ['POST', '/api/power/remove'],
      ['POST', '/api/power/daemonize/install'],
      ['POST', '/api/sessions/forget'],
      ['POST', '/api/power/auto-add'],
      ['POST', '/api/pbt/run'],
    ] as const) {
      expect(agentMayCall(method, path), `${method} ${path}`).toBe(false);
    }
    expect(agentMayCall('GET', '/api/activity')).toBe(true);
    expect(agentMayCall('HEAD', '/api/activity')).toBe(true);
  });
});
