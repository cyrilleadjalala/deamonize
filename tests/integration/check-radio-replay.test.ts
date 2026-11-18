import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { createWebRun, executeWebStep } from '../../src/replay/runtime/web-steps.js';
import { StepExecutionError, healEligible, type StepLike } from '../../src/replay/runtime/step-plan.js';

const PAGE = readFileSync(new URL('../fixtures/web/check-radio.html', import.meta.url));

describe('check and radio replay', () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let url: string;

  beforeAll(async () => {
    server = createServer((_, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  }, 60000);
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(url);
  });
  afterEach(async () => {
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    await new Promise<void>((done) => server?.close(() => done()));
  }, 30000);

  const run = (step: StepLike, variables: Record<string, unknown> = {}, timeoutMs = 1500) =>
    executeWebStep(createWebRun(page.context(), page), step, variables, { timeoutMs });
  const check = (name: string, role: string, value: string, variable?: string): StepLike => ({
    actionType: 'check',
    selectors: [],
    value,
    ...(variable === undefined ? {} : { variable }),
    anchor: { role, name },
  });
  const clicks = async () => Number(await page.locator('#count').textContent());

  it('checks, unchecks and sets switch and role checkbox controls', async () => {
    await run(check('Newsletter', 'checkbox', 'true'));
    expect(await page.locator('#news').isChecked()).toBe(true);
    await run(check('Terms', 'checkbox', 'false'));
    expect(await page.locator('#terms').isChecked()).toBe(false);
    await run(check('Dark mode', 'switch', 'true'));
    expect(await page.locator('#dark').getAttribute('aria-checked')).toBe('true');
    await run(check('Notify me', 'checkbox', 'true'));
    expect(await page.locator('#notify').getAttribute('aria-checked')).toBe('true');
  });

  it('uses the supplied Variable over the recorded value', async () => {
    await run(check('Newsletter', 'checkbox', 'false', 'news'), { news: true });
    expect(await page.locator('#news').isChecked()).toBe(true);
  });

  it('does not click a control that is already at the target', async () => {
    await run(check('Terms', 'checkbox', 'true'));
    expect(await clicks()).toBe(0);
  });

  it('fails when the control never reaches the state', async () => {
    await expect(run(check('Stuck', 'checkbox', 'true'), {}, 800)).rejects.toBeInstanceOf(StepExecutionError);
    expect(await clicks()).toBe(1);
  });

  it('fails on a disabled control without clicking', async () => {
    await expect(run(check('Locked', 'checkbox', 'true'), {}, 800)).rejects.toThrow(/disabled/);
    expect(await clicks()).toBe(0);
  });

  it('is not healed', () => {
    expect(healEligible(check('Newsletter', 'checkbox', 'true'), 'heal')).toBe(false);
  });

  it('chooses a radio by the name given by its Variable', async () => {
    const radio: StepLike = { actionType: 'click', selectors: [], variable: 'size', value: 'Small', anchor: { role: 'radio', name: 'Small' } };
    await run(radio, { size: 'Large' });
    expect(await page.locator('input[value=l]').isChecked()).toBe(true);
  });

  it('a radio already selected stays selected', async () => {
    const radio: StepLike = { actionType: 'click', selectors: [], variable: 'size', value: 'Small', anchor: { role: 'radio', name: 'Small' } };
    await run(radio, { size: 'Medium' });
    expect(await page.locator('input[value=m]').isChecked()).toBe(true);
  });

  it('a missing radio name fails without clicking another', async () => {
    const radio: StepLike = { actionType: 'click', selectors: ['#size-s'], variable: 'size', value: 'Small', anchor: { role: 'radio', name: 'Small' } };
    await expect(run(radio, { size: 'Huge' }, 600)).rejects.toBeInstanceOf(StepExecutionError);
    expect(await page.locator('input[value=m]').isChecked()).toBe(true);
    expect(await clicks()).toBe(0);
  });

  it('replays a radio variable scoped by a <fieldset><legend> for both heading and region scopes', async () => {
    await page.setContent(`
      <fieldset><legend>Size</legend>
        <label><input type="radio" name="size" value="s"> Small</label>
        <label><input type="radio" name="size" value="m" checked> Medium</label>
        <label><input type="radio" name="size" value="l"> Large</label>
      </fieldset>
      <fieldset><legend>Size B</legend>
        <label><input type="radio" name="size_b" value="l" checked> Large</label>
      </fieldset>
      <label><input type="radio" name="extra" value="s"> Small</label>
    `);
    const headingScoped: StepLike = {
      actionType: 'click',
      selectors: [],
      variable: 'size',
      value: 'Small',
      anchor: { role: 'radio', name: 'Small', parent: { kind: 'heading', name: 'Size' }, frame: [] },
    };
    await run(headingScoped, { size: 'Large' });
    expect(await page.locator('input[name=size][value=l]').isChecked()).toBe(true);

    const regionScoped: StepLike = {
      actionType: 'click',
      selectors: [],
      variable: 'size',
      value: 'Large',
      anchor: { role: 'radio', name: 'Large', parent: { kind: 'region', name: 'Size' }, frame: [] },
    };
    await run(regionScoped, { size: 'Small' });
    expect(await page.locator('input[name=size][value=s]').isChecked()).toBe(true);
  });

  it('replays a radio variable scoped by a <fieldset role="radiogroup"><legend>', async () => {
    await page.setContent(`
      <fieldset role="radiogroup"><legend>Plan</legend>
        <label><input type="radio" name="plan" value="Basic" checked> Basic</label>
        <label><input type="radio" name="plan" value="Pro"> Pro</label>
      </fieldset>
      <fieldset role="radiogroup"><legend>Backup</legend>
        <label><input type="radio" name="backup" value="Pro"> Pro</label>
      </fieldset>
    `);
    const step: StepLike = {
      actionType: 'click',
      selectors: [],
      variable: 'plan',
      value: 'Basic',
      anchor: { role: 'radio', name: 'Basic', parent: { kind: 'heading', name: 'Plan' }, frame: [] },
    };
    await run(step, { plan: 'Pro' });
    expect(await page.locator('input[name=plan][value=Pro]').isChecked()).toBe(true);
    expect(await page.locator('input[name=backup][value=Pro]').isChecked()).toBe(false);
  });
});
