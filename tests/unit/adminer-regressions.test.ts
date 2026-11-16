/**
 * Regressions found by the first run of Daemonize against real software (Adminer on PostgreSQL, tests/integration/adminer-e2e.test.ts).
 * The HTML fragments are shortened copies of Adminer's own markup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { CAPTURE_SCRIPT } from '../../src/recorder/capture-script.js';
import { ScreenHasher } from '../../src/state/screen-hasher.js';
import { finishWebZone, WEB_ZONE_FUNCTION, type RawWebZone } from '../../src/replay/runtime/extract.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { WorkflowSet } from '../../src/types.js';

const LOGIN = `<form method="post"><div><input type="hidden" name="token" value="TOKEN"></div>
<table class="layout"><tbody>
<tr><th>System</th><td><select name="auth[driver]" id="driver"><option value="server" selected>MySQL / MariaDB</option><option value="pgsql">PostgreSQL</option><option value="sqlite">SQLite</option></select></td></tr>
<tr><th>Server</th><td><input name="auth[server]" id="server" value="db"></td></tr>
<tr><th>Username</th><td><input name="auth[username]" id="username" value=""></td></tr>
</tbody></table><p><input type="submit" value="Login" id="login"></p></form>`;

const EDIT = `<form id="form" method="post"><table class="layout"><tbody>
<tr><th><span title="integer">id</span></th><td class="function"><select name="function[id]"><option selected></option><option>+</option></select></td><td><input type="number" value="3" name="fields[id]"></td></tr>
<tr><th><span title="text">name</span></th><td class="function"><select name="function[name]"><option selected></option></select></td><td><textarea name="fields[name]">Chiara Rossi</textarea></td></tr>
<tr><th><span title="text">status</span></th><td class="function"><select name="function[status]"><option selected></option></select></td><td><textarea name="fields[status]">inactive</textarea></td></tr>
</tbody></table></form>`;

describe('Adminer regressions: recording', () => {
  let browser: Browser;
  let page: Page;
  const events: any[] = [];
  const zones: any[] = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
    page = await browser.newPage();
    await page.exposeBinding('__daemonizeRecord', (_s, event) => {
      events.push(event);
      return events.length - 1;
    });
    await page.exposeBinding('__daemonizeMarkVariable', () => ({ ok: true }));
    await page.exposeBinding('__daemonizeMarkResult', (_s, request) => {
      zones.push(request);
      return { ok: true, selector: 'x', kind: request.kind };
    });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  async function load(html: string): Promise<void> {
    events.length = 0;
    zones.length = 0;
    // A new document each time: the script installs itself once per window
    await page.goto('about:blank');
    await page.setContent(html);
    await page.evaluate(CAPTURE_SCRIPT);
  }

  it('names a native select box by nothing: its option labels are not its accessible name', async () => {
    await load(LOGIN);
    expect(await page.evaluate(() => (window as any).__daemonizeHelpers.accessibleName(document.getElementById('driver')))).toBe('');
  });

  it('does not bind the rows of a form laid out as a table (a th label, then the control) as records', async () => {
    await load(LOGIN);
    const context = await page.evaluate(() => (window as any).__daemonizeHelpers.parentContext(document.getElementById('username')));
    expect(context?.rowBinding).toBeUndefined();
  });

  it('ignores a change event a script fires without a change of value, but records a real choice', async () => {
    await load(LOGIN);
    await page.evaluate(() => document.getElementById('driver')!.dispatchEvent(new Event('change', { bubbles: true })));
    expect(events).toHaveLength(0);
    await page.selectOption('#driver', 'pgsql');
    await expect.poll(() => events.map((e) => [e.actionType, e.value])).toEqual([['select', 'pgsql']]);
    // Back to the value of the page: it is a choice again
    await page.selectOption('#driver', 'server');
    await expect.poll(() => events.map((e) => e.value)).toEqual(['pgsql', 'server']);
  });

  it('does not record a change event fired by a script while the page is still being parsed', async () => {
    const seen: unknown[] = [];
    const other = await browser.newPage();
    await other.exposeBinding('__daemonizeRecord', (_s, event) => seen.push(event));
    await other.route('http://adminer.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<form><select name="d" id="d"><option value="a" selected>A</option><option value="b">B</option></select>
<script>document.getElementById('d').value = 'b'; document.getElementById('d').dispatchEvent(new Event('change', { bubbles: true }));</script></form>`,
      })
    );
    await other.addInitScript(CAPTURE_SCRIPT);
    await other.goto('http://adminer.test/');
    await other.waitForTimeout(300);
    expect(await other.locator('#d').inputValue()).toBe('b');
    expect(seen).toHaveLength(0);
    await other.close();
  });

  it('keeps the unique class of the marked element instead of a position among its siblings', async () => {
    await load('<div id="content"><h2>t</h2><div>one</div><div class="message">Item has been updated.</div></div>');
    await page.keyboard.press('Alt+Shift+R');
    await page.locator('div.message').click();
    await expect.poll(() => zones.length).toBe(1);
    expect(zones[0].info.css).toBe('div.message');
  });
});

describe('Adminer regressions: drift hash', () => {
  const hasher = new ScreenHasher();
  const hash = (html: string) => hasher.normalizedHash({ type: 'dom', raw: html, normalized: html, capturedAt: 0 });

  it('ignores the value of a CSRF token input, which changes on every page load', () => {
    const page = (token: string) => `<form><input type="hidden" name="token" value="${token}"><input name="q" value="a"></form>`;
    expect(hash(page('382740:455488'))).toBe(hash(page('999999:111111')));
    expect(hash(`<form><input type="hidden" value="1" name="csrfmiddlewaretoken"></form>`)).toBe(hash(`<form><input name="csrfmiddlewaretoken" value="2" type="hidden"></form>`));
    // The value of any other input still counts
    expect(hash('<input name="q" value="a">')).not.toBe(hash('<input name="q" value="b">'));
  });
});

describe('Adminer regressions: reading a form as fields', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
  });

  it('reads the label cell and the value of the last control of a three-cell row', async () => {
    const page = await browser.newPage();
    await page.setContent(EDIT);
    const raw = (await page.evaluate(
      ([source]) => (0, eval)(`(${source})`)(document.querySelector('#form > table'), { kind: 'fields' }),
      [WEB_ZONE_FUNCTION]
    )) as RawWebZone;
    const outcome = finishWebZone(raw, { extractor: { kind: 'fields' } });
    expect(outcome).toMatchObject({ ok: true, data: { id: '3', name: 'Chiara Rossi', status: 'inactive' } });
    await page.close();
  });
});

describe('Adminer regressions: enum of a Variable', () => {
  it('goes to the input schema as a string enum', () => {
    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'x',
      startUrl: 'http://localhost/',
      workflows: [
        {
          id: 'a1111111-1111-4111-8111-111111111111',
          label: 'rename',
          steps: [{ actionType: 'select', selectors: ['[name=s]'], variable: 'status', value: 'active' }],
          variables: [{ name: 'status', enum: ['active', 'inactive'] }],
          observedPayloads: [{ status: 'active' }],
        },
      ],
    };
    const schema = new SchemaInferencer().inferWorkflows(set).workflows[0].inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties.status).toMatchObject({ type: 'string', enum: ['active', 'inactive'] });
  });
});
