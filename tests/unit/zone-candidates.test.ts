import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { ZONE_COPY } from '../../src/recorder/zone-copy.js';

const ROLE_ONLY_PAGE = `<!doctype html><html><body>
<div><p>intro</p><table><tbody><tr><td>one</td></tr><tr><td>two</td></tr></tbody></table></div>
</body></html>`;

const POSITIONAL_PAGE = `<!doctype html><html><body>
<div id="wrap"><div><span>first</span></div><div><span>second</span></div></div>
</body></html>`;

describe('result zone candidates in the recorder', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });
  afterEach(async () => {
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function attach(html: string): Promise<LiveRecorder> {
    const live = new LiveRecorder(page, new WorkflowRecorder('ZoneCandidates'));
    await page.goto('about:blank');
    await page.setContent(html);
    await live.attach();
    return live;
  }

  const fragileNote = (): ReturnType<Page['locator']> => page.locator('[data-daemonize-action=result-fragile]');

  it('keeps a role alone when it is the only table of the page', async () => {
    const live = await attach(ROLE_ONLY_PAGE);
    await page.locator('[data-daemonize-action=mark-result]').click();
    await page.locator('td').first().click();
    await expect.poll(() => live.resultZone?.selectors?.length ?? 0).toBeGreaterThan(0);
    expect(live.resultZone?.selectors).toContain('role=table');
    expect(live.resultZone?.selector).toBe(live.resultZone?.selectors?.[0]);
    expect(live.resultZone?.fingerprint).toMatchObject({ tag: 'table', kind: 'table' });
  });

  it('leaves out a candidate whose check throws and keeps the others', async () => {
    const live = new LiveRecorder({} as Page, new WorkflowRecorder('Faulty'));
    const frame = {
      locator: (selector: string) => {
        if (selector.startsWith('role=')) throw new Error('engine fault');
        return { count: async () => 1, evaluate: async () => true };
      },
    } as unknown as Frame;
    const answer = await live.markResultInFrame(
      { info: { role: 'table', id: 'orders', css: '#orders' }, kind: 'table', zone: { minimal: '#orders', positional: 'body > table' } },
      frame
    );
    expect(answer).toMatchObject({ ok: true, selector: '#orders' });
    if (answer.ok) {
      expect(answer.selectors).toEqual(['#orders', 'body > table']);
      expect(answer.selectors?.some((s) => s.startsWith('role='))).toBe(false);
    }
  });

  it('accepts a fragile zone: only the positional path is stored and the answer says so', async () => {
    const live = new LiveRecorder({} as Page, new WorkflowRecorder('Fragile'));
    const frame = {
      locator: (selector: string) => ({ count: async () => (selector.includes('nth-of-type') ? 1 : 2), evaluate: async () => true }),
    } as unknown as Frame;
    const positional = 'body > div:nth-of-type(2) > span';
    const answer = await live.markResultInFrame({ info: { css: positional }, kind: 'text', zone: { minimal: 'span', positional } }, frame);
    expect(answer).toMatchObject({ ok: true, selector: positional, selectors: [positional], fragile: true });
    expect(live.resultZone).toMatchObject({ selector: positional, selectors: [positional] });
  });

  it('falls back to the legacy selector when the page sent no facts', async () => {
    const live = new LiveRecorder({} as Page, new WorkflowRecorder('Legacy'));
    const frame = { locator: () => { throw new Error('not used'); } } as unknown as Frame;
    const answer = await live.markResultInFrame({ info: { id: 'orders', css: '#orders' }, kind: 'list' }, frame);
    expect(answer).toEqual({ ok: true, selector: '#orders', kind: 'list' });
    expect(live.resultZone).toEqual({ selector: '#orders', extractor: { kind: 'list' } });
  });

  it('shows the warning for a positional-only zone, not for a stable one, and removes it after Wider', async () => {
    const live = await attach(POSITIONAL_PAGE);
    await page.locator('[data-daemonize-action=mark-result]').click();
    await page.locator('#wrap > div').first().locator('span').click();
    await page.locator('[data-daemonize-action=result-preview]').waitFor();
    await expect.poll(() => live.resultZone?.selectors?.every((s) => /nth-of-type/.test(s))).toBe(true);
    await fragileNote().waitFor();
    expect(await fragileNote().innerText()).toBe(ZONE_COPY.fragile);
    // "Finish and save" stays usable
    expect(await page.getByRole('button', { name: 'Finish and save' }).isDisabled()).toBe(false);

    // Wider twice: span -> div -> #wrap
    await page.locator('[data-daemonize-action=result-wider]').click();
    await expect.poll(() => page.locator('[data-daemonize-action=result-card]').innerText()).toContain('div');
    await page.locator('[data-daemonize-action=result-wider]').click();
    await expect.poll(() => live.resultZone?.selector).toBe('#wrap');
    await expect.poll(() => fragileNote().count()).toBe(0);
  });
});
