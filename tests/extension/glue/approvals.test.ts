import { afterEach, describe, expect, it } from 'vitest';
import { __callsTo, __script } from '../fake-vscode';
import { createHarness, type Harness } from './harness';

const ID = 'ab'.repeat(16);
const pendingBody = { pending: [{ id: ID, tool: 'send_invoice', application: 'Billing', riskText: 'Changes data', arguments: { amount: 'ARGVALUE-1' }, writeSteps: [], secondsLeft: 90, kind: 'tool-call' }], serverTime: 'now' };

interface Calls { gets: string[]; posts: Array<{ path: string; body: Record<string, unknown> }> }

/** Replaces the session client with a scripted one and (re)starts the watcher by a state change. */
async function wire(harness: Harness, answers: { posts?: Record<string, { status: number; body: unknown }>; approvals?: unknown }): Promise<Calls> {
  const calls: Calls = { gets: [], posts: [] };
  const session = harness.manager.session as unknown as { client: unknown };
  session.client = {
    get: async (path: string) => {
      calls.gets.push(path);
      if (path.startsWith('/api/approvals')) return { status: 200, body: answers.approvals ?? { pending: [], serverTime: 'now' } };
      return { status: 200, body: { entries: [], tools: [], total: 0 } };
    },
    post: async (path: string, body: Record<string, unknown>) => {
      calls.posts.push({ path, body });
      return answers.posts?.[path] ?? { status: 200, body: { id: ID, decision: body.decision } };
    },
  };
  harness.manager.setState('stopped');
  harness.manager.setState('running');
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  return calls;
}

let active: Harness | undefined;
afterEach(async () => { await active?.handle.dispose(); active = undefined; });

describe('approvals in the extension', () => {
  it('shows one notification with Approve and Deny, without an argument value, and sends the answer', async () => {
    active = createHarness();
    __script({ 'window.showInformationMessage': [(m: string) => (m.startsWith('Kiro is asking') ? 'Approve' : undefined)] });
    const calls = await wire(active, { approvals: pendingBody });
    const asks = __callsTo('window.showInformationMessage').filter((a) => String(a[0]).startsWith('Kiro is asking'));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toEqual(['Kiro is asking to run "send_invoice". Billing · Changes data', 'Approve', 'Deny']);
    expect(JSON.stringify(asks)).not.toContain('ARGVALUE');
    expect(calls.posts).toEqual([{ path: '/api/approvals/decide', body: { id: ID, decision: 'approved' } }]);
  });

  it('the deny command posts a denial for the clicked row and reports an ended question', async () => {
    active = createHarness();
    const calls = await wire(active, { posts: { '/api/approvals/decide': { status: 404, body: { error: 'Ended' } } } });
    await active.run('daemonize.deny', { id: `approval:${ID}`, label: 'x', icon: 'warning' });
    expect(calls.posts).toEqual([{ path: '/api/approvals/decide', body: { id: ID, decision: 'denied' } }]);
    expect(__callsTo('window.showErrorMessage').map((a) => a[0])).toContain('This question has already ended.');
  });

  it('opens all activity in the browser at the activity route', async () => {
    active = createHarness();
    await active.run('daemonize.openActivity');
    const opened = __callsTo('env.openExternal');
    expect(opened).toHaveLength(1);
    expect(String(opened[0][0])).toContain('#/activity');
  });

  it('asks before turning "Ask before changes" off, and sends nothing when the user declines', async () => {
    let value = true;
    active = createHarness({
      powerInfo: async () => ({ ok: true, status: 200, data: { kiroHomeExists: true, installs: [{ scope: 'project', slug: 'app', kiroPath: '/p/.kiro', askBeforeChanges: value }], available: true } }),
    });
    const calls = await wire(active, { posts: { '/api/power/approval': { status: 200, body: { scope: 'project', askBeforeChanges: false } } } });
    const node = { id: 'install:project:app', label: 'app', icon: 'plug' };
    __script({ 'window.showWarningMessage': [undefined, 'Turn it off'] });
    await active.run('daemonize.toggleAskBeforeChanges', node);
    expect(calls.posts.filter((p) => p.path === '/api/power/approval')).toHaveLength(0);
    await active.run('daemonize.toggleAskBeforeChanges', node);
    expect(calls.posts.filter((p) => p.path === '/api/power/approval')).toEqual([{ path: '/api/power/approval', body: { scope: 'project', askBeforeChanges: false } }]);
    expect(__callsTo('window.showWarningMessage')[0][0]).toBe('Changes will run without a question. Turn it off?');
    value = false;
  });
});
