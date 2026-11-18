import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { Replayer } from '../../src/replayer/replayer.js';
import { PlaywrightDriver } from '../../src/sandbox/playwright-driver.js';
import type { ScreenContent } from '../../src/types.js';

const FORM_PAGE = `<!doctype html>
<html><head><title>New customer</title></head>
<body>
  <form action="/result" method="get">
    <label for="name">Customer name</label>
    <input id="name" name="name" />
    <label for="secret">Access code</label>
    <input id="secret" name="secret" type="password" />
    <label for="plan">Plan</label>
    <select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
    <button type="submit">Save</button>
  </form>
  <div id="promo-box" onclick="document.title = 'promo applied'" style="cursor: pointer"><span>Apply promo</span></div>
</body></html>`;

function resultPage(name: string, plan: string): string {
  return `<!doctype html>
<html><head><title>Customer saved</title></head>
<body><p>Customer ${name} created on plan ${plan}</p></body></html>`;
}

describe('LiveRecorder (record in a real browser, then replay)', () => {
  let httpServer: Server;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('content-type', 'text/html');
      res.end(
        url.pathname === '/result'
          ? resultPage(url.searchParams.get('name') ?? '', url.searchParams.get('plan') ?? '')
          : FORM_PAGE
      );
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;

    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined,
    });
  }, 60000);

  beforeEach(async () => {
    // One page per test: a page can only be attached to one LiveRecorder
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => httpServer?.close(() => done()));
  });

  async function settle(): Promise<void> {
    // Events travel from the page to Node asynchronously
    await page.waitForTimeout(150);
  }

  it('records what the user does, without the password value, and replays it with new values', async () => {
    const recorder = new WorkflowRecorder('Create customer');
    const live = new LiveRecorder(page, recorder);

    await page.goto(baseUrl);
    await live.attach();

    // The user fills the form and submits it
    await page.locator('#name').click();
    await page.keyboard.type('Ada');
    await page.locator('#secret').click(); // leaving the name field records it
    await page.keyboard.type('hunter2');
    await page.locator('#plan').focus(); // leaving the password field records it
    await page.locator('#plan').selectOption('pro');
    // exact: the recording panel has a "Finish and save" button too
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForURL('**/result*');
    await settle();

    expect(live.stepCount).toBe(4);

    live.markVariable(0, { name: 'name', description: 'Customer name' });
    // The password step carries a secret name and no value, so it cannot become a variable
    expect(() => live.markVariable(1, { name: 'access_code' })).toThrow(/no value/);
    live.markVariable(2, { name: 'plan' });

    const html = await page.content();
    const finalScreen: ScreenContent = { type: 'dom', raw: html, normalized: html, capturedAt: Date.now() };
    const workflow = recorder.finish(finalScreen);

    // Selectors: accessible role/name first, CSS last
    expect(workflow.steps[0]).toMatchObject({
      actionType: 'type',
      variable: 'name',
      selectors: ['role=textbox[name="Customer name"]', '#name', '[name="name"]', '#name'].filter(
        (s, i, all) => all.indexOf(s) === i
      ),
    });
    expect(workflow.steps[3].selectors[0]).toBe('role=button[name="Save"]');

    // The password is never stored
    expect(JSON.stringify(workflow)).not.toContain('hunter2');
    expect(workflow.steps[1]).toMatchObject({ actionType: 'type', secretRef: 'PASSWORD' });
    expect(workflow.steps[1]).not.toHaveProperty('value');
    expect(workflow.observedPayloads).toEqual([{ name: 'Ada', plan: 'pro' }]);

    // Replay the recorded workflow with other values
    const replayer = new Replayer(() => new PlaywrightDriver(baseUrl));
    const result = await replayer.replay(workflow, { name: 'Bob', plan: 'free' }, 20000);

    expect(result.success).toBe(true);
    expect(result.result?.title).toBe('Customer saved');
    expect(result.result?.text).toContain('Customer Bob created on plan free');
  }, 60000);

  it('records an Enter press after flushing the typed value', async () => {
    const recorder = new WorkflowRecorder('Submit with Enter');
    const live = new LiveRecorder(page, recorder);
    const steps: string[] = [];
    const original = live.handle.bind(live);
    live.handle = (event) => {
      steps.push(`${event.actionType}:${event.value ?? ''}`);
      return original(event);
    };

    await page.goto(baseUrl);
    await live.attach();

    await page.locator('#name').click();
    await page.keyboard.type('Eve');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/result*');
    await settle();

    expect(steps).toEqual(['type:Eve', 'keypress:Enter']);
  }, 30000);

  it('lets the user turn a typed value into a variable from the page', async () => {
    const recorder = new WorkflowRecorder('Create customer');
    const live = new LiveRecorder(page, recorder);

    await page.goto(baseUrl);
    await live.attach();

    await page.locator('#name').click();
    await page.keyboard.type('Ada');
    await page.locator('#secret').click(); // leaving the name field records it

    // The box suggests a name derived from the field label
    await page.locator('[data-daemonize-action=make-variable]').click();
    const nameInput = page.locator('[data-daemonize-action=variable-name]');
    await expect(nameInput.inputValue()).resolves.toBe('customer_name');

    // An invalid name is refused and explained
    await nameInput.fill('1 bad name');
    await nameInput.press('Enter');
    await expect(page.locator('[data-daemonize-ui]').textContent()).resolves.toContain('letters, digits');

    await nameInput.fill('customer_name');
    await nameInput.press('Enter');
    await expect(page.locator('[data-daemonize-ui]').textContent()).resolves.toContain('saved');

    const workflow = recorder.finish();
    expect(workflow.steps[0].variable).toBe('customer_name');
    expect(workflow.variables).toEqual([{ name: 'customer_name', description: 'Customer name' }]);
    expect(workflow.observedPayloads).toEqual([{ customer_name: 'Ada' }]);
    // Using the box did not record any step of its own
    expect(live.stepCount).toBe(1);
  }, 30000);

  it('records a click on a clickable element that has no role', async () => {
    const recorder = new WorkflowRecorder('Apply promo');
    const live = new LiveRecorder(page, recorder);

    await page.goto(baseUrl);
    await live.attach();

    await page.locator('#promo-box span').click();
    await settle();

    const [step] = recorder.finish().steps;
    expect(step.actionType).toBe('click');
    expect(step.selectors[0]).toBe('#promo-box');
    expect(step.selectors).toContain('text="Apply promo"');
  }, 30000);

  it('replaces the value of the last typed step, but not a variable, a secret or a step that is not last', async () => {
    const recorder = new WorkflowRecorder('Replace');
    const live = new LiveRecorder(page, recorder);
    const event = (value: string, replaces?: number) => ({
      actionType: 'type' as const,
      info: { role: 'textbox', name: 'Search', id: 'q', css: '#q' },
      value,
      label: 'type Search',
      ...(replaces === undefined ? {} : { replaces }),
    });

    expect(live.handle(event('ad'))).toBe(0);
    expect(live.handle(event('ada', 0))).toBe(0);
    expect(recorder.stepsSoFar()).toHaveLength(1);
    expect(recorder.stepsSoFar()[0].value).toBe('ada');

    // Once the value is a variable, typing again is a new step
    live.markVariable(0, { name: 'q' });
    expect(live.handle(event('adam', 0))).toBe(1);
    expect(recorder.stepsSoFar().map((s) => s.value)).toEqual(['ada', 'adam']);

    expect(() => recorder.replaceValue(0, 'x')).toThrow(/already the variable/);
    expect(() => recorder.replaceValue(9, 'x')).toThrow(/No step/);
    // A replacement that is not about the last step is a step of its own
    expect(live.handle(event('adamo', 0))).toBe(2);
  });

  it('ends once, whatever the reason, and describes its panel without any typed value', async () => {
    const recorder = new WorkflowRecorder('Panel state');
    const live = new LiveRecorder(page, recorder);
    expect(live.panelState()).toEqual({ steps: 0, last: [], collapsed: false, ending: false, studio: false });

    for (const label of ['type A', 'click B', 'click C', 'click D']) {
      live.handle({ actionType: 'click', info: { role: 'button', name: label, css: 'button' }, label });
    }
    live.handle({ actionType: 'type', info: { role: 'textbox', name: 'Email', css: '#e' }, value: 'secret-looking@x.io', label: 'type Email' });
    const state = live.panelState();
    expect(state.steps).toBe(5);
    expect(state.last).toEqual(['click C', 'click D', 'type Email']);
    expect(JSON.stringify(state)).not.toContain('secret-looking');

    let resolved: string | undefined;
    void live.ended.then((reason) => { resolved = reason; });
    live.requestEnd('api');
    live.requestEnd('panel');
    await live.ended;
    expect(resolved).toBe('api');
    expect(live.panelState().ending).toBe(true);
  });

  it('refuses to attach twice', async () => {
    const live = new LiveRecorder(page, new WorkflowRecorder('a'));
    await page.goto(baseUrl);
    await live.attach();

    await expect(live.attach()).rejects.toThrow(/already attached/);
    await expect(new LiveRecorder(page, new WorkflowRecorder('b')).attach()).rejects.toThrow(
      /already has a LiveRecorder/
    );
  }, 30000);
});
