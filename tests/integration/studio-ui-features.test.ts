import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 120000 });
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { removeDir } from '../helpers/cleanup.js';

// The first-flow screens against a live Studio with no workflow file. The recording, credentials and power routes are
// answered by Playwright route interception, so this file does not depend on the other groups' routes.

const json = (route: Route, status: number, body: unknown): Promise<void> => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

describe('Studio UI first-flow screens (real Chromium, stubbed feature routes)', () => {
  let dir: string;
  let studio: StudioHandle;
  let browser: Browser;
  let page: Page;
  let base: string;
  const requests: string[] = [];
  const cross: string[] = [];
  const csp: string[] = [];

  const open = async (hash: string): Promise<void> => {
    await page.goto('about:blank');
    await page.goto(`${base}/${hash}`);
    await page.waitForSelector('main h1, main h2', { state: 'visible' });
    await page.waitForFunction(() => document.querySelector('main[aria-busy]') === null);
  };
  const live = (): Promise<string> => page.locator('#live').textContent().then((t) => t ?? '');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'studio-ui-features-'));
    studio = await startStudio({ workflowFile: join(dir, 'missing.json'), outDir: join(dir, 'out'), env: {} });
    base = studio.url.replace(/\/\?token=.*$/, '');
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        (((window as unknown) as { __csp?: string[] }).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    page.on('request', (r) => {
      const url = new URL(r.url());
      requests.push(`${r.method()} ${url.pathname}`);
      if (url.origin !== new URL(base).origin && url.protocol.startsWith('http')) cross.push(r.url());
    });
    await page.goto(studio.url);
    await page.waitForSelector('main h1');
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    if (dir) await removeDir(dir);
  });

  it('shows the welcome screen with a new-action form that validates and cancels without a request', async () => {
    await open('#/');
    await expect.poll(() => page.locator('.welcome').count()).toBe(1);
    const startPosts: string[] = [];
    await page.route('**/api/record/start', (route) => {
      startPosts.push(route.request().postData() ?? '');
      return json(route, 400, { error: 'The name is not valid.', field: 'name' });
    });
    await page.getByRole('button', { name: '+ New action' }).click();
    // Each control has a visible label that names it
    for (const label of ['What should this action be called?', 'Web address where the task starts', 'Reuse my signed-in session']) {
      expect(await page.getByLabel(label).count(), label).toBe(1);
    }
    expect(await page.locator('#action-name').evaluate((el) => el === document.activeElement)).toBe(true);

    // Empty submit: both fields invalid, focus on the first, no request
    await page.getByRole('button', { name: 'Start recording' }).click();
    expect(await page.locator('#action-name').getAttribute('aria-invalid')).toBe('true');
    expect(await page.locator('#action-url').getAttribute('aria-invalid')).toBe('true');
    expect(await page.locator('#action-name').getAttribute('aria-describedby')).toContain('action-name-error');
    expect(await page.locator('#action-name').evaluate((el) => el === document.activeElement)).toBe(true);
    expect((await page.locator('#action-name-error').textContent()) ?? '').not.toBe('');
    expect(startPosts).toEqual([]);

    // A valid name with a bad address focuses the address and keeps the name
    await page.locator('#action-name').fill('  Search customers  ');
    await page.locator('#action-url').fill('http://user:pw@example.com/');
    await page.getByRole('button', { name: 'Start recording' }).click();
    expect(await page.locator('#action-url').evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.locator('#action-name').inputValue()).toBe('  Search customers  ');
    expect(startPosts).toEqual([]);

    // A server error about one field keeps the values and shows an alert on that field
    await page.locator('#action-url').fill('https://example.com/login');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect.poll(() => startPosts.length).toBe(1);
    expect(JSON.parse(startPosts[0])).toEqual({ name: 'Search customers', url: 'https://example.com/login', reuseSession: false });
    await expect.poll(() => page.locator('#action-name').getAttribute('aria-invalid')).toBe('true');
    expect(await page.locator('#action-url').inputValue()).toBe('https://example.com/login');

    // Cancel closes the form, sends nothing and returns focus to the button
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.locator('#new-action-form').count()).toBe(0);
    expect(await page.locator('#new-action-btn').evaluate((el) => el === document.activeElement)).toBe(true);
    expect(startPosts).toHaveLength(1);
    await page.unroute('**/api/record/start');
  });

  it('looks up a saved session by the origin only, then starts and follows the recording', async () => {
    await open('#/');
    const keys: string[] = [];
    await page.route('**/api/sessions?**', (route) => {
      keys.push(new URL(route.request().url()).searchParams.get('key') ?? '');
      return json(route, 200, { applicationKey: 'https://example.com', available: true });
    });
    let polls = 0;
    await page.route('**/api/record/start', (route) => json(route, 202, { state: 'recording' }));
    await page.route('**/api/record/status', (route) => {
      polls++;
      if (polls < 3) return json(route, 200, { state: 'recording', steps: polls, labels: ['Open the page', 'Click Sign in'] });
      return json(route, 200, { state: 'done', steps: 3, labels: ['Open the page', 'Click Sign in', 'Click Save'] });
    });
    await page.route('**/api/compile/status', (route) => json(route, 200, { state: 'done', phase: null }));
    await page.route('**/api/power/info', (route) => json(route, 200, { available: true, defaultWorkspace: '/work/project', outputPath: '/work/out', serverName: 'demo' }));
    await page.route('**/api/power/snippet', (route) => json(route, 200, { snippet: '{"mcpServers":{}}' }));

    await page.getByRole('button', { name: '+ New action' }).click();
    await page.locator('#action-name').fill('Search customers');
    await page.locator('#action-url').fill('https://example.com/some/path?q=1');
    await expect.poll(() => keys).toEqual(['https://example.com']);
    await expect.poll(() => page.locator('#reuse-hint').textContent()).toContain('saved for this site');
    await page.getByLabel('Reuse my signed-in session').check();
    await page.getByRole('button', { name: 'Start recording' }).click();

    await page.waitForFunction(() => location.hash === '#/record');
    await expect.poll(() => page.locator('#record-state').textContent()).toContain('Recording');
    expect(await page.getByRole('button', { name: 'Finish and save' }).count()).toBe(1);
    // The final state: the Test it link, the connect card, polling stops
    await expect.poll(() => page.locator('#test-it').count(), { timeout: 15000 }).toBe(1);
    await expect.poll(() => page.locator('#record-state').textContent()).toContain('Done');
    expect(await page.getByRole('button', { name: 'Finish and save' }).count()).toBe(0);
    await expect.poll(live).toContain('Your tool is ready');
    await expect.poll(() => page.locator('#connect-btn').count()).toBe(1);
    const seen = polls;
    await page.waitForTimeout(2200);
    expect(polls).toBe(seen);
    await page.unroute('**/api/sessions?**');
    await page.unroute('**/api/record/start');
    await page.unroute('**/api/record/status');
  });

  it('shows a connection lost notice and keeps the last values when a poll fails', async () => {
    let calls = 0;
    await page.route('**/api/record/status', (route) => {
      calls++;
      if (calls === 1) return json(route, 200, { state: 'recording', steps: 2, labels: ['Open the page'] });
      if (calls === 2) return route.abort();
      return json(route, 200, { state: 'error', steps: 2, labels: ['Open the page'], error: 'Nothing was saved.', recoveryFile: 'x.recovery.json' });
    });
    await open('#/record');
    await expect.poll(() => page.locator('#connection-lost').isVisible(), { timeout: 8000 }).toBe(true);
    expect(await page.locator('#record-steps').textContent()).toContain('2 steps');
    await expect.poll(() => page.locator('.state.error').count(), { timeout: 15000 }).toBe(1);
    expect(await page.locator('.state.error code.path').textContent()).toBe('x.recovery.json');
    expect(await page.locator('#connection-lost').isVisible()).toBe(false);
    await page.unroute('**/api/record/status');
  });

  it('saves and removes a credential with the keyboard, clearing the input and keeping the value out of the page', async () => {
    const secret = 'zz-test-value-9876';
    const configured = new Set<string>();
    const bodies: string[] = [];
    await page.route('**/api/secrets', async (route) => {
      if (route.request().method() === 'GET') {
        return json(route, 200, {
          secrets: [
            { name: 'CRM_PASSWORD', kind: 'password', configured: configured.has('CRM_PASSWORD') },
            { name: 'CRM_TOTP', kind: 'totp', configured: false },
          ],
        });
      }
      const body = JSON.parse(route.request().postData() ?? '{}');
      bodies.push(route.request().postData() ?? '');
      if (body.value === 'bad') return json(route, 400, { error: 'invalid' });
      configured.add(body.name);
      return json(route, 200, { name: body.name, configured: true });
    });
    await page.route('**/api/secrets/forget', (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      configured.delete(body.name);
      return json(route, 200, { name: body.name, configured: false });
    });
    await open('#/credentials');
    const row = page.locator('li[data-secret="CRM_PASSWORD"]');
    expect(await row.locator('.secret-name').textContent()).toBe('Crm password');
    expect(await row.textContent()).toContain('Password');
    expect(await row.textContent()).toContain('Missing');
    expect(await page.locator('li[data-secret="CRM_TOTP"]').textContent()).toContain('Authenticator key');
    expect(await page.locator('li[data-secret="CRM_TOTP"] input').getAttribute('aria-describedby')).toContain('secret-help');
    const input = row.locator('input');
    expect(await input.getAttribute('type')).toBe('password');
    expect(await input.getAttribute('autocomplete')).toBe('off');
    expect(await page.getByLabel('Value for Crm password').count()).toBe(1);
    const save = row.getByRole('button', { name: 'Save Crm password' });
    expect(await save.isDisabled()).toBe(true);

    // A refused value: the input is cleared, the error is an alert without the value
    await input.fill('bad');
    await input.press('Tab');
    await save.press('Enter');
    await expect.poll(() => row.locator('.error-text').textContent()).toContain('Not saved.');
    expect(await input.inputValue()).toBe('');
    expect(await row.locator('.error-text').textContent()).not.toContain('bad');

    await input.fill(secret);
    await save.click();
    await expect.poll(() => row.textContent()).toContain('Configured');
    expect(await input.inputValue()).toBe('');
    await expect.poll(live).toContain('Crm password saved');
    expect(await page.content()).not.toContain(secret);
    expect(page.url()).not.toContain(secret);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie]))).not.toContain(secret);
    expect(bodies.some((b) => b.includes(secret))).toBe(true);

    await row.getByRole('button', { name: 'Remove Crm password' }).click();
    await expect.poll(() => row.textContent()).toContain('Missing');
    expect(await row.getByRole('button', { name: 'Remove Crm password' }).count()).toBe(0);
    await page.unroute('**/api/secrets');
    await page.unroute('**/api/secrets/forget');
  });

  it('shows "No credentials needed" and a Retry button when the list fails', async () => {
    await page.route('**/api/secrets', (route) => json(route, 200, { secrets: [] }));
    await open('#/credentials');
    expect(await page.locator('#no-credentials').textContent()).toBe('No credentials needed');
    expect(await page.locator('main input').count()).toBe(0);
    await page.unroute('**/api/secrets');
    let fail = true;
    await page.route('**/api/secrets', (route) => (fail ? json(route, 500, { error: 'boom' }) : json(route, 200, { secrets: [] })));
    await open('#/credentials');
    expect(await page.locator('.state.error[role="alert"]').count()).toBe(1);
    fail = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => page.locator('#no-credentials').count()).toBe(1);
    await page.unroute('**/api/secrets');
  });

  it('opens the connect dialog with a focus trap, closes on Escape and returns focus', async () => {
    const posts: string[] = [];
    await page.route('**/api/power/info', (route) => json(route, 200, { available: true, defaultWorkspace: '/work/project', outputPath: '/work/out', serverName: 'demo' }));
    await page.route('**/api/power/snippet', (route) => json(route, 200, { snippet: '{"mcpServers":{}}' }));
    await page.route('**/api/power/preview', (route) =>
      json(route, 200, {
        confirmationId: 'id-1',
        kiroPath: '/work/project/.kiro',
        files: [
          { path: 'settings/mcp.json', outcome: 'merge' },
          { path: 'skills/demo/SKILL.md', outcome: 'create' },
        ],
        replacesEntry: true,
        serverName: 'demo',
        placeholders: ['DAEMONIZE_SECRET_CRM_PASSWORD'],
      })
    );
    await page.route('**/api/power/install', (route) => {
      posts.push(route.request().postData() ?? '');
      return json(route, 200, { written: ['settings/mcp.json', 'skills/demo/SKILL.md'], placeholders: ['DAEMONIZE_SECRET_CRM_PASSWORD'] });
    });
    // The connect card shows on the overview once the output is compiled
    await page.route('**/api/overview', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, outputCompiled: true } });
    });
    await page.route('**/api/workflows', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, workflows: [] } });
    });
    await open('#/');
    // No actions: the welcome screen. Open the card through the record screen instead.
    await page.route('**/api/record/status', (route) => json(route, 200, { state: 'done', steps: 1, labels: [] }));
    await open('#/record');
    await expect.poll(() => page.locator('#connect-btn').count()).toBe(1);
    const connect = page.locator('#connect-btn');
    expect(await page.getByLabel('Folder of your Kiro project').inputValue()).toBe('/work/project');
    await connect.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator('[role="dialog"]');
    await expect.poll(() => dialog.count()).toBe(1);
    expect(await dialog.getAttribute('aria-modal')).toBe('true');
    expect(await dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(await dialog.textContent()).toContain('/work/project/.kiro');
    expect(await dialog.textContent()).toContain('merge');
    expect(await dialog.textContent()).toContain('will be replaced');
    expect(await page.locator('main').getAttribute('inert')).not.toBeNull();
    // Focus starts on the first control and wraps both ways
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('connect-confirm');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('connect-cancel');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('connect-confirm');
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('connect-cancel');
    // Escape closes without an install request and puts focus back
    await page.keyboard.press('Escape');
    expect(await dialog.count()).toBe(0);
    expect(posts).toEqual([]);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('connect-btn');
    expect(await page.locator('main').getAttribute('inert')).toBeNull();

    // Confirm: one install request with the id and the exact path, then the success screen
    await connect.click();
    await page.locator('#connect-confirm').click();
    await expect.poll(() => posts.length).toBe(1);
    expect(JSON.parse(posts[0])).toEqual({ confirmationId: 'id-1', kiroPath: '/work/project/.kiro' });
    await expect.poll(() => dialog.textContent()).toContain('DAEMONIZE_SECRET_CRM_PASSWORD');
    await page.locator('#connect-close').click();
    expect(await dialog.count()).toBe(0);
    // "Add as a Kiro Power instead" shows the folder and writes nothing
    await page.getByRole('button', { name: 'Add as a Kiro Power instead' }).click();
    expect(await page.locator('#connect-power code.path').textContent()).toBe('/work/out');
    expect(posts).toHaveLength(1);
    for (const p of ['**/api/power/**', '**/api/overview', '**/api/workflows', '**/api/record/status']) await page.unroute(p);
  });

  it('uses no inline style, no cross-origin request and no CSP violation on the new screens', async () => {
    await open('#/credentials');
    expect(await page.locator('main [style]').count()).toBe(0);
    expect(cross).toEqual([]);
    expect(await page.evaluate(() => ((window as unknown) as { __csp?: string[] }).__csp ?? [])).toEqual(csp);
    expect(requests.length).toBeGreaterThan(5);
  });
});

