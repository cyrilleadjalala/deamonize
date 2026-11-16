/**
 * Smoke test of the real target of the web example (Adminer on PostgreSQL, started with Docker Compose).
 * It only checks that the target works; recording and calling it is another test.
 *
 *   DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/adminer-stack.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { adminerSkipReason, startAdminerStack, type AdminerStack } from '../helpers/adminer-stack.js';

const skip = adminerSkipReason();
if (skip) console.warn(skip);

describe.skipIf(skip !== null)('Adminer + PostgreSQL example stack', () => {
  let stack: AdminerStack | null = null;
  let browser: Browser | undefined;

  beforeAll(async () => {
    stack = await startAdminerStack();
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await stack?.stop();
  }, 120_000);

  it('serves a login form with the expected fields', async () => {
    const html = await (await fetch(stack!.url)).text();
    for (const name of ['auth[driver]', 'auth[server]', 'auth[username]', 'auth[password]', 'auth[db]']) {
      // Adminer mixes single and double quotes in its markup
      expect(html).toMatch(new RegExp(`name=["']${name.replace(/[[\]]/g, '\\$&')}["']`));
    }
  });

  it('logs in with the demo credentials and shows the customers table', async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(stack!.url);
      await page.selectOption('select[name="auth[driver]"]', 'pgsql');
      await page.fill('input[name="auth[server]"]', stack!.server);
      await page.fill('input[name="auth[username]"]', stack!.user);
      await page.fill('input[name="auth[password]"]', stack!.password);
      await page.fill('input[name="auth[db]"]', stack!.database);
      await Promise.all([page.waitForLoadState('load'), page.click('input[type="submit"]')]);
      await expect(page.locator('a', { hasText: 'customers' }).first().isVisible()).resolves.toBe(true);
      await page.goto(`${stack!.url}?pgsql=${stack!.server}&username=${stack!.user}&db=${stack!.database}&select=customers`);
      expect(await page.locator('table.nowrap tbody tr').count()).toBeGreaterThanOrEqual(25);
    } finally {
      await page.close();
    }
  }, 60_000);
});
