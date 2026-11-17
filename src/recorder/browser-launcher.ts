/** Launches the browser of a recording: Playwright's Chromium, then Google Chrome, then Microsoft Edge. */
import { chromium, type Browser } from 'playwright';

export type BrowserUsed = 'chromium' | 'chrome' | 'msedge' | 'custom';
export type LaunchFn = (options: { headless: boolean; executablePath?: string; channel?: 'chrome' | 'msedge' }) => Promise<Browser>;
export interface LaunchedBrowser {
  browser: Browser;
  used: BrowserUsed;
  label: string;
}
export class BrowserLaunchError extends Error {
  readonly used?: BrowserUsed;
  constructor(message: string, used?: BrowserUsed, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BrowserLaunchError';
    this.used = used;
  }
}

const NOT_INSTALLED = [/executable doesn['\u2019]t exist/i, /Chromium distribution '(chrome|msedge)' is not found/i];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True only when Playwright says the executable or the chrome/msedge distribution does not exist. */
export function isNotInstalled(error: unknown): boolean {
  const message = messageOf(error);
  return NOT_INSTALLED.some((pattern) => pattern.test(message));
}

/** First line of the Playwright message, without colors, at most 200 characters (drops the ASCII box). */
function cause(error: unknown): string {
  // eslint-disable-next-line no-control-regex
  const plain = messageOf(error).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const first = plain.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const line = first.trim();
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

const ATTEMPTS: Array<{ used: 'chromium' | 'chrome' | 'msedge'; label: string; channel?: 'chrome' | 'msedge' }> = [
  { used: 'chromium', label: 'Chromium' },
  { used: 'chrome', label: 'Google Chrome', channel: 'chrome' },
  { used: 'msedge', label: 'Microsoft Edge', channel: 'msedge' },
];

const defaultLaunch: LaunchFn = (options) => chromium.launch(options);

export async function launchBrowser(options: { headless?: boolean; env?: NodeJS.ProcessEnv; launch?: LaunchFn } = {}): Promise<LaunchedBrowser> {
  const headless = options.headless ?? false;
  const env = options.env ?? process.env;
  const launch = options.launch ?? defaultLaunch;

  const custom = env.DAEMONIZE_CHROMIUM_PATH;
  if (custom !== undefined && custom !== '') {
    try {
      const browser = await launch({ headless, executablePath: custom });
      return { browser, used: 'custom', label: custom };
    } catch (error) {
      throw new BrowserLaunchError(
        `The browser set in DAEMONIZE_CHROMIUM_PATH (${custom}) could not be started: ${cause(error)}`,
        'custom',
        { cause: error }
      );
    }
  }

  for (const attempt of ATTEMPTS) {
    try {
      const browser = await launch({ headless, ...(attempt.channel === undefined ? {} : { channel: attempt.channel }) });
      return { browser, used: attempt.used, label: attempt.label };
    } catch (error) {
      if (isNotInstalled(error)) continue;
      throw new BrowserLaunchError(`${attempt.label} could not be started: ${cause(error)}`, attempt.used, { cause: error });
    }
  }
  throw new BrowserLaunchError(
    'No browser was found to record with. Install Google Chrome or Microsoft Edge, or set DAEMONIZE_CHROMIUM_PATH to the path of a Chromium based browser.'
  );
}
