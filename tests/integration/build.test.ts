import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 120000 });
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');

describe('Build output (what `npm run build` produces)', () => {
  let outDir: string;

  beforeAll(async () => {
    // Under the workspace so the built files find node_modules
    outDir = await mkdtemp(join(workspaceRoot, '.build-check-'));
    execFileSync(process.execPath, [join(workspaceRoot, 'node_modules/typescript/bin/tsc'), '--outDir', outDir], {
      cwd: workspaceRoot,
      stdio: 'pipe',
    });
    // The second half of `npm run build`: tsc emits no static files
    execFileSync(process.execPath, [join(workspaceRoot, 'scripts/copy-studio-ui.mjs'), outDir], { cwd: workspaceRoot, stdio: 'pipe' });
  }, 120000);

  afterAll(async () => {
    if (outDir) {
      await removeDir(outDir);
    }
  });

  it('contains the state graph schema next to the code that reads it', async () => {
    await expect(access(join(outDir, 'state', 'state-graph.schema.json'))).resolves.toBeUndefined();
  });

  it('contains the support modules copied into generated test suites', async () => {
    await expect(access(join(outDir, 'pbt', 'schema-arbitrary.js'))).resolves.toBeUndefined();
    await expect(access(join(outDir, 'pbt', 'property-runner.js'))).resolves.toBeUndefined();
  });

  it('contains the Studio UI next to the compiled Studio server', async () => {
    for (const file of ['index.html', 'app.css', 'app.js', 'js/dom.js', 'js/views/graph.js']) {
      await expect(access(join(outDir, 'studio', 'ui', file)), file).resolves.toBeUndefined();
    }
    const scripts = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf-8')).scripts as Record<string, string>;
    expect(scripts.build).toContain('copy-studio-ui');
  });

  it('starts the CLI and lists its commands', () => {
    const run = spawnSync(process.execPath, [join(outDir, 'cli', 'index.js'), '--help'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
    });

    expect(run.status, run.stderr).toBe(0);
    for (const command of ['record', 'compile', 'merge', 'serve']) {
      expect(run.stdout).toContain(command);
    }
  }, 60000); // the CLI imports Playwright, node-pty and others at start: slow when the whole suite runs in parallel
});
