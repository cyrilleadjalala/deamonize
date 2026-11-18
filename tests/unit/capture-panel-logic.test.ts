import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { CAPTURE_SCRIPT } from '../../src/recorder/capture-script.js';

/** The pure parts of the panel (offer model, request shapes, control reading) and the end sheet scope group. */
describe('capture script panel logic', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  async function pageWith(html: string): Promise<Page> {
    const page = await browser.newPage();
    await page.setContent(html);
    await page.evaluate(CAPTURE_SCRIPT);
    return page;
  }

  it('is a plain template: no backtick and no placeholder can end up inside it', () => {
    expect(CAPTURE_SCRIPT).not.toContain('`');
    expect(CAPTURE_SCRIPT).not.toContain('${');
  });

  describe('createOfferModel', () => {
    it('keeps earlier offers for input, typed, route and clear events', async () => {
      const page = await pageWith('<body></body>');
      const result = await page.evaluate(() => {
        const model = (window as any).__daemonizeHelpers.offerModel.create('/a');
        const route = model.route;
        const ids = (list: Array<{ fieldId: string }>) => list.map((o) => o.fieldId);
        const typed = (id: string, step: number) => model.apply({ t: 'typed', fieldId: id, stepIndex: step, suggestion: id, label: id, route });
        const out: Record<string, unknown> = {};
        typed('a', 0);
        model.apply({ t: 'input', fieldId: 'b' });
        out.afterInput = [model.offer.fieldId, ids(model.earlier)];
        typed('b', 1);
        out.afterTyped = [model.offer.fieldId, ids(model.earlier)];
        typed('a', 0);
        out.typedAgain = [model.offer.fieldId, ids(model.earlier)];
        model.apply({ t: 'route', route: '/b' });
        out.afterRoute = [model.offer, ids(model.earlier)];
        model.apply({ t: 'typed', fieldId: 'z', stepIndex: 5, suggestion: 'z', label: 'z', route: '/a' });
        out.staleRoute = model.offer;
        model.apply({ t: 'typed', fieldId: 'c', stepIndex: 2, suggestion: 'c', label: 'c', route: '/b' });
        model.apply({ t: 'clear', stepIndex: 2 });
        out.afterClear = [model.offer, ids(model.earlier)];
        return out;
      });
      expect(result).toEqual({
        afterInput: ['a', ['a']],
        afterTyped: ['b', ['a']],
        typedAgain: ['a', ['b']],
        afterRoute: [null, ['b']],
        staleRoute: null,
        afterClear: [null, ['b']],
      });
      await page.close();
    });

    it('holds at most 100 earlier offers, one per field', async () => {
      const page = await pageWith('<body></body>');
      const sizes = await page.evaluate(() => {
        const model = (window as any).__daemonizeHelpers.offerModel.create('/a');
        for (let i = 0; i < 150; i++) {
          model.apply({ t: 'typed', fieldId: 'f' + i, stepIndex: i, suggestion: 's', label: 'l', route: '/a' });
        }
        const first = model.earlier;
        for (let i = 100; i < 150; i++) model.apply({ t: 'typed', fieldId: 'f' + i, stepIndex: i, suggestion: 's', label: 'l', route: '/a' });
        return { size: first.length, unique: new Set(first.map((o: { fieldId: string }) => o.fieldId)).size, oldest: first[0].fieldId, again: model.earlier.length <= 100 };
      });
      expect(sizes).toEqual({ size: 100, unique: 100, oldest: 'f49', again: true });
      await page.close();
    });
  });

  describe('the requests of the form', () => {
    it('sends type always, and optional with whenOmitted only when the box is checked', async () => {
      const page = await pageWith('<body></body>');
      const requests = await page.evaluate(() => {
        const h = (window as any).__daemonizeHelpers;
        const offer = { stepIndex: 3, suggestion: 's', label: 'l' };
        return [
          h.variableRequest(offer, { name: 'a', type: 'string', optional: false, whenOmitted: 'skip' }),
          h.variableRequest(offer, { name: 'a', type: 'number', optional: true, whenOmitted: 'useRecorded' }),
          h.variableRequest({ ...offer, rowText: 'Ada' }, { name: 'a', type: 'string', optional: false, whenOmitted: 'skip' }),
        ];
      });
      expect(requests).toEqual([
        { stepIndex: 3, name: 'a', type: 'string' },
        { stepIndex: 3, name: 'a', type: 'number', optional: true, whenOmitted: 'useRecorded' },
        { stepIndex: 3, name: 'a', rowText: 'Ada', type: 'string' },
      ]);
      await page.close();
    });

    it('sends only the settings the person changed in an edit, and nothing when nothing changed', async () => {
      const page = await pageWith('<body></body>');
      const requests = await page.evaluate(() => {
        const h = (window as any).__daemonizeHelpers;
        const current = { name: 'a', type: 'string', optional: false };
        const optionalNow = { name: 'a', type: 'number', optional: true, whenOmitted: 'skip' };
        return [
          h.editRequest(current, { name: 'a', type: 'string', optional: false, whenOmitted: 'skip' }),
          h.editRequest(current, { name: 'b', type: 'string', optional: false, whenOmitted: 'skip' }),
          h.editRequest(current, { name: 'a', type: 'number', optional: false, whenOmitted: 'skip' }),
          h.editRequest(current, { name: 'a', type: 'string', optional: true, whenOmitted: 'skip' }),
          h.editRequest(optionalNow, { name: 'a', type: 'number', optional: true, whenOmitted: 'useRecorded' }),
          h.editRequest(optionalNow, { name: 'a', type: 'number', optional: false, whenOmitted: 'skip' }),
        ];
      });
      expect(requests).toEqual([
        null,
        { name: 'a', newName: 'b' },
        { name: 'a', type: 'number' },
        { name: 'a', optional: true, whenOmitted: 'skip' },
        { name: 'a', whenOmitted: 'useRecorded' },
        { name: 'a', optional: false },
      ]);
      await page.close();
    });
  });

  describe('reading a control', () => {
    it('reads the state of a checkbox and of a role element; false, mixed or absent aria-checked is "false"', async () => {
      const page = await pageWith(`<body>
        <input id="c1" type="checkbox" checked><input id="c2" type="checkbox">
        <div id="s1" role="switch" aria-checked="true"></div><div id="s2" role="switch" aria-checked="false"></div>
        <div id="s3" role="checkbox" aria-checked="mixed"></div><div id="s4" role="checkbox"></div></body>`);
      const values = await page.evaluate(() =>
        ['c1', 'c2', 's1', 's2', 's3', 's4'].map((id) => (window as any).__daemonizeHelpers.checkValueOf(document.getElementById(id))));
      expect(values).toEqual(['true', 'false', 'true', 'false', 'false', 'false']);
      await page.close();
    });

    it('reads a radio group: same name in the same form, enabled names in document order, disabled ones counted', async () => {
      const page = await pageWith(`<body>
        <form id="f1"><label><input type="radio" name="g" id="a"> One</label><label><input type="radio" name="g" id="b" disabled> Two</label>
          <label><input type="radio" name="g" id="c"> Three</label></form>
        <form id="f2"><label><input type="radio" name="g" id="d"> Other form</label></form>
        <label><input type="radio" name="g" id="e"> No form</label>
        <label><input type="radio" id="n"> No name</label>
        <div role="radiogroup"><div role="radio" id="r1">Red</div><div role="radio" id="r2" aria-disabled="true">Green</div><div role="radio" id="r3">Blue</div></div></body>`);
      const info = await page.evaluate(() => {
        const h = (window as any).__daemonizeHelpers;
        return ['a', 'b', 'd', 'e', 'n', 'r1', 'r2'].map((id) => h.radioInfoOf(document.getElementById(id)));
      });
      expect(info[0]).toEqual({ names: ['One', 'Three'], total: 3, clicked: 'One', clickedDisabled: false });
      expect(info[1]).toMatchObject({ clicked: 'Two', clickedDisabled: true });
      expect(info[2]).toEqual({ names: ['Other form'], total: 1, clicked: 'Other form', clickedDisabled: false });
      expect(info[3]).toEqual({ names: ['No form'], total: 1, clicked: 'No form', clickedDisabled: false });
      expect(info[4]).toEqual({ names: ['No name'], total: 1, clicked: 'No name', clickedDisabled: false });
      expect(info[5]).toEqual({ names: ['Red', 'Blue'], total: 3, clicked: 'Red', clickedDisabled: false });
      expect(info[6].clickedDisabled).toBe(true);
      await page.close();
    });

    it('does not offer a radio that sits inside a table row', async () => {
      const page = await pageWith(`<body>
        <table><tr><td>Ada</td><td><input type="radio" name="p" id="x" aria-label="Pick Ada"></td></tr>
        <tr><td>Bob</td><td><input type="radio" name="p" id="y" aria-label="Pick Bob"></td></tr></table>
        <label><input type="radio" name="q" id="z"> Free</label><label><input type="radio" name="q" id="w"> Pro</label></body>`);
      const calls: unknown[] = [];
      await page.exposeBinding('__daemonizeRecord', (_s, event) => { calls.push(event); return 0; });
      await page.locator('#x').click();
      await page.locator('#z').click();
      await expect.poll(() => calls.length).toBe(2);
      expect((calls[0] as { radio?: unknown }).radio).toBeUndefined();
      expect((calls[1] as { radio?: { names: string[] } }).radio?.names).toEqual(['Free', 'Pro']);
      await page.close();
    });
  });

  describe('the file notice', () => {
    it('has no file detail and sends only a counter signal with an id that is not a file name', async () => {
      const page = await pageWith('<body><input id="f" type="file"></body>');
      const sent: unknown[] = [];
      await page.exposeBinding('__daemonizePanel', (_s, request) => { sent.push(request); return { ok: true }; });
      const notice = await page.evaluate(() => (window as any).__daemonizeHelpers.FILE_NOTICE as string);
      expect(notice).toMatch(/not supported yet/i);
      expect(notice).toMatch(/not recorded as an input/i);
      await page.locator('#f').setInputFiles({ name: 'tax-return.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF secret') });
      await expect.poll(() => sent.filter((r) => (r as { type: string }).type === 'file').length).toBe(1);
      const request = sent.find((r) => (r as { type: string }).type === 'file') as { type: string; fieldId: string };
      expect(Object.keys(request).sort()).toEqual(['fieldId', 'type']);
      expect(JSON.stringify(request)).not.toMatch(/tax|pdf|secret/);
      const shown = (await page.locator('[data-daemonize-ui] p[role=status]').textContent()) ?? '';
      expect(shown).toBe(notice);
      expect(await page.locator('[data-daemonize-ui] p[role=status]').getAttribute('aria-live')).toBe('polite');
      await page.close();
    });
  });

  describe('the End_Sheet scope group', () => {
    async function sheetPage(kiroHomeExists: boolean): Promise<{ page: Page; finished: unknown[] }> {
      const page = await browser.newPage();
      const finished: unknown[] = [];
      await page.exposeBinding('__daemonizePanel', (_s, request: { type: string }) => {
        if (request.type === 'summary') return { steps: 1, variables: [], secrets: 0, files: 0 };
        if (request.type === 'fields') return { fields: [] };
        return { steps: 1, last: [], collapsed: false, ending: false, studio: true, kiroHomeExists };
      });
      await page.exposeBinding('__daemonizeFinish', (_s, request) => { finished.push(request); return { ok: true }; });
      await page.exposeBinding('__daemonizeRecord', () => 0);
      await page.setContent('<body><p>page</p></body>');
      await page.evaluate(CAPTURE_SCRIPT);
      await page.getByRole('button', { name: 'Finish and save' }).click();
      await page.locator('[data-daemonize-action=finish-sheet]').waitFor();
      return { page, finished };
    }

    it('is a radiogroup named "Where to add the tool" with "All my projects" selected, moved by the arrow keys', async () => {
      const { page, finished } = await sheetPage(true);
      const group = page.getByRole('radiogroup', { name: 'Where to add the tool' });
      await group.waitFor();
      expect(await group.getByRole('radio').count()).toBe(2);
      const all = page.getByRole('radio', { name: 'All my projects' });
      const only = page.getByRole('radio', { name: 'Only this project' });
      expect(await all.isChecked()).toBe(true);
      await all.focus();
      await page.keyboard.press('ArrowDown');
      expect(await only.isChecked()).toBe(true);
      await page.keyboard.press('ArrowUp');
      expect(await all.isChecked()).toBe(true);
      await page.keyboard.press('ArrowDown');
      await page.locator('[data-daemonize-action=finish-kiro]').click();
      await expect.poll(() => finished.length).toBe(1);
      expect(finished[0]).toEqual({ intent: 'kiro', scope: 'project' });
      await page.close();
    });

    it('sends "global" by default and no scope for "Save only" and "Test first"', async () => {
      const first = await sheetPage(true);
      await first.page.locator('[data-daemonize-action=finish-kiro]').click();
      await expect.poll(() => first.finished.length).toBe(1);
      expect(first.finished[0]).toEqual({ intent: 'kiro', scope: 'global' });
      await first.page.close();

      for (const [button, intent] of [['finish-save', 'save'], ['finish-test', 'test']] as const) {
        const { page, finished } = await sheetPage(true);
        await page.locator(`[data-daemonize-action=${button}]`).click();
        await expect.poll(() => finished.length).toBe(1);
        expect(finished[0]).toEqual({ intent });
        await page.close();
      }
    });

    it('shows the static text "Only this project" with no radio group when the Kiro folder does not exist', async () => {
      const { page, finished } = await sheetPage(false);
      expect(await page.getByRole('radiogroup').count()).toBe(0);
      expect(await page.locator('[data-daemonize-action=scope-static]').textContent()).toBe('Only this project');
      await page.locator('[data-daemonize-action=finish-kiro]').click();
      await expect.poll(() => finished.length).toBe(1);
      expect(finished[0]).toEqual({ intent: 'kiro', scope: 'project' });
      await page.close();
    });
  });
});
