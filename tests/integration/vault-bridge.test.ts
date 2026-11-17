/**
 * Vault bridge, end to end (Requirement 10.6): a secret saved in the Studio for an application reaches a generated
 * server that Kiro starts with ONLY the environment of the written Server_Entry. The Studio runs with the `file` test
 * key provider (the memory provider cannot be shared with a separate process), a temporary App_Data_Dir and a fake
 * home folder. The real ~/.kiro is never touched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { deriveSlug } from '../../src/studio/app-names.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { rawRequest } from '../helpers/http.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import { scanForValues } from '../helpers/scan-artifacts.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const PASSWORD = 'bridge-pw-Zq83-4471';

const LOGIN_PAGE = `<!doctype html><html><head><title>Sign in</title></head><body>
<form method="post" action="/login">
<label for="user">Username</label><input id="user" name="user" type="text" autocomplete="off">
<label for="pw">Password</label><input id="pw" name="pw" type="password" autocomplete="off">
<button type="submit">Sign in</button></form></body></html>`;

describe('vault bridge: Studio vault, global install, generated server', () => {
  let base: string;
  let home: string;
  let outRoot: string;
  let appOut: string;
  let fixture: Server;
  let studio: StudioHandle;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  const received: Array<{ user: string | null; pw: string | null }> = [];
  let origin = '';

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await rawRequest(
      studio,
      method,
      path,
      {
        host: `127.0.0.1:${studio.port}`,
        'x-studio-token': studio.token,
        'x-studio-request': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body === undefined ? undefined : JSON.stringify(body)
    );
    return { status: res.status, text: res.text, json: res.text === '' ? undefined : (JSON.parse(res.text) as Record<string, any>) };
  };

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'vault-bridge-'));
    home = join(base, 'home');
    await mkdir(join(home, '.kiro'), { recursive: true });
    outRoot = join(base, 'project');
    await mkdir(join(outRoot, 'out'), { recursive: true });

    fixture = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/login') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          received.push({ user: form.get('user'), pw: form.get('pw') });
          const ok = form.get('pw') === PASSWORD;
          res.writeHead(ok ? 200 : 401, { 'content-type': 'text/html' });
          res.end(`<!doctype html><title>${ok ? 'Welcome' : 'Denied'}</title><body><p>${ok ? 'Welcome ada' : 'Wrong password'}</p></body>`);
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(LOGIN_PAGE);
    });
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

    const set = {
      version: '1',
      targetType: 'web',
      targetName: 'Bridge app',
      startUrl: `${origin}/`,
      workflows: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          label: 'Sign in',
          variables: [],
          observedPayloads: [{}],
          steps: [
            { actionType: 'type', selectors: ['#user'], value: 'ada' },
            { actionType: 'type', selectors: ['#pw'], secretRef: 'PASSWORD' },
            { actionType: 'click', selectors: ['button[type=submit]'] },
          ],
        },
      ],
    } as unknown as WorkflowSet;
    const workflowFile = join(outRoot, 'daemonize.workflows.json');
    await writeFile(workflowFile, serializeWorkflowSet(set));

    // The tool is built in its own folder next to `out`; give it the repository dependencies so the compile runs no npm install
    appOut = join(outRoot, deriveSlug({ origin }));
    await mkdir(appOut, { recursive: true });
    await symlink(join(workspaceRoot, 'node_modules'), join(appOut, 'node_modules'), 'junction');

    studio = await startStudio({
      workflowFile,
      outDir: join(outRoot, 'out'),
      home,
      env: {
        PATH: process.env.PATH,
        Path: process.env.Path,
        SystemRoot: process.env.SystemRoot,
        ...(process.env.DAEMONIZE_CHROMIUM_PATH ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH } : {}),
        DAEMONIZE_DATA_DIR: join(base, 'appdata'),
        DAEMONIZE_VAULT_KEY_PROVIDER: 'file',
      },
    });
  });

  afterAll(async () => {
    await closeClient(client, transport);
    await studio?.close();
    fixture?.closeAllConnections();
    await new Promise<void>((done) => fixture?.close(() => done()));
    if (base) await removeDir(base);
  });

  it('saves the secret for the application, compiles, installs globally and the server logs in from the vault', async () => {
    // (a) save in Credentials, for this application
    const saved = await api('POST', '/api/secrets', { name: 'PASSWORD', value: PASSWORD, application: origin });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json).toEqual({ name: 'PASSWORD', configured: true });

    // (b) compile the Action into the per-application folder
    expect((await api('POST', '/api/compile')).status).toBe(202);
    let status = await api('GET', '/api/compile/status');
    for (let i = 0; i < 1200 && status.json?.state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      status = await api('GET', '/api/compile/status');
    }
    expect(status.json, status.text).toEqual({ state: 'done', phase: null });
    const mcpServer = join(appOut, 'mcp-server.js');
    await readFile(mcpServer);

    // (c) install for all projects into the fake home
    const preview = await api('POST', '/api/power/preview', { scope: 'global' });
    expect(preview.status, preview.text).toBe(200);
    expect(preview.json?.placeholders).toEqual([]);
    const installed = await api('POST', '/api/power/install', { confirmationId: preview.json?.confirmationId, kiroPath: preview.json?.kiroPath, scope: 'global' });
    expect(installed.status, installed.text).toBe(200);
    expect(installed.json?.missingSecrets).toEqual([]);

    const mcpText = await readFile(join(home, '.kiro', 'settings', 'mcp.json'), 'utf-8');
    const servers = (JSON.parse(mcpText) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }).mcpServers;
    const entry = Object.values(servers)[0];
    // The secret is in the vault, so the Server_Entry has no placeholder (or any key) for it
    expect(Object.keys(entry.env).filter((k) => k.startsWith('DAEMONIZE_SECRET_'))).toEqual([]);
    expect(mcpText).not.toContain('DAEMONIZE_SECRET_');
    expect(entry.env.DAEMONIZE_APP_KEY).toBe(origin);

    // (d) start the server the way Kiro does: only the env of the entry, plus these test-only extras
    transport = new StdioClientTransport({
      command: process.execPath, // the entry says `node`; the test uses this very node so PATH lookup is not needed
      args: entry.args,
      cwd: workspaceRoot,
      env: {
        ...entry.env,
        // Test-only selectors: the key provider `file` is honoured only under NODE_ENV=test
        NODE_ENV: 'test',
        DAEMONIZE_VAULT_KEY_PROVIDER: 'file',
        // Needed to run a browser and child processes on this machine, not secrets
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
        ...(process.env.DAEMONIZE_CHROMIUM_PATH ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH } : {}),
      },
    });
    expect(entry.args.map((a) => resolve(a))).toContain(resolve(mcpServer));
    client = new Client({ name: 'vault-bridge-test', version: '1.0.0' });
    await client.connect(transport);

    // (e) call the tool
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBe(1);
    const response = await client.callTool({ name: tools[0].name, arguments: {} });
    const content = response.content as Array<{ text: string }>;
    const result = JSON.parse(content[0].text) as Record<string, any>;
    expect(result.error, content[0].text).not.toBe('missing_secret');
    expect(result.success, content[0].text).toBe(true);
    expect(result.text).toContain('Welcome ada');
    // The password typed into the page is the one of the vault
    expect(received).toEqual([{ user: 'ada', pw: PASSWORD }]);

    // No value in the answer, the listing, or any file of the fake home and of the output folder (node_modules skipped)
    expect(content[0].text + JSON.stringify(tools)).not.toContain(PASSWORD);
    expect(await scanForValues(home, [PASSWORD])).toEqual([]);
    expect(await scanForValues(appOut, [PASSWORD])).toEqual([]);
    expect(await scanForValues(join(outRoot, 'out'), [PASSWORD])).toEqual([]);
    expect(await scanForValues(outRoot, [PASSWORD])).toEqual([]);
  });
});
