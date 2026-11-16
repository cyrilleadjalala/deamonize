import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { errorResult, normalizePbtResult, summarizeVitestJson, clipText, type PbtRunResult } from './pbt-result.js';

/** Where the last result is kept, relative to the output directory. */
export const PBT_RESULT_FILE = join('.daemonize', 'pbt-result.json');
export const DEFAULT_PBT_TIMEOUT_MS = 120_000;

/** The last stored result of an output directory, or undefined when there is none or the file is not a result. */
export async function readPbtResult(outDir: string): Promise<PbtRunResult | undefined> {
  try {
    return normalizePbtResult(JSON.parse(await readFile(join(outDir, PBT_RESULT_FILE), 'utf-8')));
  } catch {
    return undefined;
  }
}

/** Path of the vitest entry point: the one the output directory resolves, else the one of this package. */
async function findVitest(outDir: string): Promise<string | undefined> {
  const candidates = [join(resolve(outDir), 'package.json'), import.meta.url];
  for (const from of candidates) {
    try {
      const entry = join(dirname(createRequire(from).resolve('vitest/package.json')), 'vitest.mjs');
      await access(entry);
      return entry;
    } catch {
      // Try the next place
    }
  }
  return undefined;
}

/** A child process and everything it started. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone
    }
  }
}

/** The environment of the test process: no secret and no model credential of the Studio's own environment. */
function testEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('DAEMONIZE_SECRET_') || name.startsWith('DAEMONIZE_MODEL_')) continue;
    env[name] = value;
  }
  return env;
}

/**
 * Run the generated property-based suite of an output directory (`vitest run` there) with a timeout, and store the
 * summary in `<out>/.daemonize/pbt-result.json`. Never rejects: a run that cannot happen is an `error` result.
 */
export async function runPbtSuite(outDir: string, options: { timeoutMs?: number } = {}): Promise<PbtRunResult> {
  const started = Date.now();
  const ranAt = new Date(started).toISOString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PBT_TIMEOUT_MS;
  let result: PbtRunResult;
  const tmp = await mkdtemp(join(tmpdir(), 'daemonize-pbt-'));
  try {
    result = await execute(outDir, tmp, timeoutMs, started, ranAt);
  } catch (err) {
    result = errorResult((err as Error).message, ranAt, Date.now() - started);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  await mkdir(join(outDir, '.daemonize'), { recursive: true });
  await writeFile(join(outDir, PBT_RESULT_FILE), JSON.stringify(result, null, 2));
  return result;
}

async function execute(outDir: string, tmp: string, timeoutMs: number, started: number, ranAt: string): Promise<PbtRunResult> {
  const vitest = await findVitest(outDir);
  if (vitest === undefined) return errorResult('vitest was not found: run "npm install" in the output directory', ranAt, 0);
  try {
    await access(join(outDir, 'tests'));
  } catch {
    return errorResult('the output directory has no tests folder: run "daemonize compile" first', ranAt, 0);
  }
  const reportFile = join(tmp, 'report.json');
  const root = resolve(outDir);
  const outcome = await new Promise<{ timedOut: boolean; stderr: string; code: number | null }>((done) => {
    const child = spawn(process.execPath, [vitest, 'run', '--root', root, '--reporter=json', `--outputFile=${reportFile}`], {
      cwd: root,
      env: testEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf-8')).slice(-2000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ timedOut, stderr: `${stderr}${err.message}`, code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ timedOut, stderr, code });
    });
  });
  const elapsed = Date.now() - started;
  if (outcome.timedOut) return errorResult(`the suite did not finish within ${Math.round(timeoutMs / 1000)} s`, ranAt, elapsed);
  let report: unknown;
  try {
    report = JSON.parse(await readFile(reportFile, 'utf-8'));
  } catch {
    return errorResult(`vitest produced no report (exit code ${outcome.code}): ${clipText(outcome.stderr.trim(), 300)}`, ranAt, elapsed);
  }
  return summarizeVitestJson(report, ranAt, elapsed);
}
