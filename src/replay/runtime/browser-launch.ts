/**
 * Launches the browser of a generated replay: Playwright's Chromium, then Google Chrome, then Microsoft Edge.
 * Standalone: no imports. It is copied next to replay.js, which passes in the `chromium` of Playwright.
 * The chain mirrors src/recorder/browser-launcher.ts.
 */
export interface LaunchOptions {
  headless: boolean;
  executablePath?: string;
  channel?: 'chrome' | 'msedge';
  args?: string[];
}

export interface Launcher<B> {
  launch(options: LaunchOptions): Promise<B>;
}

const NOT_INSTALLED = [/executable doesn['\u2019]t exist/i, /Chromium distribution '(chrome|msedge)' is not found/i];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True only when Playwright says the executable or the chrome/msedge distribution does not exist. */
export function isBrowserMissing(error: unknown): boolean {
  const message = messageOf(error);
  return NOT_INSTALLED.some((pattern) => pattern.test(message));
}

export const NO_BROWSER_MESSAGE =
  'No browser was found to replay with. Install Google Chrome or Microsoft Edge, or set DAEMONIZE_CHROMIUM_PATH to the path of a Chromium based browser.';

const CHANNELS: Array<'chrome' | 'msedge' | undefined> = [undefined, 'chrome', 'msedge'];

export async function launchReplayBrowser<B>(launcher: Launcher<B>, env: NodeJS.ProcessEnv = process.env): Promise<B> {
  // Inside a container the container is the sandbox; Chromium's own cannot start there
  const args = env.DAEMONIZE_IN_CONTAINER ? ['--no-sandbox'] : [];
  const custom = env.DAEMONIZE_CHROMIUM_PATH;
  if (custom !== undefined && custom !== '') {
    return await launcher.launch({ headless: true, executablePath: custom, args });
  }
  for (const channel of CHANNELS) {
    try {
      return await launcher.launch({ headless: true, ...(channel === undefined ? {} : { channel }), args });
    } catch (error) {
      if (isBrowserMissing(error)) continue;
      throw error;
    }
  }
  throw new Error(NO_BROWSER_MESSAGE);
}
