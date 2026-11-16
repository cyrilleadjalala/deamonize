import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fc from 'fast-check';
import { invalidPayloadArbitrary } from '../../src/pbt/schema-arbitrary.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { Compiler } from '../../src/compiler/compiler.js';
import type { WorkflowSet } from '../../src/types.js';

const FORM_PAGE = `<!doctype html>
<html><head><title>New customer</title></head>
<body>
  <form action="/result" method="get">
    <label for="name">Customer name</label>
    <input id="name" name="name" />
    <button type="submit">Save</button>
  </form>
</body></html>`;

function resultPage(name: string): string {
  return `<!doctype html>
<html><head><title>Customer saved</title></head>
<body><p>Customer ${name} created</p></body></html>`;
}

const workspaceRoot = resolve(import.meta.dirname, '../..');

describe('Workflow end to end (record → compile → serve → call)', () => {
  let httpServer: Server;
  let outputDir: string;
  let client: Client;
  let annotated: WorkflowSet;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('content-type', 'text/html');
      res.end(url.pathname === '/result' ? resultPage(url.searchParams.get('name') ?? '') : FORM_PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    const { port } = httpServer.address() as AddressInfo;

    // A workflow written by hand, as the recorder would produce it
    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'Legacy CRM',
      startUrl: `http://127.0.0.1:${port}/`,
      workflows: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          label: 'Create customer',
          steps: [
            { actionType: 'type', selectors: ['role=textbox[name="Customer name"]', '#name'], variable: 'name', label: 'type Customer name' },
            { actionType: 'click', selectors: ['role=button[name="Save"]', 'button[type=submit]'] },
          ],
          variables: [{ name: 'name', description: 'Customer name' }],
          observedPayloads: [],
        },
        {
          // Observed as a string and as a number: the schema accepts both, which
          // the generated zod schema cannot express, so only AJV can refuse a boolean
          id: '55555555-5555-4555-8555-555555555555',
          label: 'Submit code',
          steps: [{ actionType: 'type', selectors: ['#name'], variable: 'code' }],
          variables: [{ name: 'code' }],
          observedPayloads: [{ code: 'abc' }, { code: 5 }],
        },
      ],
    };

    // Compile into a folder under the workspace so the generated server can
    // resolve @modelcontextprotocol/sdk, zod and playwright from node_modules.
    outputDir = await mkdtemp(join(workspaceRoot, '.e2e-'));
    const log = console.log;
    console.log = () => {};
    try {
      annotated = new SchemaInferencer().inferWorkflows(set);
      await new Compiler().compile(annotated, outputDir);
    } finally {
      console.log = log;
    }

    // The generated TypeScript must type-check strictly; the compiler already
    // emitted mcp-server.js, which is what the manifest runs.
    execFileSync(
      process.execPath,
      [
        join(workspaceRoot, 'node_modules/typescript/bin/tsc'),
        join(outputDir, 'mcp-server.ts'),
        '--noEmit',
        '--target', 'ES2022',
        '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext',
        '--strict',
        '--skipLibCheck',
        '--types', 'node',
      ],
      { cwd: workspaceRoot, stdio: 'pipe' },
    );

    client = new Client({ name: 'e2e-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(outputDir, 'mcp-server.js')],
        cwd: workspaceRoot,
        // Lets the run use an already installed browser instead of the one Playwright expects
        env: process.env.DAEMONIZE_CHROMIUM_PATH
          ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH }
          : undefined,
      }),
    );
  }, 60000);

  afterAll(async () => {
    await client?.close();
    await new Promise<void>((done) => httpServer?.close(() => done()));
    if (outputDir) {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('registers one tool per workflow with the inferred input schema', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['create_customer', 'submit_code']);
    expect(tools[0].inputSchema.required).toEqual(['name']);
  });

  it('replays the workflow with the payload values and returns the resulting page', async () => {
    const response = await client.callTool({ name: 'create_customer', arguments: { name: 'Ada' } });
    const content = response.content as Array<{ type: string; text: string }>;
    const result = JSON.parse(content[0].text);

    expect(response.isError).toBe(false);
    expect(result).toMatchObject({ success: true, title: 'Customer saved' });
    expect(result.text).toContain('Customer Ada created');
  }, 30000);

  it('starts from the same state on every call', async () => {
    const response = await client.callTool({ name: 'create_customer', arguments: { name: 'Bob' } });
    const content = response.content as Array<{ type: string; text: string }>;

    expect(JSON.parse(content[0].text).text).toContain('Customer Bob created');
  }, 30000);

  it('refuses a payload that breaks the inferred schema, without replaying anything', async () => {
    const response = await client.callTool({ name: 'submit_code', arguments: { code: true } });
    const content = response.content as Array<{ type: string; text: string }>;
    const result = JSON.parse(content[0].text);

    expect(response.isError).toBe(true);
    expect(result).toMatchObject({ success: false, error: 'validation' });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toEqual(
      expect.objectContaining({ instancePath: '/code', message: expect.any(String) })
    );
  }, 30000);

  it('never replays a payload generated to break the schema of any tool', async () => {
    const toolNames: Record<string, string> = {
      'Create customer': 'create_customer',
      'Submit code': 'submit_code',
    };
    let refusedByAjv = 0;

    for (const workflow of annotated.workflows) {
      const tool = toolNames[workflow.label];
      // Tool arguments are always an object in MCP, so only object payloads can be sent
      const payloads = fc
        .sample(invalidPayloadArbitrary(workflow.inputSchema!), { numRuns: 25, seed: 7 })
        .filter((payload) => typeof payload === 'object' && payload !== null && !Array.isArray(payload));
      expect(payloads.length).toBeGreaterThan(0);

      for (const payload of payloads) {
        // The arguments may be refused by the MCP layer (zod) or by the AJV check
        // of the generated server; either way nothing must be replayed.
        const text = await callAndGetText(tool, payload as Record<string, unknown>);
        expect(text.refused, `${tool} accepted ${JSON.stringify(payload)}`).toBe(true);
        if (text.validation) {
          refusedByAjv += 1;
        }
      }
    }

    // The alternatives of "submit_code" can only be enforced by AJV
    expect(refusedByAjv).toBeGreaterThan(0);
  }, 120000);

  async function callAndGetText(
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ refused: boolean; validation: boolean }> {
    try {
      const response = await client.callTool({ name: tool, arguments: args });
      const content = response.content as Array<{ type: string; text: string }>;
      const text = content[0]?.text ?? '';
      let parsed: { success?: boolean; error?: string } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not our JSON: an error message from the MCP layer
      }
      return {
        refused: response.isError === true && parsed.success !== true,
        validation: parsed.error === 'validation',
      };
    } catch {
      // The MCP layer rejected the arguments before the tool ran
      return { refused: true, validation: false };
    }
  }
});

