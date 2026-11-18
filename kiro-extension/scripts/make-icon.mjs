// Turns media/icon.svg into media/icon.png (256 x 256: the Marketplace asks for at least 128 x 128 and
// does not accept an SVG icon). Development only: it uses the Playwright of the repository root, so
// nothing is added to the packaged extension. Run it with `npm run icon` after changing the SVG.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const media = join(dirname(fileURLToPath(import.meta.url)), '..', 'media');
const svg = await readFile(join(media, 'icon.svg'), 'utf8');

const browser = await chromium.launch({ executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const png = await page.locator('svg').screenshot({ omitBackground: true });
  await writeFile(join(media, 'icon.png'), png);
  console.log(`wrote media/icon.png (${png.length} bytes)`);
} finally {
  await browser.close();
}
