import { describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { BrowserLaunchError, isNotInstalled, launchBrowser, type LaunchFn } from '../../src/recorder/browser-launcher.js';

type Opts = Parameters<LaunchFn>[0];
const browser = { fake: true } as unknown as Browser;
const NOT_INSTALLED = "browserType.launch: Executable doesn't exist at /x/chrome\n+---+\n| Looks like Playwright was not installed |\n+---+";
const chan = (name: string): string => `browserType.launch: Chromium distribution '${name}' is not found at /y`;

function script(failures: Array<string | undefined>): { launch: LaunchFn; calls: Opts[] } {
  const calls: Opts[] = [];
  const launch: LaunchFn = async (options) => {
    calls.push(options);
    const failure = failures[calls.length - 1];
    if (failure !== undefined) throw new Error(failure);
    return browser;
  };
  return { launch, calls };
}

describe('Browser_Launcher', () => {
  it('uses DAEMONIZE_CHROMIUM_PATH as the only attempt, without a channel', async () => {
    const { launch, calls } = script([]);
    const got = await launchBrowser({ headless: true, env: { DAEMONIZE_CHROMIUM_PATH: '/opt/browser' }, launch });
    expect(calls).toEqual([{ headless: true, executablePath: '/opt/browser' }]);
    expect(got.used).toBe('custom');
  });

  it('does not fall back when the custom path fails, and names the variable, the path and the cause', async () => {
    const { launch, calls } = script([NOT_INSTALLED]);
    const error = await launchBrowser({ env: { DAEMONIZE_CHROMIUM_PATH: '/opt/none' }, launch }).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect((error as Error).message).toMatch(/DAEMONIZE_CHROMIUM_PATH.*\/opt\/none.*Executable doesn't exist/);
    expect((error as Error).message).not.toContain('+---');
  });

  it('treats an empty DAEMONIZE_CHROMIUM_PATH as unset', async () => {
    const { launch, calls } = script([]);
    await launchBrowser({ env: { DAEMONIZE_CHROMIUM_PATH: '' }, launch });
    expect(calls).toEqual([{ headless: false }]);
  });

  it('tries bundled Chromium, then chrome, then msedge, and stops at the first success', async () => {
    const { launch, calls } = script([NOT_INSTALLED, chan('chrome')]);
    const got = await launchBrowser({ headless: true, env: {}, launch });
    expect(calls).toEqual([{ headless: true }, { headless: true, channel: 'chrome' }, { headless: true, channel: 'msedge' }]);
    expect(got.used).toBe('msedge');
  });

  it('stops at a failure that is not "not installed" and names the browser', async () => {
    const { launch, calls } = script([NOT_INSTALLED, 'browserType.launch: spawn EACCES\nmore lines']);
    const error = await launchBrowser({ env: {}, launch }).catch((e: unknown) => e);
    expect(calls).toHaveLength(2);
    expect((error as Error).message).toBe('Google Chrome could not be started: browserType.launch: spawn EACCES');
  });

  it('stops at a launch timeout', async () => {
    const { launch, calls } = script(['browserType.launch: Timeout 30000ms exceeded.']);
    await expect(launchBrowser({ env: {}, launch })).rejects.toThrow(/Chromium could not be started: .*Timeout/);
    expect(calls).toHaveLength(1);
  });

  it('names Google Chrome, Microsoft Edge and the variable when none is installed', async () => {
    const { launch, calls } = script([NOT_INSTALLED, chan('chrome'), chan('msedge')]);
    const error = await launchBrowser({ env: {}, launch }).catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    expect((error as Error).message).toMatch(/Google Chrome/);
    expect((error as Error).message).toMatch(/Microsoft Edge/);
    expect((error as Error).message).toMatch(/DAEMONIZE_CHROMIUM_PATH/);
  });

  it('strips colors and clips the cause to 200 characters', async () => {
    const { launch } = script([`\u001b[31m${'x'.repeat(500)}\u001b[39m`]);
    const error = (await launchBrowser({ env: {}, launch }).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain('\u001b');
    expect(error.message.length).toBeLessThan('Chromium could not be started: '.length + 210);
  });

  it('classifies only the three Playwright messages as not installed', () => {
    expect(isNotInstalled(new Error(NOT_INSTALLED))).toBe(true);
    expect(isNotInstalled(new Error(chan('msedge')))).toBe(true);
    expect(isNotInstalled(new Error("Executable doesn\u2019t exist at /z"))).toBe(true);
    expect(isNotInstalled(new Error('permission denied'))).toBe(false);
  });
});
