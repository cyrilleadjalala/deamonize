import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { CAPTURE_SCRIPT } from '../../src/recorder/capture-script.js';

const HELPERS_HTML = readFileSync(new URL('../fixtures/web/helpers.html', import.meta.url), 'utf8')
  .replace(/<iframe[^>]*><\/iframe>/, '');

describe('capture script helpers (role, accessible name, context, secrets)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined,
    });
    page = await browser.newPage();
    await page.setContent(HELPERS_HTML);
    await page.evaluate(CAPTURE_SCRIPT);
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  const call = <T>(helper: string, id: string): Promise<T> =>
    page.evaluate(
      ([h, i]) => {
        const helpers = (window as any).__daemonizeHelpers;
        return helpers[h](document.getElementById(i));
      },
      [helper, id]
    ) as Promise<T>;

  describe('roleOf', () => {
    it.each([
      ['a', 'textbox'],
      ['f', 'button'],
      ['i', 'button'],
      ['j', 'combobox'],
      ['k', 'textbox'],
      ['l', 'link'],
      ['o', 'switch'],
      ['p', 'tab'],
      ['q', 'combobox'],
      ['g', 'img'],
      ['ds', 'button'],
    ])('#%s has the role %s', async (id, role) => {
      expect(await call('roleOf', id)).toBe(role);
    });

    it('has no role for a password field', async () => {
      expect(await call('roleOf', 'pw')).toBeUndefined();
    });
  });

  describe('accessibleName', () => {
    it.each([
      ['a', 'Full name', 'label[for]'],
      ['b', 'Email', 'wrapping label, without the control itself'],
      ['c', 'Search box', 'aria-label before placeholder'],
      ['d', 'Only placeholder', 'placeholder'],
      ['e', 'Labelled by span', 'aria-labelledby'],
      ['f', 'Save now', 'content of descendants'],
      ['g', 'Logo', 'alt'],
      ['h', 'Close', 'title'],
      ['i', 'Send', 'input value'],
      ['j', 'Plan', 'aria-label on a custom combobox'],
      ['k', 'Notes', 'aria-label on a contenteditable'],
      ['l', 'Docs', 'link text'],
      ['m', 'Visible', 'hidden descendants are skipped'],
      ['n', 'Labelled by span Save now', 'aria-labelledby with several ids wins over content'],
      ['o', 'Notifications', 'custom switch content'],
      ['q', 'Wrapped', 'wrapping label with an embedded select'],
    ])('#%s is named "%s" (%s)', async (id, name) => {
      expect(await call('accessibleName', id)).toBe(name);
    });
  });

  describe('parentContext', () => {
    it('is a dialog for a control inside a dialog', async () => {
      expect(await call('parentContext', 'ds')).toEqual({
        kind: 'dialog',
        name: 'Edit customer',
        selector: 'role=dialog[name="Edit customer"]',
      });
    });

    it('is the named form for a control inside a form', async () => {
      expect(await call('parentContext', 'f')).toEqual({ kind: 'region', name: 'Customer' });
    });

    it('summarises the table row for a control inside a row', async () => {
      expect(await call('parentContext', 'del')).toEqual({
        kind: 'region',
        name: 'Ada Lovelace ada@example.com',
        selector: 'tr:has-text("Ada Lovelace")',
      });
    });

    it('is the heading of the enclosing section', async () => {
      expect(await call('parentContext', 'bs')).toEqual({ kind: 'heading', name: 'Billing' });
    });

    it('is the legend of the enclosing fieldset', async () => {
      expect(await call('parentContext', 'fs')).toEqual({ kind: 'heading', name: 'Shipping' });
    });

    it('is the neighbouring label when nothing else encloses the control', async () => {
      expect(await call('parentContext', 'coupon')).toEqual({ kind: 'label', name: 'Coupon' });
    });
  });

  describe('secretKind', () => {
    it.each([
      ['pw', 'PASSWORD'],
      ['otp', 'OTP'],
      ['tok', 'TOKEN'],
    ])('#%s is a %s field', async (id, kind) => {
      expect(await call('secretKind', id)).toBe(kind);
    });

    it('is undefined for an ordinary field', async () => {
      expect(await call('secretKind', 'a')).toBeUndefined();
    });
  });

  it('gives the anchor of a control: role, name, parent and the main frame path', async () => {
    expect(await call('anchorOf', 'ds')).toEqual({
      role: 'button',
      name: 'Save',
      frame: [],
      parent: { kind: 'dialog', name: 'Edit customer' },
    });
  });
});
