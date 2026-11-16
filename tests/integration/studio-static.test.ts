import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { removeDir } from '../helpers/cleanup.js';
import { scanForValues } from '../helpers/scan-artifacts.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const SUB = '/sub/path/';
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain',
};

describe('Static Studio demo (no server)', () => {
  let out: string;
  let server: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  const requests: string[] = [];
  const problems: string[] = [];

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'daemonize-demo-'));
    if (!existsSync(join(workspaceRoot, 'dist', 'studio', 'model.js'))) {
      execFileSync(process.execPath, [join(workspaceRoot, 'node_modules/typescript/bin/tsc')], { cwd: workspaceRoot, stdio: 'pipe' });
    }
    execFileSync(process.execPath, [join(workspaceRoot, 'scripts/build-studio-demo.mjs'), '--out', out], { cwd: workspaceRoot, stdio: 'pipe' });

    // A bare static file server that serves the folder under a sub-path only
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (!url.pathname.startsWith(SUB)) {
        res.writeHead(404).end('not found');
        return;
      }
      const rel = decodeURIComponent(url.pathname.slice(SUB.length)) || 'index.html';
      const file = resolve(out, rel);
      if (!file.startsWith(out)) {
        res.writeHead(403).end();
        return;
      }
      readFile(file).then(
        (bytes) => res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(bytes),
        () => res.writeHead(404).end('not found')
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        const w = window as unknown as { __csp?: string[] };
        (w.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    page.on('request', (r) => requests.push(r.url()));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`failed: ${r.url()}`));
    page.on('response', (r) => {
      if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
    });
  }, 180000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    if (out) await removeDir(out);
  });

  const go = async (hash: string, ready: string) => {
    await page.goto('about:blank');
    await page.goto(`${origin}${SUB}#${hash}`);
    await page.waitForSelector(ready);
  };
  const text = (selector: string) => page.locator(selector).allTextContents().then((all) => all.join('\n'));
  const seeText = (selector: string, sub: string) => expect.poll(() => text(selector), { timeout: 15000 }).toContain(sub);

  it('writes the expected files, with the static-mode and sharing meta tags', async () => {
    for (const f of ['index.html', '404.html', '.nojekyll', 'README.txt', 'data/overview.json', 'data/workflows.json', 'data/graph.json', 'data/schemas.json', 'data/pbt.json', 'data/playground-tools.json', 'data/failure.png', 'js/sim/simulate.js']) {
      expect((await stat(join(out, f))).isFile(), f).toBe(true);
    }
    const index = await readFile(join(out, 'index.html'), 'utf-8');
    expect(index).toContain('<meta name="daemonize-mode" content="static">');
    expect(index).toContain('property="og:title"');
    expect(index).toContain('property="og:description"');
    expect(index).toContain("default-src 'self'");
    expect(existsSync(join(out, 'js', 'sim', 'simulate.d.ts'))).toBe(false);
  });

  it('contains no path, user name, secret name or token', async () => {
    const values = [workspaceRoot, workspaceRoot.replace(/\\/g, '/'), homedir(), tmpdir(), 'daemonize-studio', 'x-studio-token'];
    // Values of secret-looking variables of this very environment (the UI names `DAEMONIZE_SECRET_<NAME>` in a hint, never a value)
    for (const [name, value] of Object.entries(process.env)) {
      if (/SECRET|TOKEN|PASSWORD|API_KEY/i.test(name) && typeof value === 'string' && value.length >= 8) values.push(value);
    }
    const user = userInfo().username;
    if (user.length >= 4) values.push(user);
    expect(await scanForValues(out, values)).toEqual([]);
    const pattern = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,}|password"\s*:\s*"[^"*])/;
    const walk = async (dir: string): Promise<string[]> =>
      (await Promise.all((await readdir(dir, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])))).flat();
    for (const file of (await walk(out)).filter((f) => !f.endsWith('.png'))) {
      expect(pattern.test(await readFile(file, 'utf-8')), file).toBe(false);
    }
  });

  it('renders every view under a sub-path with the simulated-demo banner', async () => {
    await go('/', 'main .view-overview');
    await seeText('#sample-banner', 'Simulated demo: no real application is driven');
    expect(await page.locator('#sample-banner').isVisible()).toBe(true);
    await seeText('main', 'Legacy CRM');
    await go('/workflows', 'main .view-workflows');
    await seeText('main', 'Search customers');
    await go('/graph', 'main .view-graph');
    await page.waitForSelector('main svg');
    await go('/schemas', 'main .view-schemas');
    await seeText('main', 'search_customers');
    await go('/tests', 'main .view-tests');
    await seeText('main', 'create_customer');
    await go('/playground', '[data-playground="ready"]');
    await seeText('[data-static-banner]', 'Simulated demo: no real application is driven');
    // A thumbnail picture of a workflow step is served relative to the page
    await go('/workflows/5a1f0c2e-3b4d-4e6f-8a7b-9c0d1e2f3a4b', 'main .view-workflows');
    await page.waitForFunction(() => [...document.images].length > 0 && [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  });

  it('runs the simulated playground: success, drifted, failure with screenshot, heal, confirm for write', async () => {
    await go('/playground', '[data-playground="ready"]');
    await page.click('button.pg-tool[data-tool="search_customers"]');
    await page.fill('#pg-f-query', 'drift');
    await page.click('#pg-call');
    await seeText('section.pg-result[data-result="success"] .pg-badges', 'Drifted');
    await page.fill('#pg-f-query', 'Ada');
    await page.click('#pg-call');
    await seeText('.pg-screen pre.pg-text', 'Ada Lovelace');

    await page.click('button.pg-tool[data-tool="create_customer"]');
    await page.fill('#pg-f-login', 'ada');
    await page.fill('#pg-f-name', 'fail');
    await page.click('#pg-call');
    await page.getByRole('dialog', { name: 'Run create_customer?' }).waitFor();
    await page.click('#pg-confirm-ok');
    await seeText('section.pg-result[data-result="failed"] .pg-failure', 'not in the dialog any more');
    const img = page.locator('.pg-shot img');
    expect(await img.getAttribute('src')).toBe('data/failure.png');
    await page.waitForFunction(() => (document.querySelector('.pg-shot img') as HTMLImageElement | null)?.complete === true);
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640);

    await page.click('button.pg-tool[data-tool="open_sales_chart"]');
    await page.click('#pg-call');
    await seeText('section.pg-result[data-result="failed"] .pg-failure', 'canvas');
    await page.click('.pg-mode button[data-mode="heal"]');
    await seeText('#pg-mode-note', 'Mode is now heal');
    await page.click('#pg-call');
    await seeText('section.pg-result[data-result="success"] .pg-badges', 'Healed 1 step');
    await seeText('.pg-history', 'search_customers');
  });

  it('shows schema-form validation errors without calling the simulated server', async () => {
    await go('/playground', '[data-playground="ready"]');
    await page.click('button.pg-tool[data-tool="search_customers"]');
    await page.click('#pg-call');
    await seeText('.pg-field[data-field="query"] .error-text', 'required');
  });

  it('makes only same-origin requests under the sub-path, with no CSP violation, console error or failed request', async () => {
    expect(requests.length).toBeGreaterThan(10);
    for (const url of requests) {
      if (url.startsWith('about:')) continue;
      const u = new URL(url);
      expect(u.origin, url).toBe(origin);
      expect(u.pathname.startsWith(SUB), url).toBe(true);
      expect(u.pathname.startsWith('/api'), url).toBe(false);
    }
    expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([]);
    expect(problems).toEqual([]);
  });
});
