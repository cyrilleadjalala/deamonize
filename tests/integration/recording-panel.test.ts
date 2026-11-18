import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { record } from '../../src/cli/commands/record.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';

// A fake single page app: /connexion has an email field, /clients a live search (filters on `input`, no Enter, no blur)
const SPA = `<!doctype html>
<html><head><title>App</title></head>
<body>
<nav><a href="/clients" id="to-clients">Clients</a> <button id="to-login" type="button">Back to login</button></nav>
<div id="view"></div>
<script>
  function render() {
    const view = document.getElementById('view');
    if (location.pathname === '/clients') {
      view.innerHTML = '<label for="search">Search clients</label><input id="search" type="search" autocomplete="off" />' +
        '<ul id="list"><li>Ada Lovelace</li><li>Bob</li></ul>';
      document.getElementById('search').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        document.querySelectorAll('#list li').forEach((li) => { li.hidden = !li.textContent.toLowerCase().includes(q); });
      });
    } else {
      view.innerHTML = '<label for="email">Email</label><input id="email" type="text" />' +
        '<label for="long">Name of the customer account that is long</label><input id="long" type="text" />';
    }
  }
  document.getElementById('to-clients').addEventListener('click', (e) => { e.preventDefault(); history.pushState({}, '', '/clients'); render(); });
  document.getElementById('to-login').addEventListener('click', () => { history.pushState({}, '', '/connexion'); render(); });
  window.addEventListener('popstate', render);
  render();
</script>
</body></html>`;

describe('recording panel, offer, live flush and finish binding (fake SPA)', () => {
  let httpServer: Server;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;
  let dir: string;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(SPA);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
    dir = await mkdtemp(join(tmpdir(), 'daemonize-panel-'));
  }, 60000);

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => httpServer?.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });

  async function attach(): Promise<{ live: LiveRecorder; recorder: WorkflowRecorder }> {
    const recorder = new WorkflowRecorder('Panel');
    const live = new LiveRecorder(page, recorder);
    await page.goto(`${baseUrl}/connexion`);
    await live.attach();
    return { live, recorder };
  }

  const panel = (): ReturnType<Page['locator']> => page.locator('[data-daemonize-panel]');
  const panelText = async (): Promise<string> => (await panel().textContent().catch(() => '')) ?? '';

  async function expectPanel(): Promise<void> {
    await expect.poll(() => panel().count()).toBe(1);
    await expect.poll(() => page.locator('[data-daemonize-ui]').count()).toBe(1);
    const text = (await panel().textContent()) ?? '';
    expect(text).toContain('Recording');
    expect(text).toContain('Choose the result to capture');
    expect(text).toContain('Finish and save');
    expect(text).toMatch(/\d+ steps?/);
  }

  it('shows one panel with the indicator, the counter and the two buttons, and keeps it across route changes', async () => {
    await attach();
    await expectPanel();

    await page.evaluate(() => history.pushState({}, '', '/clients'));
    await expectPanel();
    await page.goBack();
    await expectPanel();
    // A framework replacing the body does not remove it (the panel is a child of <html>)
    await page.evaluate(() => document.body.replaceWith(document.createElement('body')));
    await expectPanel();
    // A rewritten document gets a new panel
    await page.setContent('<html><body><p>rewritten</p></body></html>');
    await expect.poll(() => panel().count()).toBe(1);
    // A full navigation
    await page.goto(`${baseUrl}/clients`);
    await expectPanel();
  });

  it('clears the offer of the email typed on /connexion once the route is /clients', async () => {
    await attach();
    await page.locator('#email').click();
    await page.keyboard.type('ada@example.com');
    await page.locator('#long').click(); // leaving the field records it
    const offer = page.getByRole('button', { name: 'Make variable' });
    await expect.poll(() => offer.count()).toBe(1);
    await expect.poll(panelText).toContain('Field: Email');

    await page.locator('#to-clients').click();
    await page.waitForURL(/\/clients$/);
    await expect.poll(() => offer.count()).toBe(0);
  });

  it('shows a long suggested name in full, keeps the result button after "Make variable", and offers the field again for another route', async () => {
    const { live, recorder } = await attach();
    await page.locator('#long').click();
    await page.keyboard.type('Acme');
    await page.locator('#email').click();
    await page.getByRole('button', { name: 'Make variable' }).click();
    const input = page.locator('[data-daemonize-action=variable-name]');
    const suggestion = await input.inputValue();
    expect(suggestion.length).toBeGreaterThanOrEqual(30);
    const fits = await input.evaluate((el: HTMLInputElement) => el.scrollWidth <= el.clientWidth);
    expect(fits).toBe(true);

    await input.press('Enter');
    await expect.poll(panelText).toContain('saved');
    // The panel is still there with the result button
    const choose = page.locator('[data-daemonize-action=mark-result]');
    await choose.waitFor();
    expect(await choose.isEnabled()).toBe(true);
    await choose.click();
    await expect.poll(panelText).toContain('Click the element that holds the result');
    await page.locator('[data-daemonize-action=cancel-mark-result]').click();
    await page.locator('[data-daemonize-action=mark-result]').waitFor();

    expect(recorder.finish().variables).toHaveLength(1);
    expect(live.stepCount).toBe(1);
  });

  it('records a live search 600 ms after the last key, and updates the same step on the next pause', async () => {
    const { live, recorder } = await attach();
    await page.locator('#to-clients').click();
    await page.locator('#search').click();
    await page.keyboard.type('ada');
    // Not yet: the field is not left and the quiet time is not over
    await page.waitForTimeout(150);
    expect(live.stepCount).toBe(1); // only the click on the link

    await expect.poll(() => live.stepCount, { timeout: 3000 }).toBe(2);
    expect(recorder.stepsSoFar()[1]).toMatchObject({ actionType: 'type', value: 'ada' });
    await expect.poll(panelText).toContain('Field: Search clients');

    await page.keyboard.type('m');
    await expect.poll(() => recorder.stepsSoFar()[1]?.value, { timeout: 3000 }).toBe('adam');
    await page.locator('#to-login').focus(); // leaving the field must not add a step
    await page.waitForTimeout(300);
    expect(live.stepCount).toBe(2);
  });

  it('ends record() through __daemonizeFinish while the page is open, with the result zone checked', async () => {
    const out = join(dir, 'finish.workflows.json');
    let openAtEnd: boolean | undefined;
    const summary = await record({
      url: `${baseUrl}/clients`,
      name: 'app',
      label: 'search',
      out,
      headless: true,
      visual: false,
      captureNetwork: false,
      drive: async (p, live) => {
        await p.locator('#search').click();
        await p.keyboard.type('ada');
        await p.locator('[data-daemonize-action=mark-result]').click();
        await p.locator('#list').click();
        await p.locator('[data-daemonize-action=result-kind]').waitFor();
        const original = live.finalizeNetwork.bind(live);
        live.finalizeNetwork = async () => {
          openAtEnd = !p.isClosed();
          return original();
        };
        await p.getByRole('button', { name: 'Finish and save' }).click();
        // The session must end by itself: drive never returns
        await new Promise<never>(() => { });
      },
    });
    expect(openAtEnd).toBe(true);
    expect(summary.steps).toBe(1);
    expect(summary.resultZone?.kind).toBe('list');
    const set = deserializeWorkflowSet(await readFile(out, 'utf-8'));
    expect(set.workflows[0].resultZone?.schema).toBeDefined();
    expect(set.workflows[0].steps.map((s) => s.actionType)).toEqual(['type']);
  });

  it('picks the result in the page: an outline and the guessed kind follow the pointer, then six tabs correct the kind', async () => {
    const { live } = await attach();
    await page.locator('#to-clients').click();
    await page.locator('[data-daemonize-action=mark-result]').click();
    // The banner says what to do and the phase bar moves to "Choose the result"
    await expect.poll(() => page.locator('[data-daemonize-action=mark-banner]').isVisible()).toBe(true);
    await expect.poll(panelText).toContain('2 · Choose the result');
    // Hovering the list outlines it and names the kind that would be chosen
    await page.locator('#list li').first().hover();
    await expect.poll(panelText).toContain('list');
    await expect.poll(() => page.locator('[data-daemonize-ui] div[style*="pointer-events: none"]').first().isVisible()).toBe(true);
    await page.locator('#list li').first().click();

    const group = page.locator('[data-daemonize-action=result-kind]');
    await group.waitFor();
    expect(await group.getAttribute('role')).toBe('group');
    expect(await group.locator('button').count()).toBe(6);
    await expect.poll(() => page.locator('[data-daemonize-action=result-kind-list]').getAttribute('aria-pressed')).toBe('true');
    // The click that chose the result is not a step; the kind can be corrected with one click
    await page.locator('[data-daemonize-action=result-kind-json]').click();
    await expect.poll(() => page.locator('[data-daemonize-action=result-kind-json]').getAttribute('aria-pressed')).toBe('true');
    await expect.poll(() => live.panelState().zone?.kind).toBe('json');
  });

  it('collapses into a bubble that keeps the count, and opens again', async () => {
    await attach();
    await page.locator('#long').click();
    await page.keyboard.type('Acme');
    await page.locator('#email').click();
    await page.locator('[data-daemonize-action=toggle-panel]').click();
    const bubble = page.locator('[data-daemonize-action=expand-panel]');
    await expect.poll(() => bubble.isVisible()).toBe(true);
    expect(await page.locator('[data-daemonize-action=finish]').isVisible()).toBe(false);
    expect(await bubble.getAttribute('aria-label')).toMatch(/Expand the recorder panel \(\d+ steps?\)/);
    await bubble.click();
    await expect.poll(() => page.locator('[data-daemonize-action=finish]').isVisible()).toBe(true);
  });

  it('writes the recorded steps as a journal with an icon for each', async () => {
    await attach();
    await page.locator('#long').click();
    await page.keyboard.type('Acme');
    await page.locator('#email').click();
    const rows = page.locator('[data-daemonize-action=last-steps] li');
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().locator('svg').count()).toBe(1);
    expect(await rows.first().textContent()).toMatch(/^type/);
  });

  it('in a Studio recording, "Finish and save" opens the end sheet and the next step chosen there reaches Node', async () => {
    const recorder = new WorkflowRecorder('Sheet');
    const live = new LiveRecorder(page, recorder, { studio: true });
    await page.goto(`${baseUrl}/clients`);
    await live.attach();
    await page.locator('#search').click();
    await page.keyboard.type('ada');
    await page.locator('#to-login').focus();
    await expect.poll(() => live.stepCount, { timeout: 3000 }).toBe(1);

    await page.getByRole('button', { name: 'Finish and save' }).click();
    const sheet = page.locator('[data-daemonize-action=finish-sheet]');
    await expect.poll(() => sheet.isVisible()).toBe(true);
    await expect.poll(panelText).toContain('Your tool is ready');
    await expect.poll(panelText).toContain('3 · Save the tool');
    expect(live.stepCount).toBe(1); // nothing is saved yet
    // Back returns to the panel; the session is still open
    await page.locator('[data-daemonize-action=sheet-back]').click();
    await expect.poll(() => sheet.isVisible()).toBe(false);

    await page.getByRole('button', { name: 'Finish and save' }).click();
    await page.getByRole('button', { name: 'Save and add to Kiro' }).click();
    expect(await live.ended).toBe('panel');
    expect(live.finishIntent).toBe('kiro');
  });

  it('keeps the panel out of the screen hash', async () => {
    await attach();
    const { screenId } = await import('../../src/state/screen-hasher.js').then((m) => ({ screenId: (raw: string) => new m.ScreenHasher().computeId({ type: 'dom', raw, normalized: raw, capturedAt: 0 }) }));
    const withPanel = screenId(await page.content());
    await page.evaluate(() => document.querySelector('[data-daemonize-panel]')?.remove());
    const without = screenId(await page.content());
    expect(withPanel).toBe(without);
  });
});
