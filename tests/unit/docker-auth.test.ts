import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Compiler } from '../../src/compiler/compiler.js';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const SECRET_VALUE = 'S3cr3t-Value-9f8e7d6c5b4a';
const STATE_MARKER = 'COOKIE-MARKER-1a2b3c4d5e6f';

const set: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: 'Docker Auth',
  startUrl: 'http://localhost:8080/',
  storageState: 'auth-state.json',
  workflows: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      label: 'Sign in',
      steps: [
        { actionType: 'type', selectors: ['#user'], variable: 'user' },
        { actionType: 'type', selectors: ['#pw'], secretRef: 'DB_PASSWORD' },
        { actionType: 'type', selectors: ['#pw2'], secretRef: 'DB_PASSWORD' },
      ],
      variables: [{ name: 'user' }],
      observedPayloads: [{ user: 'ada' }],
    },
  ],
};

describe('Docker authentication handling', () => {
  describe('.dockerignore and Dockerfile', () => {
    it('excludes state files, env files, auth files, assets and workflow files, and never copies them', () => {
      for (const target of [set, { ...set, targetType: 'tui' as const, startUrl: undefined, startCommand: ['x'] }]) {
        const { dockerfile, dockerignore } = new McpGenerator().generateSandboxFiles(target);
        const lines = dockerignore.split('\n');
        for (const pattern of ['*.json', '**/*storage*', '**/.env*', '**/auth*', '**/.daemonize', '**/*.assets', 'node_modules']) {
          expect(lines).toContain(pattern);
        }
        expect(lines).toContain('!sandbox/package.json');
        for (const line of dockerfile.split('\n').filter((l) => /^(COPY|ADD)\b/.test(l))) {
          expect(line).not.toMatch(/storage|state\.json|\.env|auth|\*|\.\s*$/i);
        }
      }
    });
  });

  describe('docker run arguments', () => {
    let dir: string;
    let mod: { buildDockerArgs: (o: any) => string[]; replayInDocker: (...a: any[]) => Promise<any> };

    beforeAll(async () => {
      dir = await mkdtemp(join(workspaceRoot, '.docker-auth-unit-'));
      const log = console.log;
      console.log = () => { };
      try {
        await new Compiler().compile(set, dir);
      } finally {
        console.log = log;
      }
      mod = await import(/* @vite-ignore */ pathToFileURL(join(dir, 'docker-replay.js')).href);
    });

    afterAll(async () => {
      if (dir) await removeDir(dir);
    });

    it('names secrets without a value and mounts the saved login read-only', () => {
      process.env.DAEMONIZE_SECRET_DB_PASSWORD = SECRET_VALUE;
      try {
        const statePath = join(dir, 'auth-state.json');
        const args = mod.buildDockerArgs({ name: 'daemonize-x', timeoutEnv: [], steps: set.workflows[0].steps, storagePath: statePath });

        // The name only, as its own argument, once
        expect(args.filter((a) => a === 'DAEMONIZE_SECRET_DB_PASSWORD')).toHaveLength(1);
        expect(args[args.indexOf('DAEMONIZE_SECRET_DB_PASSWORD') - 1]).toBe('-e');
        for (const arg of args) {
          expect(arg).not.toContain(SECRET_VALUE);
          expect(arg).not.toMatch(/^DAEMONIZE_SECRET_\w+=/);
        }
        expect(args).toContain(`${statePath}:/run/daemonize/storage-state.json:ro`);
        expect(args).toContain('DAEMONIZE_STORAGE_STATE=/run/daemonize/storage-state.json');
        expect(args.join(' ')).not.toContain(STATE_MARKER);
      } finally {
        delete process.env.DAEMONIZE_SECRET_DB_PASSWORD;
      }
    });

    it('does not mount anything when there is no saved login', () => {
      const args = mod.buildDockerArgs({ name: 'daemonize-x', timeoutEnv: [], steps: [] });
      expect(args.join(' ')).not.toContain('storage-state');
    });

    it('reports a missing saved login with its path, before any container starts', async () => {
      process.env.DAEMONIZE_SECRET_DB_PASSWORD = SECRET_VALUE;
      try {
        const result = await mod.replayInDocker(set.workflows[0].steps, { user: 'ada' });
        expect(result).toMatchObject({ success: false, error: 'storage_state_missing', failure: { path: join(dir, 'auth-state.json') } });
        expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
      } finally {
        delete process.env.DAEMONIZE_SECRET_DB_PASSWORD;
      }
    });

    it('lets DAEMONIZE_STORAGE_STATE on the host override the recorded path', async () => {
      process.env.DAEMONIZE_SECRET_DB_PASSWORD = SECRET_VALUE;
      process.env.DAEMONIZE_STORAGE_STATE = join(dir, 'elsewhere.json');
      try {
        const result = await mod.replayInDocker(set.workflows[0].steps, { user: 'ada' });
        expect(result).toMatchObject({ error: 'storage_state_missing', failure: { path: join(dir, 'elsewhere.json') } });
      } finally {
        delete process.env.DAEMONIZE_SECRET_DB_PASSWORD;
        delete process.env.DAEMONIZE_STORAGE_STATE;
      }
    });
  });
});
