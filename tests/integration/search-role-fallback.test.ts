import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { createWebRun, executeWebStep } from '../../src/replay/runtime/web-steps.js';
import type { StepLike } from '../../src/replay/runtime/step-plan.js';

function renderPage(alreadyHydrated: boolean): string {
  const headerInput = alreadyHydrated
    ? `<input class="cdx-input" role="combobox" aria-autocomplete="list" name="search" aria-label="Rechercher sur Wikipédia" />`
    : `<input id="searchInput" type="search" name="search" aria-label="Rechercher sur Wikipédia" />`;

  return `<!doctype html>
<html lang="fr">
  <meta charset="utf-8">
  <body>
    <form id="searchform">
      ${headerInput}
      <button type="submit">Rechercher</button>
    </form>
    <form id="footerform">
      <!-- Duplicate name="search" makes [name="search"] ambiguous in strict replay (2 elements). -->
      <input type="search" name="search" aria-label="Recherche secondaire" />
    </form>
    <div id="result" data-clicks="0"></div>
    <script>
      const form = document.getElementById('searchform');
      const result = document.getElementById('result');
      let clicks = 0;

      function attachSubmit(input) {
        input.addEventListener('click', () => {
          clicks += 1;
          result.dataset.clicks = String(clicks);
        });
      }

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const current = form.querySelector('input[name="search"]');
        result.textContent = 'submitted:' + (current ? current.value : '');
      });

      const initial = document.getElementById('searchInput');
      if (initial) {
        attachSubmit(initial);
        initial.addEventListener('input', () => {
          // Mimic Codex TypeaheadSearch: remove #searchInput and mount role="combobox" instead.
          const upgraded = document.createElement('input');
          upgraded.className = 'cdx-input';
          upgraded.setAttribute('role', 'combobox');
          upgraded.setAttribute('aria-autocomplete', 'list');
          upgraded.name = 'search';
          upgraded.setAttribute('aria-label', 'Rechercher sur Wikipédia');
          upgraded.value = initial.value;
          initial.replaceWith(upgraded);
          upgraded.focus();
          attachSubmit(upgraded);
        }, { once: true });
      } else {
        attachSubmit(form.querySelector('input[name="search"]'));
      }
    </script>
  </body>
</html>`;
}

describe('searchbox <-> combobox role fallback replay', () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(renderPage(req.url === '/hydrated'));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  }, 60000);

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    await new Promise<void>((done) => server?.close(() => done()));
  }, 30000);

  const runStep = (step: StepLike, variables: Record<string, unknown> = {}) =>
    executeWebStep(createWebRun(page.context(), page), step, variables, { timeoutMs: 2500 });

  it('replays a post-hydration combobox type step on a searchbox and a pre-hydration searchbox Enter keypress on the hydrated combobox', async () => {
    await page.goto(`${baseUrl}/`);

    const typeStep: StepLike = {
      actionType: 'type',
      risk: 'write',
      variable: 'query',
      value: 'Ada Lovelace',
      // Recorded after Vue hydrated: no #searchInput, [name="search"] is ambiguous (count 2).
      selectors: ['role=combobox[name="Rechercher sur Wikipédia"]', '[name="search"]', 'form#searchform > input.cdx-input'],
      anchor: { role: 'combobox', name: 'Rechercher sur Wikipédia', frame: [] },
    };

    const enterStep: StepLike = {
      actionType: 'keypress',
      value: 'Enter',
      // Recorded before hydration: #searchInput and searchbox were removed once input fired.
      selectors: ['role=searchbox[name="Rechercher sur Wikipédia"]', '#searchInput', '[name="search"]'],
      anchor: { role: 'searchbox', name: 'Rechercher sur Wikipédia', frame: [] },
    };

    await runStep(typeStep, { query: 'Intelligence artificielle' });
    // Input triggered hydration to combobox while preserving accessible name.
    expect(await page.getByRole('combobox', { name: 'Rechercher sur Wikipédia', exact: true }).count()).toBe(1);
    expect(await page.getByRole('searchbox', { name: 'Rechercher sur Wikipédia', exact: true }).count()).toBe(0);

    await runStep(enterStep);
    expect(await page.locator('#result').textContent()).toBe('submitted:Intelligence artificielle');
  });

  it('replays a pre-hydration searchbox click step when the page already hydrated to combobox', async () => {
    await page.goto(`${baseUrl}/hydrated`);

    const clickStep: StepLike = {
      actionType: 'click',
      selectors: ['role=searchbox[name="Rechercher sur Wikipédia"]', '#searchInput', '[name="search"]'],
      anchor: { role: 'searchbox', name: 'Rechercher sur Wikipédia', frame: [] },
    };

    await runStep(clickStep);
    expect(await page.locator('#result').getAttribute('data-clicks')).toBe('1');
  });
});
