import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment for a generated server started by a test. Without DAEMONIZE_DATA_DIR the server's vault reader falls back
 * to the per-user data folder (%LOCALAPPDATA%\Daemonize on Windows) and would pick up passwords the developer saved
 * in the real Studio. An empty folder per test file means: no vault, so only the variables the test sets count.
 */
export const ISOLATED_VAULT_ENV: { DAEMONIZE_DATA_DIR: string } = {
  DAEMONIZE_DATA_DIR: mkdtempSync(join(tmpdir(), 'daemonize-no-vault-')),
};