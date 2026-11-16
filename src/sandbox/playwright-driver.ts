import { EventEmitter } from 'node:events';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import type { SandboxDriver } from './driver.js';
import type { ScreenContent, RecordedAction } from '../types.js';

export class PlaywrightDriver implements SandboxDriver {
  readonly onUnexpectedExit = new EventEmitter();
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(
    private targetUrl: string,
    private options: {
      debounceMs?: number; // default 100ms
    } = {}
  ) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined,
    });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    await this.page.goto(this.targetUrl);
    await this.page.waitForLoadState('networkidle');
  }

  async captureScreen(): Promise<ScreenContent> {
    if (!this.page) {
      throw new Error('PlaywrightDriver is not started. Call start() first.');
    }

    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
      // Ignore timeout — proceed with current DOM state
    });

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

    const debounceMs = this.options.debounceMs ?? 100;

    switch (action.actionType) {
      case 'click':
        await this.page.click(action.selector!);
        break;
      case 'type':
        await this.page.fill(action.selector!, action.value ?? '');
        break;
      case 'keypress':
        await this.page.press(action.selector ?? 'body', action.value ?? 'Enter');
        break;
      case 'form_submit':
        await this.page.press(action.selector ?? 'form', 'Enter');
        break;
      case 'select':
        await this.page.selectOption(action.selector!, action.value ?? '');
        break;
      default: {
        const exhaustiveCheck: never = action.actionType;
        throw new Error(`Unknown action type: ${exhaustiveCheck}`);
      }
    }

    // Wait for network to settle after the action, with debounce
    await new Promise<void>((resolve) => setTimeout(resolve, debounceMs));
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
      // Ignore timeout — return current screen state
    });

    return this.captureScreen();
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
