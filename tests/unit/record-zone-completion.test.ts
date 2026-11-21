import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { completeRecording, type CompletionContext } from '../../src/cli/commands/record.js';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { removeDir } from '../helpers/cleanup.js';
import type { ResultZone } from '../../src/types.js';

describe('completeRecording keeps what the recorder stored in the result zone', () => {
  let browser: Browser;
  let page: Page;
  let dir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
    page = await browser.newPage();
    await page.setContent('<main><ul class="hits"><li>Ada</li><li>Alan</li></ul></main>');
    // the in-page helpers used to suggest a kind are installed by the recorder
    const live = new LiveRecorder(page, new WorkflowRecorder('Helpers'), {});
    await live.attach();
    dir = await mkdtemp(join(tmpdir(), 'daemonize-zone-complete-'));
  });

  afterAll(async () => {
    await browser?.close();
    if (dir) await removeDir(dir);
  });

  async function complete(name: string, marked: ResultZone): Promise<ResultZone | undefined> {
    const out = join(dir, `${name}.workflows.json`);
    const recorder = new WorkflowRecorder(name);
    recorder.addStep({ actionType: 'click', selectors: ['#b'], label: 'click' });
    const context: CompletionContext = {
      options: { out },
      page,
      live: { stepCount: 1, idle: async () => { }, finalizeNetwork: async () => [], resultZone: marked },
      recorder,
      target: { targetType: 'web', name: 'app', startUrl: 'http://x/' },
    };
    await completeRecording(context);
    const set = deserializeWorkflowSet(await readFile(out, 'utf-8'));
    return set.workflows[0].resultZone;
  }

  it('saves selectors and fingerprint with the checked zone', async () => {
    const saved = await complete('with', {
      selector: 'ul.hits',
      selectors: ['ul.hits', 'main > ul'],
      fingerprint: { tag: 'ul', kind: 'list', count: 2 },
      extractor: { kind: 'list' } as ResultZone['extractor'],
    });
    expect(saved).toMatchObject({
      selector: 'ul.hits',
      selectors: ['ul.hits', 'main > ul'],
      fingerprint: { tag: 'ul', kind: 'list', count: 2 },
      extractor: { kind: 'list' },
    });
    expect(saved?.schema).toBeDefined();
  });

  it('saves a zone without them exactly as before', async () => {
    const saved = await complete('without', { selector: 'ul.hits', extractor: { kind: 'list' } as ResultZone['extractor'] });
    expect(Object.keys(saved!).sort()).toEqual(['extractor', 'schema', 'selector']);
  });
});
