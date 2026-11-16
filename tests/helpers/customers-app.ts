/**
 * A small single-page application with a JSON API, shared by the Level 1 tests: the page needs a session
 * cookie and sends a bearer token; the API refuses a request that lacks either. It also has a server-rendered form
 * (no fetch/XHR), analytics noise and a polling call that a recording must ignore.
 *
 * Switches let a test break what only a direct request (not the page's own script) sees:
 *  - `changeApiForDirect`: the search answers with another shape;
 *  - `failCreate`: creating a customer answers 500.
 * Counters say how many requests of each kind reached the server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import type { Workflow } from '../../src/types.js';

export const COOKIE_VALUE = 'SESSIONCOOKIE-9f8e7d6c5b4a';
export const BEARER = 'test-token-abcdef1234567890';

export const SPA = `<!doctype html>
<html><head><title>Customers</title></head>
<body>
  <h1>Customers</h1>
  <label for="q">Search</label><input id="q" />
  <button id="search" type="button">Search</button>
  <table><tbody id="rows"></tbody></table>
  <label for="cname">Customer name</label><input id="cname" />
  <label for="cemail">Customer email</label><input id="cemail" />
  <button id="add" type="button">Add customer</button>
  <form method="post" action="/ssr/customers">
    <label for="ssr">SSR name</label><input id="ssr" name="name" />
    <button type="submit">Save SSR</button>
  </form>
<script>
  const headers = { authorization: 'Bearer ${BEARER}', 'content-type': 'application/json' };
  const $ = (id) => document.getElementById(id);
  async function api(path, init = {}) {
    const response = await fetch(path, { ...init, headers });
    return response.json();
  }
  function render(list) {
    $('rows').innerHTML = list.map((c) =>
      '<tr><td>' + c.id + '</td><td>' + c.name + '</td><td><button type="button" data-id="' + c.id + '">Delete</button></td></tr>').join('');
  }
  async function load(q) { render((await api('/api/customers?q=' + encodeURIComponent(q))).customers); }
  function noise() {
    navigator.sendBeacon('/analytics/collect', 'x');
    fetch('/analytics/collect', { method: 'POST', body: '{}' });
    fetch('/static/icon.png');
  }
  $('search').onclick = async () => { noise(); await load($('q').value); };
  $('add').onclick = async () => {
    noise();
    await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: $('cname').value, email: $('cemail').value }) });
    await load('');
  };
  $('rows').onclick = async (e) => {
    const id = e.target.dataset && e.target.dataset.id;
    if (!id) return;
    noise();
    await api('/api/customers/' + id, { method: 'DELETE' });
    await load('');
  };
  setInterval(() => fetch('/api/health', { headers }), 200);
  load('');
</script>
</body></html>`;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

export interface Customer {
  id: number;
  name: string;
  email: string;
}

export interface CustomersApp {
  baseUrl: string;
  customers: Customer[];
  /** Page loads of `/`. */
  pageViews: number;
  /** Requests to the API that did not come from a browser (no Mozilla user agent), by kind. */
  direct: { search: number; create: number; remove: number };
  /** Same requests, whoever sent them. */
  total: { search: number; create: number; remove: number };
  changeApiForDirect: boolean;
  failCreate: boolean;
  /** Back to the two initial customers and zeroed counters. */
  reset(): void;
  close(): Promise<void>;
}

const initial = (): Customer[] => [
  { id: 1, name: 'Ada', email: 'ada@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
];

export async function startCustomersApp(): Promise<CustomersApp> {
  const app: CustomersApp = {
    baseUrl: '',
    customers: initial(),
    pageViews: 0,
    direct: { search: 0, create: 0, remove: 0 },
    total: { search: 0, create: 0, remove: 0 },
    changeApiForDirect: false,
    failCreate: false,
    reset() {
      app.customers.splice(0, app.customers.length, ...initial());
      app.pageViews = 0;
      app.direct = { search: 0, create: 0, remove: 0 };
      app.total = { search: 0, create: 0, remove: 0 };
      app.changeApiForDirect = false;
      app.failCreate = false;
    },
    close: async () => undefined,
  };

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/') {
      app.pageViews += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(SPA);
      return;
    }
    if (url.pathname === '/static/icon.png' || url.pathname.startsWith('/analytics/')) {
      res.writeHead(200, { 'content-type': url.pathname.endsWith('.png') ? 'image/png' : 'application/json' });
      res.end(url.pathname.endsWith('.png') ? Buffer.from('89504e47', 'hex') : '{}');
      return;
    }
    const body = await readBody(req);
    // Everything else needs the session cookie and the bearer token
    // The API wants both; the server-rendered form (a plain browser POST) only the cookie
    const bearerOk = !url.pathname.startsWith('/api/') || req.headers.authorization === `Bearer ${BEARER}`;
    if (!(req.headers.cookie ?? '').includes(`sid=${COOKIE_VALUE}`) || !bearerOk) {
      json(401, { error: 'unauthorized' });
      return;
    }
    const direct = !/Mozilla/.test(req.headers['user-agent'] ?? '');
    if (url.pathname === '/api/health') return json(200, { ok: true });
    if (url.pathname === '/api/customers' && req.method === 'GET') {
      app.total.search += 1;
      if (direct) app.direct.search += 1;
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const list = app.customers.filter((c) => c.name.toLowerCase().includes(q));
      if (direct && app.changeApiForDirect) return json(200, { results: list });
      return json(200, { customers: list, total: list.length });
    }
    if (url.pathname === '/api/customers' && req.method === 'POST') {
      app.total.create += 1;
      if (direct) app.direct.create += 1;
      if (app.failCreate) return json(500, { error: 'boom' });
      const input = JSON.parse(body) as { name: string; email: string };
      const created = { id: Math.max(0, ...app.customers.map((c) => c.id)) + 1, ...input };
      app.customers.push(created);
      return json(201, created);
    }
    const match = /^\/api\/customers\/(\d+)$/.exec(url.pathname);
    if (match && req.method === 'DELETE') {
      app.total.remove += 1;
      if (direct) app.direct.remove += 1;
      const index = app.customers.findIndex((c) => c.id === Number(match[1]));
      if (index >= 0) app.customers.splice(index, 1);
      return json(200, { deleted: true });
    }
    if (url.pathname === '/ssr/customers' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head><title>Saved</title></head><body><p>Saved ${new URLSearchParams(body).get('name')}</p></body></html>`);
      return;
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  app.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  return app;
}

/** A Playwright storage state holding the session cookie of the application. */
export function sessionStorageState(baseUrl: string): { cookies: Array<Record<string, unknown>>; origins: unknown[] } {
  return {
    cookies: [
      {
        name: 'sid',
        value: COOKIE_VALUE,
        domain: new URL(baseUrl).hostname,
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  };
}

/**
 * Record four workflows against the application, each on a fresh page of a logged-in context:
 * a search (type, click), a create (type, type, click), a server-rendered form (type, click) and a
 * search followed by the server-rendered form in one workflow.
 */
export async function recordCustomerWorkflows(browser: Browser, app: CustomersApp): Promise<Workflow[]> {
  const record = async (label: string, drive: (page: import('playwright').Page, live: LiveRecorder) => Promise<void>): Promise<Workflow> => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'sid', value: COOKIE_VALUE, url: app.baseUrl }]);
    try {
      const page = await context.newPage();
      await page.goto(`${app.baseUrl}/`);
      await page.getByText('Bob').waitFor();
      const recorder = new WorkflowRecorder(label);
      const live = new LiveRecorder(page, recorder, { captureNetwork: true });
      await live.attach();
      await drive(page, live);
      await live.finalizeNetwork();
      return recorder.finish();
    } finally {
      await context.close();
    }
  };
  const search = async (page: import('playwright').Page): Promise<void> => {
    await page.locator('#q').click();
    await page.keyboard.type('Ada');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.waitForTimeout(700);
  };
  const ssr = async (page: import('playwright').Page): Promise<void> => {
    await page.locator('#ssr').click();
    await page.keyboard.type('Grace');
    await page.getByRole('button', { name: 'Save SSR' }).click();
    await page.waitForURL('**/ssr/customers');
    await page.waitForTimeout(300);
  };

  const workflows: Workflow[] = [];
  workflows.push(await record('Find customers', async (page, live) => {
    await search(page);
    live.markVariable(0, { name: 'query' });
  }));
  workflows.push(await record('Add customer', async (page, live) => {
    await page.locator('#cname').click();
    await page.keyboard.type('Zed');
    await page.locator('#cemail').click();
    await page.keyboard.type('zed@example.com');
    await page.getByRole('button', { name: 'Add customer' }).click();
    await page.getByText('Zed').waitFor();
    await page.waitForTimeout(700);
    live.markVariable(0, { name: 'cname' });
    live.markVariable(1, { name: 'cemail' });
  }));
  workflows.push(await record('Save SSR name', async (page, live) => {
    await ssr(page);
    live.markVariable(0, { name: 'ssr_name' });
  }));
  workflows.push(await record('Find then save SSR', async (page, live) => {
    await search(page);
    await ssr(page);
    live.markVariable(0, { name: 'query' });
    live.markVariable(2, { name: 'ssr_name' });
  }));
  return workflows;
}
