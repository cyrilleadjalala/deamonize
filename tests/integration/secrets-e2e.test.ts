/**
 * Secrets end to end (requirement 16): a login page that only accepts the right password and the
 * current TOTP code. The workflow is recorded with other values typed (never stored), compiled, and
 * called over MCP with `DAEMONIZE_SECRET_*` in the environment of the server only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { record } from '../../src/cli/commands/record.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { totp } from '../../src/replay/runtime/totp.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import { scanForValues } from '../helpers/scan-artifacts.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');

const PASSWORD = 'Tr0ub4dor&3-xyzzy';
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const RECORDED_PASSWORD = 'typed-while-recording-pw';
const RECORDED_CODE = '424242';
const COOKIE_VALUE = 'cookie-value-5f1d9c77a0b34e2e';

const STEP_MS = 30_000;

describe('secrets: TOTP, resolution at run time and no leak', () => {
  let httpServer: Server;
  let baseUrl: string;
  let buttonLabel = 'Sign in';
  let pageViews = 0;
  let logins = 0;
  const dirs: string[] = [];
  const open: Array<{ client: Client; transport: StdioClientTransport }> = [];
  let work: string;
  let outputDir: string;
  let workflowFile: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.method === 'POST' && url.pathname === '/login') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          logins += 1;
          const form = new URLSearchParams(body);
          const now = Date.now();
          const codes = [totp(SEED, { timeMs: now }), totp(SEED, { timeMs: now - STEP_MS })];
          const ok = form.get('pass') === PASSWORD && codes.includes(form.get('otp') ?? '');
          res.end(`<!doctype html><title>${ok ? 'Welcome' : 'Denied'}</title><body><p>${ok ? `Welcome ${form.get('user')}` : 'Login failed'}</p></body>`);
        });
        return;
      }
      pageViews += 1;
      res.end(`<!doctype html><html><head><title>Sign in</title></head><body>
<form method="post" action="/login">
  <label for="user">Username</label><input id="user" name="user" />
  <label for="pass">Password</label><input id="pass" name="pass" type="password" />
  <label for="code">Verification code</label><input id="code" name="otp" autocomplete="one-time-code" />
  ${buttonLabel === 'Sign in' ? '<button type="submit">Sign in</button>' : '<div>Log in</div>'}
</form></body></html>`);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;

    work = await mkdtemp(join(tmpdir(), 'daemonize-secrets-'));
    dirs.push(work);
    workflowFile = join(work, 'workflows.json');
    await record({
      url: baseUrl,
      name: 'login-app',
      label: 'Sign in with a one-time code',
      out: workflowFile,
      headless: true,
      drive: async (page) => {
        await page.locator('#user').click();
        await page.keyboard.type('ada');
        await page.locator('#pass').click();
        await page.keyboard.type(RECORDED_PASSWORD);
        await page.locator('#code').click();
        await page.keyboard.type(RECORDED_CODE);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.waitForTimeout(400);
      },
    });

    const set = deserializeWorkflowSet(readFileSync(workflowFile, 'utf8'));
    // Under the workspace so the generated server finds its dependencies in node_modules
    outputDir = await mkdtemp(join(workspaceRoot, '.secrets-'));
    dirs.push(outputDir);
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), outputDir);
    } finally {
      console.log = log;
    }
  });

  afterAll(async () => {
    for (const { client, transport } of open) await closeClient(client, transport);
    httpServer?.closeAllConnections();
    await new Promise<void>((done) => httpServer?.close(() => done()));
    for (const dir of dirs) await removeDir(dir);
  }, 60000);

  async function connect(env: Record<string, string>): Promise<{ client: Client; tool: string; call: () => Promise<Record<string, any>>; listing: string }> {
    const client = new Client({ name: 'secrets-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(outputDir, 'mcp-server.js')],
      cwd: workspaceRoot,
      env: {
        DAEMONIZE_STEP_TIMEOUT_MS: '3000',
        ...(process.env.DAEMONIZE_CHROMIUM_PATH ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH } : {}),
        ...env,
      },
    });
    await client.connect(transport);
    open.push({ client, transport });
    const tools = (await client.listTools()).tools;
    const tool = tools[0].name;
    return {
      client,
      tool,
      listing: JSON.stringify(tools),
      async call() {
        const response = await client.callTool({ name: tool, arguments: {} });
        const content = response.content as Array<{ text: string }>;
        return JSON.parse(content[0].text);
      },
    };
  }

  it('records only the names: the typed values are stored nowhere', () => {
    const json = readFileSync(workflowFile, 'utf8');
    for (const typed of [RECORDED_PASSWORD, RECORDED_CODE]) expect(json).not.toContain(typed);
    const workflow = JSON.parse(json).workflows[0];
    expect(workflow.steps.map((s: any) => [s.actionType, s.secretRef ?? null, s.totp ?? null, s.value ?? null])).toEqual([
      ['type', null, null, 'ada'],
      ['type', 'PASSWORD', null, null],
      ['type', 'OTP', true, null],
      ['click', null, null, null],
    ]);
    expect(workflow.secrets).toEqual([
      { name: 'PASSWORD', kind: 'password' },
      { name: 'OTP', kind: 'totp' },
    ]);
  });

  it('lists the variables by name in the tool description, SKILL.md and mcp.json placeholders', async () => {
    const mcp = JSON.parse(readFileSync(join(outputDir, 'mcp.json'), 'utf8'));
    const env = Object.values(mcp.mcpServers as Record<string, { env: Record<string, string> }>)[0].env;
    expect(env).toEqual({
      DAEMONIZE_SECRET_OTP: '${DAEMONIZE_SECRET_OTP}',
      DAEMONIZE_SECRET_PASSWORD: '${DAEMONIZE_SECRET_PASSWORD}',
    });
    const skill = readFileSync(join(outputDir, 'skills', Object.keys(mcp.mcpServers)[0], 'SKILL.md'), 'utf8');
    expect(skill).toContain('DAEMONIZE_SECRET_PASSWORD');
    expect(skill).toContain('DAEMONIZE_SECRET_OTP');

    const server = await connect({});
    expect(server.listing).toContain('DAEMONIZE_SECRET_PASSWORD');
    expect(server.listing).toContain('DAEMONIZE_SECRET_OTP');
  });

  it('logs in with the password and the current TOTP code taken from the environment', async () => {
    const server = await connect({ DAEMONIZE_SECRET_PASSWORD: PASSWORD, DAEMONIZE_SECRET_OTP: SEED });
    const before = logins;
    const result = await server.call();
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.text).toContain('Welcome ada');
    expect(logins).toBe(before + 1);
    // Whatever the server returns, it holds no secret
    const serialized = JSON.stringify(result) + server.listing;
    for (const value of [PASSWORD, SEED, totp(SEED), RECORDED_PASSWORD]) expect(serialized).not.toContain(value);
  });

  it('returns missing_secret naming the variable, before any step runs', async () => {
    const server = await connect({});
    const views = pageViews;
    const attempts = logins;
    const result = await server.call();
    expect(result).toMatchObject({ success: false, error: 'missing_secret' });
    expect(result.failure.missingSecret).toBe('DAEMONIZE_SECRET_PASSWORD');
    expect(result.failure.missing).toEqual(['DAEMONIZE_SECRET_PASSWORD', 'DAEMONIZE_SECRET_OTP']);
    expect(pageViews).toBe(views);
    expect(logins).toBe(attempts);

    const partial = await (await connect({ DAEMONIZE_SECRET_PASSWORD: PASSWORD })).call();
    expect(partial).toMatchObject({ success: false, error: 'missing_secret', failure: { missingSecret: 'DAEMONIZE_SECRET_OTP' } });
    expect(JSON.stringify(partial)).not.toContain(PASSWORD);
  });

  it('does not log in with a wrong password, and reports nothing secret', async () => {
    const wrong = 'not-the-password-123';
    const server = await connect({ DAEMONIZE_SECRET_PASSWORD: wrong, DAEMONIZE_SECRET_OTP: SEED });
    const result = await server.call();
    expect(result.text).toContain('Login failed');
    expect(JSON.stringify(result)).not.toContain(wrong);
  });

  it('keeps the values out of a strict failure and of its screenshot', async () => {
    buttonLabel = 'Log in';
    try {
      const server = await connect({ DAEMONIZE_SECRET_PASSWORD: PASSWORD, DAEMONIZE_SECRET_OTP: SEED });
      const result = await server.call();
      expect(result).toMatchObject({ success: false, error: 'step_failed' });
      expect(result.failure.stepIndex).toBe(3);
      expect(result.failure.screenshot).toMatch(/\.png$/);
      expect(existsSync(result.failure.screenshot)).toBe(true);

      const code = totp(SEED);
      const serialized = JSON.stringify(result);
      for (const value of [PASSWORD, SEED, code]) expect(serialized).not.toContain(value);

      // The picture of the page: its bytes and metadata hold no value either
      const shots = await mkdtemp(join(tmpdir(), 'daemonize-shot-'));
      dirs.push(shots);
      await copyFile(result.failure.screenshot, join(shots, 'failure.png'));
      expect(await scanForValues(shots, [PASSWORD, SEED, code])).toEqual([]);
    } finally {
      buttonLabel = 'Sign in';
    }
  });

  it('writes no secret anywhere in the workflow file or the compiled output', async () => {
    const values = [PASSWORD, SEED, RECORDED_PASSWORD, RECORDED_CODE];
    expect(await scanForValues(work, values)).toEqual([]);
    expect(await scanForValues(outputDir, values)).toEqual([]);
  });

  it('references a storageState by path only: its cookie values are never copied', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'daemonize-state-'));
    dirs.push(stateDir);
    const statePath = join(stateDir, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify({
        cookies: [
          { name: 'session', value: COOKIE_VALUE, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
        ],
        origins: [],
      })
    );

    const outDir = await mkdtemp(join(tmpdir(), 'daemonize-state-out-'));
    dirs.push(outDir);
    const out = join(outDir, 'workflows.json');
    await record({
      url: baseUrl,
      name: 'login-app',
      label: 'Open the sign in page',
      out,
      storageState: statePath,
      headless: true,
      drive: async (page) => {
        await page.locator('#user').click();
        await page.keyboard.type('ada');
        await page.locator('#pass').click();
        await page.waitForTimeout(300);
      },
    });

    const set = deserializeWorkflowSet(readFileSync(out, 'utf8'));
    expect(set.storageState).toBe(statePath);

    const compiled = await mkdtemp(join(outDir, 'compiled-'));
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), compiled);
    } finally {
      console.log = log;
    }
    expect(await scanForValues(outDir, [COOKIE_VALUE])).toEqual([]);
    // The path itself is the only trace of the state
    expect(readFileSync(join(compiled, 'replay.ts'), 'utf8')).toContain(JSON.stringify(statePath));
  });
});
