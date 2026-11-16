import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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
  }, 120000);

  afterAll(async () => {
    if (outDir) {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('contains the state graph schema next to the code that reads it', async () => {
    await expect(access(join(outDir, 'state', 'state-graph.schema.json'))).resolves.toBeUndefined();
  });

  it('contains the support modules copied into generated test suites', async () => {
    await expect(access(join(outDir, 'pbt', 'schema-arbitrary.js'))).resolves.toBeUndefined();
    await expect(access(join(outDir, 'pbt', 'property-runner.js'))).resolves.toBeUndefined();
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
  });
});
