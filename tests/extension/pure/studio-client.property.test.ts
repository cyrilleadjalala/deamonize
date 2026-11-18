// Feature: kiro-thin-extension, Property 8: The client sends only confined, authenticated requests
// **Validates: Requirements 5.7, 5.8, 5.9**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createStudioClient, StudioClientError, type Transport, type TransportRequest } from '../../../kiro-extension/src/core/studio-client';

const origin = fc
  .tuple(fc.constantFrom('127.0.0.1', 'localhost', '[::1]'), fc.integer({ min: 1, max: 65535 }).filter((n) => n !== 80))
  .map(([h, p]) => `http://${h}:${p}`);
const token = fc.stringMatching(/^[A-Za-z0-9_-]{16,64}$/);
const path = fc.oneof(
  fc.stringMatching(/^\/api\/[a-z]{1,8}(\/[a-z]{1,8})?(\?[a-z]=[a-z0-9]{1,5})?$/),
  fc.constantFrom('//evil.com/api/x', '/api/../x', '/api/%2e%2e/x', 'http://evil.com/api/x', '/x', '/api', '/api/a\\b', '/api/a\nb', '/api/a\0b', '/api/a#b', '/API/x', '', 'api/x', '/api//evil.com'),
  fc.string({ maxLength: 20 })
);
const jsonObject = fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean(), fc.constant(null)), { maxKeys: 4 });

function recorder(): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  return { calls, transport: { send: async (r) => (calls.push(r), { status: 200, text: '{"ok":true}' }) } };
}

describe('Property 8: confined and authenticated requests', () => {
  it('refuses without calling the transport, or sends only /api/ requests with the required headers', async () => {
    await fc.assert(
      fc.asyncProperty(origin, token, path, jsonObject, fc.boolean(), async (o, t, p, body, post) => {
        const { transport, calls } = recorder();
        const client = createStudioClient({ origin: o, token: t, transport });
        try {
          if (post) await client.post(p, body);
          else await client.get(p);
        } catch (error) {
          expect(error).toBeInstanceOf(StudioClientError);
          expect((error as StudioClientError).kind).toBe('refused-path');
          expect(calls).toHaveLength(0);
          return;
        }
        expect(calls).toHaveLength(1);
        const req = calls[0]!;
        const url = new URL(o);
        expect(req.hostname).toBe(url.hostname);
        expect(req.port).toBe(Number(url.port));
        expect(req.path.startsWith('/api/')).toBe(true);
        expect(req.method).toBe(post ? 'POST' : 'GET');
        expect(req.headers['x-studio-token']).toBe(t);
        expect(req.headers.Host).toBe(url.host);
        const names = Object.keys(req.headers).map((n) => n.toLowerCase());
        expect(names).not.toContain('origin');
        expect(names).not.toContain('cookie');
        if (post) {
          expect(req.headers['Content-Type']).toBe('application/json');
          expect(req.headers['x-studio-request']).toBe('1');
          expect(JSON.parse(req.body!)).toEqual(JSON.parse(JSON.stringify(body)));
        } else {
          expect(req.body).toBeUndefined();
          expect(names).not.toContain('x-studio-request');
        }
      }),
      { numRuns: 300 }
    );
  });

  it('uses the long timeout for power install and preview only', async () => {
    const { transport, calls } = recorder();
    const client = createStudioClient({ origin: 'http://127.0.0.1:5000', token: 'abcdefghijklmnopqrstuvwx', transport });
    await client.post('/api/power/install', {});
    await client.post('/api/power/preview', {});
    await client.post('/api/secrets', {});
    await client.get('/api/power/info');
    expect(calls.map((c) => c.timeoutMs)).toEqual([120_000, 120_000, 15_000, 15_000]);
  });

  it('rejects a non-object POST body and maps 3xx, 401 and bad JSON to client errors', async () => {
    const status = (s: number, text: string): Transport => ({ send: async () => ({ status: s, text }) });
    const mk = (tr: Transport) => createStudioClient({ origin: 'http://127.0.0.1:5000', token: 'abcdefghijklmnopqrstuvwx', transport: tr });
    await expect(mk(status(200, '{}')).post('/api/x', [] as unknown as Record<string, unknown>)).rejects.toMatchObject({ kind: 'bad-body' });
    await expect(mk(status(302, '')).get('/api/x')).rejects.toMatchObject({ kind: 'redirect' });
    await expect(mk(status(401, '{}')).get('/api/x')).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(mk(status(200, '<html>')).get('/api/x')).rejects.toMatchObject({ kind: 'bad-body' });
    await expect(mk(status(409, '{"error":"busy"}')).get('/api/x')).resolves.toEqual({ status: 409, body: { error: 'busy' } });
  });
});
