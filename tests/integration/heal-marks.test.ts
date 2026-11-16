import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { buildMarks, type MarksPage } from '../../src/heal/marks.js';

const HTML = `<!doctype html><html><body style="margin:0;background:#fff">
<button id="save" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Save</button>
<a href="#x" style="position:absolute;left:200px;top:20px">Home</a>
<input id="email" aria-label="Email" style="position:absolute;left:20px;top:100px;width:200px;height:30px">
<input id="pw" type="password" style="position:absolute;left:20px;top:200px;width:200px;height:40px;background:#ff0">
<input id="otp" autocomplete="one-time-code" style="position:absolute;left:20px;top:300px;width:200px;height:40px;background:#ff0">
<button id="far" style="position:absolute;left:20px;top:5000px">Far</button>
<div role="button" style="position:absolute;left:400px;top:100px;width:80px;height:30px">Role</div>
</body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  await page.setContent(HTML);
}, 60000);
afterAll(async () => { await browser?.close(); });

describe('buildMarks on a real page', () => {
  it('marks visible interactive elements, skips secret fields, blanks them and removes the overlay', async () => {
    const { marks, screenshotPng } = await buildMarks(page as unknown as MarksPage);
    const names = marks.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['Save', 'Home', 'Email', 'Role']));
    expect(names).not.toContain('Far');
    expect(marks.some((m) => m.box.y === 200 || m.box.y === 300)).toBe(false);
    expect(marks.map((m) => m.id)).toEqual(marks.map((_, i) => i + 1));

    // The overlay is gone and nothing else changed in the DOM
    expect(await page.locator('[data-daemonize-ui]').count()).toBe(0);

    // The password and OTP regions are painted black, not yellow
    const probe = await browser.newPage();
    const pixels = await probe.evaluate(`(async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${screenshotPng.toString('base64')}';
      await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return [[100, 220], [100, 320]].map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3));
    })()`);
    await probe.close();
    expect(pixels).toEqual([[0, 0, 0], [0, 0, 0]]);
  });

  it('removes the overlay even when the screenshot fails', async () => {
    const broken: MarksPage = {
      viewportSize: () => page.viewportSize(),
      evaluate: (script: string) => page.evaluate(script) as never,
      screenshot: async () => { throw new Error('no picture'); },
    };
    await expect(buildMarks(broken)).rejects.toThrow('no picture');
    expect(await page.locator('[data-daemonize-ui]').count()).toBe(0);
  });

  it('respects the cap', async () => {
    const { marks } = await buildMarks(page as unknown as MarksPage, { cap: 2 });
    expect(marks).toHaveLength(2);
  });
});
