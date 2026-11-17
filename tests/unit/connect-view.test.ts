import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// The connect screen in real Chromium. The page is served from src/studio/ui under a fake origin and every /api/ call is
// answered by the `mock` below (the stubbed api), so no Studio server and no real ~/.kiro is involved.

const ui = resolve(import.meta.dirname, '../../src/studio/ui');
const ORIGIN = 'http://ui.test';
const BANNED = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

interface Mock {
  info: Record<string, unknown>;
  preview: { status: number; body: unknown };
  install: { status: number; body: unknown };
  remove: { status: number; body: unknown };
  autoAdd: Record<string, unknown>;
  posts: Array<{ path: string; body: any }>;
}
const baseInfo = { available: true, defaultWorkspace: '/work/project', outputPath: '/work/out', serverName: 'demo', kiroHome: '/home/u/.kiro', kiroHomeExists: true, installs: [] };
const basePreview = {
  confirmationId: 'id-1',
  scope: 'global',
  kiroPath: '/home/u/.kiro',
  files: [
    { path: 'settings/mcp.json', outcome: 'merge' },
    { path: 'skills/demo/SKILL.md', outcome: 'create' },
  ],
  replacesEntry: false,
  serverName: 'demo',
  placeholders: [],
  missingSecrets: [],
  backup: true,
};
const baseInstall = { written: ['settings/mcp.json', 'skills/demo/SKILL.md'], placeholders: [], missingSecrets: [], scope: 'global' };
let mock: Mock;
const reset = (over: Partial<Mock> = {}): void => {
  mock = {
    info: { ...baseInfo },
    preview: { status: 200, body: { ...basePreview } },
    install: { status: 200, body: { ...baseInstall } },
    remove: { status: 200, body: { removed: ['settings/mcp.json', 'skills/demo'] } },
    autoAdd: { enabled: false, writable: true },
    posts: [],
    ...over,
  };
};

describe('connect screen (real Chromium, stubbed api)', () => {
  let browser: Browser;
  let page: Page;

  const json = (route: Route, status: number, body: unknown): Promise<void> => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await (await browser.newContext()).newPage();
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/harness.html') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="main" tabindex="-1"></main><div id="live" role="status"></div><script type="module" src="/harness.js"></script></body></html>' });
      }
      if (url.pathname === '/harness.js') {
        return route.fulfill({ contentType: 'text/javascript', body: "import { connectCard } from './js/views/connect.js'; document.getElementById('main').append(connectCard());" });
      }
      if (url.pathname.startsWith('/api/power/')) {
        const name = url.pathname.slice('/api/power/'.length);
        const method = route.request().method();
        if (method === 'POST') mock.posts.push({ path: name, body: JSON.parse(route.request().postData() ?? '{}') });
        if (name === 'info') return json(route, 200, mock.info);
        if (name === 'snippet') return json(route, 200, { snippet: '{}' });
        if (name === 'auto-add') return json(route, 200, mock.autoAdd);
        if (name === 'preview') return json(route, mock.preview.status, mock.preview.body);
        if (name === 'install') return json(route, mock.install.status, mock.install.body);
        if (name === 'remove') return json(route, mock.remove.status, mock.remove.body);
        return json(route, 404, {});
      }
      try {
        return await route.fulfill({ contentType: TYPES[extname(url.pathname)] ?? 'text/plain', body: await readFile(join(ui, url.pathname)) });
      } catch {
        return route.fulfill({ status: 404, body: '' });
      }
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  const open = async (): Promise<void> => {
    await page.goto('about:blank');
    await page.goto(`${ORIGIN}/harness.html`);
    await page.waitForSelector('#connect-scope, #connect-card p.muted:not([role])');
  };
  const dialogText = (): Promise<string> => page.locator('[role="dialog"]').textContent().then((t) => t ?? '');
  /** The visible text of the screen and of any open dialog, without code.path and without the technical copy button. */
  const visibleText = (): Promise<string> =>
    page.evaluate(() => {
      const parts: string[] = [];
      for (const el of [document.getElementById('connect-card'), document.querySelector('[role="dialog"]')]) {
        if (!el) continue;
        const copy = el.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('code.path, .connect-copy').forEach((n) => n.remove());
        parts.push(copy.textContent ?? '');
      }
      return parts.join('\n');
    });
  const lintAndPaths = async (): Promise<void> => {
    const text = await visibleText();
    expect(text.match(new RegExp(BANNED, 'gi'))).toBeNull();
    expect(text).not.toMatch(/(^|\s)(\/[\w.-]+\/|[A-Za-z]:\\)/);
  };

  it('offers exactly two exclusive choices and preselects from kiroHomeExists', async () => {
    reset();
    await open();
    expect(await page.locator('fieldset#connect-scope input[type=radio]').count()).toBe(2);
    expect(await page.locator('#connect-scope-global').isChecked()).toBe(true);
    expect(await page.getByLabel('All my projects').count()).toBe(1);
    expect(await page.getByLabel('Only this project').count()).toBe(1);
    await page.locator('#connect-scope-project').check();
    expect(await page.locator('#connect-scope-global').isChecked()).toBe(false);
    expect(await page.locator('input[name="connect-scope"]:checked').count()).toBe(1);

    reset({ info: { ...baseInfo, kiroHomeExists: false } });
    await open();
    expect(await page.locator('#connect-scope-project').isChecked()).toBe(true);
    expect(await page.locator('#connect-scope-global').isChecked()).toBe(false);
  });

  it('shows the global sentence and hides the folder field only for global; the user choice wins', async () => {
    reset();
    await open();
    expect(await page.locator('#connect-global').textContent()).toContain('every Kiro project');
    expect(await page.locator('#connect-folder').count()).toBe(0);
    await page.locator('#connect-scope-project').check();
    expect(await page.locator('#connect-global').textContent()).toBe('');
    expect(await page.locator('#connect-folder').count()).toBe(1);
    await page.locator('#connect-btn').click();
    await expect.poll(() => mock.posts.length).toBe(1);
    expect(mock.posts[0]).toEqual({ path: 'preview', body: { scope: 'project', workspacePath: '/work/project' } });
    await page.locator('#connect-cancel').click();

    reset({ info: { ...baseInfo, kiroHomeExists: false } });
    await open();
    expect(await page.locator('#connect-global').textContent()).toBe('');
    await page.locator('#connect-scope-global').check();
    expect(await page.locator('#connect-global').textContent()).toContain('every Kiro project');
    await page.locator('#connect-btn').click();
    await expect.poll(() => mock.posts.length).toBe(1);
    expect(mock.posts[0].body).toEqual({ scope: 'global' });
  });

  it('confirms with the path, each file and outcome, and the matching backup sentence', async () => {
    reset();
    await open();
    await page.locator('#connect-btn').click();
    await page.waitForSelector('#connect-confirm');
    expect(await page.locator('[role="dialog"] code.path').first().textContent()).toBe('/home/u/.kiro');
    const items = await page.locator('.connect-files li').allTextContents();
    expect(items).toEqual(['merge settings/mcp.json', 'create skills/demo/SKILL.md']);
    expect(await page.locator('.connect-backup').textContent()).toContain('copy of your current Kiro settings file is kept');
    await lintAndPaths();
    await page.locator('#connect-cancel').click();

    reset({ preview: { status: 200, body: { ...basePreview, backup: false } } });
    await open();
    await page.locator('#connect-btn').click();
    await page.waitForSelector('#connect-confirm');
    expect(await page.locator('.connect-backup').textContent()).toContain('no previous settings file');
    expect(mock.posts.map((p) => p.path)).toEqual(['preview']);
  });

  it('installs with the chosen scope, sends autoAdd only when ticked, shows the reload reminder and warns by name', async () => {
    reset({ install: { status: 200, body: { ...baseInstall, missingSecrets: ['DAEMONIZE_SECRET_CRM_PASSWORD'], placeholders: ['DAEMONIZE_SECRET_CRM_PASSWORD'] } } });
    await open();
    expect(await page.locator('#connect-auto-add').isChecked()).toBe(false);
    await page.locator('#connect-btn').click();
    await page.locator('#connect-confirm').click();
    await page.waitForSelector('#connect-close');
    expect(mock.posts[1]).toEqual({ path: 'install', body: { confirmationId: 'id-1', kiroPath: '/home/u/.kiro', scope: 'global' } });
    const text = await dialogText();
    expect(text).toContain('panel in Kiro that lists tool servers');
    expect(await page.locator('.connect-missing').textContent()).toContain('DAEMONIZE_SECRET_CRM_PASSWORD');
    await lintAndPaths();
    await page.locator('#connect-close').click();

    reset();
    await open();
    await page.locator('#connect-auto-add').check();
    await page.locator('#connect-btn').click();
    await page.locator('#connect-confirm').click();
    await page.waitForSelector('#connect-close');
    expect(mock.posts[1].body).toEqual({ confirmationId: 'id-1', kiroPath: '/home/u/.kiro', scope: 'global', autoAdd: true });
    expect(await page.locator('.connect-missing').count()).toBe(0);
  });

  it('shows "Remove from Kiro" only with an install, and the reload reminder after removal', async () => {
    reset();
    await open();
    expect(await page.getByRole('button', { name: 'Remove from Kiro' }).count()).toBe(0);

    reset({ info: { ...baseInfo, installs: [{ scope: 'global', slug: 'demo', kiroPath: '/home/u/.kiro' }] } });
    await open();
    expect(await page.getByRole('button', { name: 'Remove from Kiro' }).count()).toBe(1);
    await page.getByRole('button', { name: 'Remove from Kiro' }).click();
    await page.locator('#connect-remove-confirm').click();
    await page.waitForSelector('#connect-close');
    expect(mock.posts).toEqual([{ path: 'remove', body: { scope: 'global' } }]);
    expect(await dialogText()).toContain('panel in Kiro that lists tool servers');
    await lintAndPaths();
  });

  it('keeps the screen open and says the Kiro files were left as they were when a request fails', async () => {
    reset({ preview: { status: 409, body: { error: 'The settings file is not valid.' } } });
    await open();
    await page.locator('#connect-btn').click();
    await expect.poll(() => page.locator('#connect-error').textContent()).toContain('left as they were');
    expect(await page.locator('#connect-btn').isEnabled()).toBe(true);
    await lintAndPaths();

    reset({ install: { status: 500, body: { error: 'It failed.' } } });
    await open();
    await page.locator('#connect-btn').click();
    await page.locator('#connect-confirm').click();
    await expect.poll(() => dialogText()).toContain('left as they were');
    expect(await page.locator('#connect-confirm').isVisible()).toBe(true);

    reset({ info: { ...baseInfo, installs: [{ scope: 'global', slug: 'demo', kiroPath: '/home/u/.kiro' }] }, remove: { status: 500, body: { error: 'It failed.' } } });
    await open();
    await page.getByRole('button', { name: 'Remove from Kiro' }).click();
    await page.locator('#connect-remove-confirm').click();
    await expect.poll(() => dialogText()).toContain('left as they were');
    expect(await page.locator('#connect-remove-confirm').isVisible()).toBe(true);
    expect(await page.locator('#connect-card').count()).toBe(1);
  });
});
