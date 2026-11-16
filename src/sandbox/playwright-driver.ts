import { EventEmitter } from 'node:events';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import type { SandboxDriver } from './driver.js';
import type { ScreenContent, RecordedAction } from '../types.js';
import { waitForEffect, resolveStepTimeoutMs, type SettlePage } from '../replay/runtime/settle.js';
import { extractWebZone } from '../replay/runtime/web-steps.js';
import type { ZoneLike, ZoneOutcome } from '../replay/runtime/extract.js';

export class PlaywrightDriver implements SandboxDriver {
  readonly onUnexpectedExit = new EventEmitter();
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(
    private targetUrl: string,
    private options: {
      debounceMs?: number; // kept for compatibility; waits are effect based
      stepTimeoutMs?: number; // step wait/action timeout; default DAEMONIZE_STEP_TIMEOUT_MS or 8000
    } = {}
  ) { }

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined,
    });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    await this.page.goto(this.targetUrl);
    await waitForEffect(this.settlePage(), { timeoutMs: this.stepTimeout() });
  }

  private stepTimeout(): number {
    return resolveStepTimeoutMs({ step: this.options.stepTimeoutMs, env: process.env.DAEMONIZE_STEP_TIMEOUT_MS });
  }

  private settlePage(): SettlePage {
    return this.page as unknown as SettlePage;
  }

  async captureScreen(): Promise<ScreenContent> {
    if (!this.page) {
      throw new Error('PlaywrightDriver is not started. Call start() first.');
    }

    const raw = await this.page.evaluate(() => document.documentElement.outerHTML);

    return {
      type: 'dom',
      raw,
      normalized: raw,
      capturedAt: Date.now(),
    };
  }

  async execute(action: RecordedAction): Promise<ScreenContent> {
    if (!this.page) {
      throw new Error('PlaywrightDriver is not started. Call start() first.');
    }

    const timeout = resolveStepTimeoutMs({ step: action.timeoutMs, env: this.stepTimeout() });
    const page = this.page;

    // The wait on the effect starts before the action, so what the action itself triggers is seen
    await waitForEffect(this.settlePage(), {
      timeoutMs: timeout,
      action: async () => {
        switch (action.actionType) {
          case 'click':
            await page.click(action.selector!, { timeout });
            break;
          case 'type':
            await page.fill(action.selector!, action.value ?? '', { timeout });
            break;
          case 'keypress':
            await page.press(action.selector ?? 'body', action.value ?? 'Enter', { timeout });
            break;
          case 'form_submit':
            await page.press(action.selector ?? 'form', 'Enter', { timeout });
            break;
          case 'select':
            await page.selectOption(action.selector!, action.value ?? '', { timeout });
            break;
          default: {
            const exhaustiveCheck: never = action.actionType;
            throw new Error(`Unknown action type: ${exhaustiveCheck}`);
          }
        }

      },
    });

    return this.captureScreen();
  }

  async screenshot(): Promise<Buffer> {
    if (!this.page) {
      throw new Error('PlaywrightDriver is not started. Call start() first.');
    }
    return this.page.screenshot({ timeout: 3000 });
  }

  async extractZone(zone: ZoneLike): Promise<ZoneOutcome> {
    if (!this.page) {
      throw new Error('PlaywrightDriver is not started. Call start() first.');
    }
    return extractWebZone(this.page, zone, this.stepTimeout());
  }

  async stop(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
