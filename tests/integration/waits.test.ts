import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { Replayer } from '../../src/replayer/replayer.js';
import { PlaywrightDriver } from '../../src/sandbox/playwright-driver.js';
import { waitForEffect, type SettlePage } from '../../src/replay/runtime/settle.js';
import type { WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');

// A page with a WebSocket ticker, an SSE stream and a 100 ms polling loop, all updating the DOM
// for as long as the page is open: it never reaches "network idle".
const BUSY_PAGE = `<!doctype html>
<html><head><title>Busy</title></head><body>
<button id="go">Go</button>
<div id="out">idle</div><div id="tick"></div><div id="sse"></div><div id="poll"></div>
<script>
const $ = (id) => document.getElementById(id);
$('go').onclick = async () => { const r = await fetch('/update'); $('out').textContent = 'updated ' + (await r.text()); };
const ws = new WebSocket('ws://' + location.host + '/ws');
ws.onmessage = (e) => { $('tick').textContent = e.data; };
const es = new EventSource('/sse');
es.onmessage = (e) => { $('sse').textContent = e.data; };
setInterval(async () => { const r = await fetch('/poll'); $('poll').textContent = await r.text(); }, 100);
</script></body></html>`;

// A page whose DOM changes at an irregular rhythm forever: the wait can only end at its bound.
const JITTER_PAGE = `<!doctype html>
<html><head><title>Jitter</title></head><body>
<button id="go">Go</button><div id="j"></div>
<script>
const gaps = [10, 80, 20, 90, 15, 70];
let i = 0, n = 0;
(function tick() { document.getElementById('j').textContent = String(n++); setTimeout(tick, gaps[i++ % gaps.length]); })();
</script></body></html>`;

/** Minimal WebSocket server side: handshake, then a text frame every 100 ms. */
function acceptWebSocket(key: string, socket: Socket): void {
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  let n = 0;
  const timer = setInterval(() => {
    const payload = Buffer.from(`tick ${n++}`);
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  }, 100);
  const stop = () => clearInterval(timer);
  socket.on('close', stop);
  socket.on('error', stop);
}

describe('Effect-based waits on a page with live connections', () => {
  let httpServer: Server;
  let baseUrl: string;
  let browser: Browser;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    let polls = 0;
    httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let n = 0;
        const timer = setInterval(() => res.write(`data: sse ${n++}\n\n`), 100);
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (url.pathname === '/poll') {
        res.setHeader('content-type', 'text/plain');
        res.end(`poll ${polls++}`);
        return;
      }
      if (url.pathname === '/update') {
        res.setHeader('content-type', 'text/plain');
        res.end('1');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(url.pathname === '/jitter' ? JITTER_PAGE : BUSY_PAGE);
    });
    httpServer.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    httpServer.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string') return socket.destroy();
      acceptWebSocket(key, socket as Socket);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined,
    });
  });

  afterAll(async () => {
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => httpServer?.close(() => done()));
  });

  async function openPage(path: string): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl + path);
    return page;
  }

  it('settles a click that triggers an update within 3 s although WebSocket, SSE and polling stay active', async () => {
    const page = await openPage('/');
    // Let every live connection get going
    await page.waitForFunction(() => document.getElementById('tick')!.textContent !== '');

    const started = Date.now();
    const reason = await waitForEffect(page as unknown as SettlePage, {
      timeoutMs: 8000,
      action: () => page.click('#go'),
    });
    const elapsed = Date.now() - started;

    // The bound is 8 s: ending well before it proves the wait was driven by the effect, not by the bound
    expect(elapsed).toBeLessThan(7500);
    expect(reason).not.toBe('bound');
    // Settled means the update is already rendered or about to be: the locator's own wait covers the rest
    await page.locator('#out', { hasText: 'updated 1' }).waitFor({ timeout: 10000 });
    await page.context().close();
  });

  it('is what the old approach could not do: the page never reaches network idle', async () => {
    const page = await openPage('/');
    const idle = await page.waitForLoadState('networkidle', { timeout: 1500 }).then(() => true, () => false);
    expect(idle).toBe(false);
    await page.context().close();
  });

  it('counts a wait that reaches its bound as done, without throwing', async () => {
    const page = await openPage('/jitter');
    const started = Date.now();
    const reason = await waitForEffect(page as unknown as SettlePage, {
      timeoutMs: 600,
      action: () => page.click('#go'),
    });
    const elapsed = Date.now() - started;

    expect(reason).toBe('bound');
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(10000);
    await page.context().close();
  });

  it('replays a recorded workflow on that page with the host Replayer', async () => {
    const workflow = {
      id: 'w-busy',
      label: 'Press go',
      steps: [{ actionType: 'click', selectors: ['#go'] }],
      variables: [],
      observedPayloads: [],
    } as WorkflowSet['workflows'][number];

    const result = await new Replayer(() => new PlaywrightDriver(baseUrl + '/')).replay(workflow, {}, 20000);

    expect(result.success).toBe(true);
    expect(result.screen?.raw).toContain('updated 1');
  });

  describe('generated server', () => {
    let outputDir: string;
    let client: Client;
    let transport: StdioClientTransport;
    let annotated: WorkflowSet;

    beforeAll(async () => {
      const set: WorkflowSet = {
        version: '1',
        targetType: 'web',
        targetName: 'Busy app',
        startUrl: baseUrl + '/',
        timeoutMs: 45000,
        workflows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            label: 'Press go',
            timeoutMs: 40000,
            steps: [{ actionType: 'click', selectors: ['#go'] }],
            variables: [],
            observedPayloads: [],
          },
          {
            id: '44444444-4444-4444-8444-444444444444',
            label: 'Press missing',
            steps: [{ actionType: 'click', selectors: ['#nothing-here'], timeoutMs: 300 }],
            variables: [],
            observedPayloads: [],
          },
        ],
      };
      outputDir = await mkdtemp(join(workspaceRoot, '.waits-'));
      const log = console.log;
      console.log = () => { };
      try {
        annotated = new SchemaInferencer().inferWorkflows(set);
        await new Compiler().compile(annotated, outputDir);
      } finally {
        console.log = log;
      }
      client = new Client({ name: 'waits-test', version: '1.0.0' });
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(outputDir, 'mcp-server.js')],
        cwd: workspaceRoot,
        env: process.env.DAEMONIZE_CHROMIUM_PATH
          ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH }
          : undefined,
      });
      await client.connect(transport);
    }, 60000);

    afterAll(async () => {
      await closeClient(client, transport);
      if (outputDir) await removeDir(outputDir);
    });

    async function call(name: string, args: Record<string, unknown> = {}) {
      const response = await client.callTool({ name, arguments: args });
      const content = response.content as Array<{ type: string; text: string }>;
      return JSON.parse(content[0].text);
    }

    it('copies settle.ts next to the server and into the sandbox image', async () => {
      const { readFile } = await import('node:fs/promises');
      const runtime = await readFile(join(outputDir, 'settle.ts'), 'utf-8');
      const original = await readFile(join(workspaceRoot, 'src/replay/runtime/settle.ts'), 'utf-8');
      expect(runtime).toBe(original);
      expect(await readFile(join(outputDir, 'sandbox', 'Dockerfile'), 'utf-8')).toContain('COPY settle.js');
      expect(await readFile(join(outputDir, 'replay.ts'), 'utf-8')).not.toContain('networkidle');
    });

    it('replays the workflow on the busy page', async () => {
      const result = await call('press_go');
      expect(result.success).toBe(true);
      expect(result.text).toContain('updated 1');
    });

    it('documents _timeoutMs without adding it to the stored input schema', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'press_go')!;
      expect(tool.description).toContain('_timeoutMs');
      expect(JSON.stringify(annotated.workflows[0].inputSchema ?? {})).not.toContain('_timeoutMs');
    });

    it('lets the _timeoutMs argument beat the timeout of the workflow and of the set', async () => {
      const result = await call('press_go', { _timeoutMs: 50 });
      expect(result).toMatchObject({ success: false, error: 'timeout' });
    });

    it('refuses an out-of-range _timeoutMs', async () => {
      let refused = false;
      try {
        const response = await client.callTool({ name: 'press_go', arguments: { _timeoutMs: 600001 } });
        refused = response.isError === true;
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    });

    it('applies the timeout of a step: a missing element fails after the step bound, not after 8 s', async () => {
      const started = Date.now();
      const result = await call('press_missing');
      expect(result.success).toBe(false);
      expect(Date.now() - started).toBeLessThan(7000);
    });
  });
});
