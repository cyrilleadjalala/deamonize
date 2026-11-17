import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { waitForEffect, type SettlePage } from '../../src/replay/runtime/settle.js';

// Feature: nextjs-spa-replay-fixes, Property 1: Bug Condition - Wait covers slow requests, SPA navigation and hydration
// A "link" whose click fetches an RSC-like payload that takes about 3 s (more than LONG_LIVED_MS), then
// calls history.pushState and renders a new screen, like the Next.js App Router does.
const PAGE = `<!doctype html>
<html><head><title>Home</title></head><body>
<main id="root"><h1>Home</h1><button id="go">Clients</button></main>
<script>
document.getElementById('go').onclick = async () => {
  const r = await fetch('/slow-rsc?_rsc=1');
  const text = await r.text();
  await new Promise((resolve) => setTimeout(resolve, 80));
  history.pushState({}, '', '/clients');
  document.getElementById('root').innerHTML = '<h1 id="clients">' + text + '</h1>';
};
</script></body></html>`;

describe('waitForEffect on a slow SPA navigation', () => {
  let server: Server;
  let baseUrl: string;
  let browser: Browser;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/slow-rsc') {
        setTimeout(() => {
          res.setHeader('content-type', 'text/plain');
          res.end('Clients screen');
        }, 3000);
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined,
    });
  });

  afterAll(async () => {
    await browser?.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((done) => server?.close(() => done()));
  });

  it('returns only after the new screen is rendered, within the bound', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl + '/');

    const started = Date.now();
    const reason = await waitForEffect(page as unknown as SettlePage, {
      timeoutMs: 8000,
      action: () => page.click('#go'),
    });
    const elapsed = Date.now() - started;

    // The heading must exist right now, without any locator wait
    expect(await page.locator('#clients').count()).toBe(1);
    expect(page.url()).toContain('/clients');
    expect(reason).not.toBe('bound');
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(7500);
    await page.context().close();
  });
});
