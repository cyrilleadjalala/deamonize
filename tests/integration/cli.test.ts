import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
// Spawns the CLI: realistic limits for a loaded full-suite run
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../../src/cli/index.js';
import { record } from '../../src/cli/commands/record.js';
import { serve } from '../../src/cli/commands/serve.js';
import { compile } from '../../src/cli/commands/compile.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { removeDir } from '../helpers/cleanup.js';

const FORM_PAGE = `<!doctype html>
<html><head><title>New customer</title></head>
<body>
  <form action="/result" method="get">
    <label for="name">Customer name</label>
    <input id="name" name="name" />
    <button type="submit">Save</button>
  </form>
  <a href="/other">Other page</a>
</body></html>`;

describe('CLI: record → compile → merge', () => {
  let httpServer: Server;
  let baseUrl: string;
  let dir: string;
  let file: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('content-type', 'text/html');
      res.end(
        url.pathname === '/result'
          ? `<html><head><title>Saved</title></head><body>Customer ${url.searchParams.get('name')}</body></html>`
          : FORM_PAGE
      );
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;

    dir = await mkdtemp(join(tmpdir(), 'daemonize-cli-'));
    file = join(dir, 'workflows.json');
  });

  afterAll(async () => {
    await new Promise<void>((done) => httpServer?.close(() => done()));
    if (dir) {
      await removeDir(dir);
    }
  });

  const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
    const log = console.log;
    console.log = () => { };
    try {
      return await run();
    } finally {
      console.log = log;
    }
  };

  it('records a workflow, with a variable named in the page, into a new file', async () => {
    const summary = await record({
      url: baseUrl,
      name: 'Legacy CRM',
      label: 'Create customer',
      out: file,
      headless: true,
      drive: async (page) => {
        await page.locator('#name').click();
        await page.keyboard.type('Ada');
        await page.keyboard.press('Tab'); // leaving the field records it
        await page.locator('[data-daemonize-action=make-variable]').click();
        await page.locator('[data-daemonize-action=variable-name]').press('Enter'); // keeps the suggested name
        await expect(page.locator('[data-daemonize-ui]').textContent()).resolves.toContain('saved');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.waitForURL('**/result*');
      },
    });

    expect(summary).toMatchObject({ steps: 2, variables: ['customer_name'], totalWorkflows: 1 });

    const set = deserializeWorkflowSet(await readFile(file, 'utf-8'));
    expect(set).toMatchObject({ targetName: 'Legacy CRM', startUrl: baseUrl });
    expect(set.workflows[0].finalScreenId).toMatch(/^[0-9a-f]{16}$/);
  }, 60000);

  it('adds a second recording to the same file', async () => {
    const summary = await record({
      url: baseUrl,
      name: 'Legacy CRM',
      label: 'Open other page',
      out: file,
      headless: true,
      drive: async (page) => {
        await page.getByRole('link', { name: 'Other page' }).click();
        await page.waitForURL('**/other');
      },
    });

    expect(summary.totalWorkflows).toBe(2);
    const set = deserializeWorkflowSet(await readFile(file, 'utf-8'));
    expect(set.workflows.map((w) => w.label)).toEqual(['Create customer', 'Open other page']);
  }, 60000);

  it('fails clearly when nothing was recorded', async () => {
    await expect(
      record({
        url: baseUrl,
        name: 'Legacy CRM',
        label: 'Nothing',
        out: join(dir, 'empty.json'),
        headless: true,
        drive: async () => { },
      })
    ).rejects.toThrow(/without steps/);
  }, 60000);

  it('compiles the file into the artifacts and a runnable project', async () => {
    const out = join(dir, 'out');
    await quiet(() => buildProgram().parseAsync(['node', 'daemonize', 'compile', file, '--out', out]));

    expect((await readdir(out)).filter((name) => name !== '.dockerignore').sort()).toEqual([
      'docker-replay.js',
      'docker-replay.ts',
      'extract.js',
      'extract.ts',
      'POWER.md',
      'mcp-server.js',
      'mcp-server.ts',
      'mcp.json',
      'name-map.json',
      'omission.js',
      'omission.ts',
      'openapi.json',
      'package.json',
      'plugin.json',
      'browser-launch.js',
      'browser-launch.ts',
      'replay.js',
      'replay.ts',
      'row-resolver.js',
      'row-resolver.ts',
      'sandbox',
      'screen-hash.js',
      'screen-hash.ts',
      'settle.js',
      'settle.ts',
      'step-plan.js',
      'step-plan.ts',
      'totp.js',
      'totp.ts',
      'skills',
      'tests',
      'vault-format.js',
      'vault-format.ts',
      'vault-reader.js',
      'vault-reader.ts',
      'vitest.config.ts',
      'web-steps.js',
      'web-steps.ts',
    ].sort());
    const plugin = JSON.parse(await readFile(join(out, 'plugin.json'), 'utf-8'));
    expect(plugin.keywords).toEqual(expect.arrayContaining(['create_customer', 'open_other_page']));
  });

  it('merges two files, the newer one winning on identical ids', async () => {
    const out = join(dir, 'merged.json');
    const merged = await quiet(async () => {
      await buildProgram().parseAsync(['node', 'daemonize', 'merge', file, file, '--out', out]);
      return deserializeWorkflowSet(await readFile(out, 'utf-8'));
    });

    expect(merged.workflows).toHaveLength(2);
  });

  it('refuses to serve a directory that has not been compiled', async () => {
    await expect(serve(join(dir, 'missing'))).rejects.toThrow(/daemonize compile/);
  });

  it('installs the dependencies only when asked to', async () => {
    const installed: string[] = [];
    const installer = async (target: string) => {
      installed.push(target);
    };

    await quiet(() => compile(file, join(dir, 'no-install'), { installer }));
    expect(installed).toEqual([]);

    await quiet(() => compile(file, join(dir, 'with-install'), { install: true, installer }));
    expect(installed).toEqual([join(dir, 'with-install')]);
  });

  it('shows the install step when --install is not given', async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(String(line));
    try {
      await compile(file, join(dir, 'hint'));
    } finally {
      console.log = log;
    }

    expect(lines.some((line) => line.includes('npm install'))).toBe(true);
  });

  it('keeps what was recorded, and says so, when the browser stops unexpectedly', async () => {
    const out = join(dir, 'crash.json');
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: string) => errors.push(String(line));

    try {
      await expect(
        record({
          url: baseUrl,
          name: 'Legacy CRM',
          label: 'Interrupted',
          out,
          headless: true,
          drive: async (page) => {
            await page.locator('#name').click();
            await page.keyboard.type('Ada');
            await page.keyboard.press('Tab'); // records the typed value
            await new Promise((resolve) => setTimeout(resolve, 200));
            // The browser goes away while the user is still recording
            await page.context().browser()?.close();
            await new Promise((resolve) => setTimeout(resolve, 5000));
          },
        })
      ).rejects.toThrow(/Recording interrupted: the browser exited\. The 1 step\(s\) recorded so far were saved to .*crash\.json\.recovery\.json/);
    } finally {
      console.error = error;
    }

    expect(errors.some((line) => line.includes('the browser exited'))).toBe(true);

    // The recovery file is a valid workflow file, and the normal file was not written
    const recovered = deserializeWorkflowSet(await readFile(`${out}.recovery.json`, 'utf-8'));
    expect(recovered.workflows[0].steps.map((step) => [step.actionType, step.value])).toEqual([['type', 'Ada']]);
    await expect(readFile(out, 'utf-8')).rejects.toThrow(/ENOENT/);
  }, 60000);

  it('starts the Studio, like `studio --open`, when run without a subcommand (it used to print the help)', async () => {
    const started: unknown[][] = [];
    const handle = { close: async () => undefined };
    await buildProgram({
      studio: (async (...args: unknown[]) => { started.push(args); return handle; }) as never,
      untilInterrupted: (async () => undefined) as never,
    }).parseAsync(['node', 'daemonize']);
    expect(started).toEqual([['daemonize-out', { workflows: 'daemonize.workflows.json', host: '127.0.0.1', allowRemote: false, open: true, sample: false }]]);
  });

  it('rejects arguments the record command cannot use', async () => {
    const program = buildProgram();
    program.exitOverride();

    await expect(
      program.parseAsync(['node', 'daemonize', 'record', 'http://a', 'http://b', '-l', 'x'])
    ).rejects.toThrow(/exactly one URL/);
    await expect(
      buildProgram().parseAsync(['node', 'daemonize', 'record', 'http://a', '-l', 'x', '--type', 'ftp'])
    ).rejects.toThrow(/use web or tui/);
  });
});

