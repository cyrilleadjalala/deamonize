import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { simulate } from '../../src/studio/ui/js/sim/simulate.js';
import { StaticPlayground, validateArguments } from '../../src/studio/ui/js/sim/static-session.js';

const pictures = { failure: () => 'f.png', shot: () => 's.png' };

const tools = [
  { name: 'search_customers', risk: 'read', sensitiveArgs: [], inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'create_customer', risk: 'write', sensitiveArgs: ['pin_code'], inputSchema: { type: 'object', properties: { login: { type: 'string' }, name: { type: 'string', minLength: 1 }, pin_code: { type: 'string' } }, required: ['login', 'name'] } },
  { name: 'open_sales_chart', risk: 'read', sensitiveArgs: [], inputSchema: { type: 'object', properties: {} } },
];

describe('shared simulation', () => {
  it('answers a drifted success, a failure with a picture, and a heal', async () => {
    expect(await simulate('search_customers', { query: 'drift' }, 'strict', false, pictures)).toMatchObject({ success: true, drifted: true, title: 'Customers (new layout)' });
    const failed = await simulate('create_customer', { name: 'fail' }, 'strict', false, pictures);
    expect(failed).toMatchObject({ success: false, failure: { screenshot: 'f.png' } });
    expect(await simulate('open_sales_chart', {}, 'strict', false, pictures)).toMatchObject({ success: false });
    expect(await simulate('open_sales_chart', {}, 'heal', true, pictures)).toMatchObject({ success: true, healed: true, screenshot: 's.png' });
    expect(await simulate('nope', {}, 'strict', false, pictures)).toMatchObject({ error: 'unknown_tool' });
  });

  it('is deterministic', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.constantFrom('strict', 'heal'), fc.boolean(), async (query, mode, preview) => {
        const a = await simulate('search_customers', { query }, mode, preview, pictures);
        const b = await simulate('search_customers', { query }, mode, preview, pictures);
        expect(a).toEqual(b);
      }),
      { numRuns: 50 }
    );
  });
});

describe('static playground', () => {
  const make = () => new StaticPlayground({ tools });

  it('lists the tools as a simulated demo and starts the server', () => {
    const status = make().status();
    expect(status).toMatchObject({ available: true, simulated: true, staticDemo: true, serverStarted: true, healSupport: true });
    expect(status.tools).toHaveLength(3);
  });

  it('refuses invalid arguments with Ajv-style messages', async () => {
    const { status, body } = await make().call({ tool: 'search_customers', arguments: {} });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, refused: 'validation', errors: [{ instancePath: '(arguments)', message: "must have required property 'query'" }] });
    expect(validateArguments(tools[1].inputSchema, { login: 'a', name: '' })).toEqual([{ path: 'name', message: 'must NOT have fewer than 1 characters' }]);
  });

  it('wants confirmation for a write tool, and hides sensitive arguments in the history', async () => {
    const pg = make();
    const refused = await pg.call({ tool: 'create_customer', arguments: { login: 'a', name: 'Bob', pin_code: '12345' } });
    expect(refused).toMatchObject({ status: 409, body: { error: 'confirmation_required', risk: 'write' } });
    const ok = await pg.call({ tool: 'create_customer', arguments: { login: 'a', name: 'Bob', pin_code: '12345' }, confirm: true });
    expect(ok.body).toMatchObject({ success: true });
    const { history } = pg.history();
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain('12345');
  });

  it('turns the failure picture into a URL and heals in heal mode', async () => {
    const pg = make();
    const failed = await pg.call({ tool: 'create_customer', arguments: { login: 'a', name: 'fail' }, confirm: true });
    expect(failed.body).toMatchObject({ success: false, screenshotUrl: 'data/failure.png' });
    expect((failed.body.failure as Record<string, unknown>).screenshot).toBeUndefined();
    expect(pg.restart({ mode: 'heal' }).body).toMatchObject({ mode: 'heal' });
    expect((await pg.call({ tool: 'open_sales_chart', arguments: {} })).body).toMatchObject({ success: true, healed: true });
    expect(pg.stop().body).toMatchObject({ serverStarted: false });
    expect((await pg.call({ tool: 'ghost' })).status).toBe(404);
  });
});
