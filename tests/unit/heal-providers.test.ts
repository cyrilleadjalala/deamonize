import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { HealRequest } from '../../src/heal/healer.js';
import { resolveHealer } from '../../src/heal/providers/index.js';
import { HealProviderError, buildPromptText, extractJson } from '../../src/heal/providers/shared.js';

const viewport = { width: 800, height: 600 };
const req: HealRequest = {
  screenshotPng: Buffer.from('SCREENSHOT'),
  anchorThumbnailPng: Buffer.from('THUMB'),
  marks: [
    { id: 1, box: { x: 0, y: 0, width: 10, height: 10 }, role: 'button', name: 'Save' },
    { id: 2, box: { x: 20, y: 0, width: 10, height: 10 }, role: 'link', name: 'Home' },
  ],
  intent: 'click the Save button',
  step: { action: 'click', role: 'button', name: 'Save' },
  viewport,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const anthropicBody = (text: string) => ({ content: [{ type: 'text', text }] });
const openaiBody = (text: string) => ({ choices: [{ message: { content: text } }] });
const noSleep = async () => undefined;

function resolveWith(env: Record<string, string>, fetchImpl: typeof fetch) {
  const r = resolveHealer(env, { fetch: fetchImpl, sleep: noSleep });
  if (!r.available) throw new Error(r.reason);
  return r.healer;
}

describe('resolveHealer', () => {
  it('is unavailable without calling the network', () => {
    const spy = vi.fn();
    const cases: Array<Record<string, string>> = [
      {},
      { DAEMONIZE_MODEL_PROVIDER: 'nope', DAEMONIZE_MODEL_NAME: 'm' },
      { DAEMONIZE_MODEL_PROVIDER: 'anthropic' },
      { DAEMONIZE_MODEL_PROVIDER: 'anthropic', DAEMONIZE_MODEL_NAME: 'm' },
      { DAEMONIZE_MODEL_PROVIDER: 'openai', DAEMONIZE_MODEL_NAME: 'm' },
      { DAEMONIZE_MODEL_PROVIDER: 'openai-compatible', DAEMONIZE_MODEL_NAME: 'm' },
    ];
    for (const env of cases) {
      const r = resolveHealer(env, { fetch: spy as unknown as typeof fetch });
      expect(r.available).toBe(false);
      if (!r.available) expect(r.reason.length).toBeGreaterThan(0);
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it('accepts provider-standard key variables and a keyless local server', () => {
    expect(resolveHealer({ DAEMONIZE_MODEL_PROVIDER: 'anthropic', DAEMONIZE_MODEL_NAME: 'm', ANTHROPIC_API_KEY: 'k' }).available).toBe(true);
    expect(resolveHealer({ DAEMONIZE_MODEL_PROVIDER: 'openai', DAEMONIZE_MODEL_NAME: 'm', OPENAI_API_KEY: 'k' }).available).toBe(true);
    expect(resolveHealer({ DAEMONIZE_MODEL_PROVIDER: 'openai-compatible', DAEMONIZE_MODEL_NAME: 'm', DAEMONIZE_MODEL_BASE_URL: 'http://localhost:11434/v1' }).available).toBe(true);
  });
});

describe('providers', () => {
  it('anthropic: request shape and response parsing', async () => {
    const fetchMock = vi.fn(async () => json(anthropicBody('{"kind":"mark","markId":2}')));
    const healer = resolveWith({ DAEMONIZE_MODEL_PROVIDER: 'anthropic', DAEMONIZE_MODEL_NAME: 'claude-x', DAEMONIZE_MODEL_API_KEY: 'sk-ant-1' }, fetchMock as unknown as typeof fetch);
    expect(await healer.locate(req)).toEqual({ kind: 'mark', markId: 2 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-1');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-x');
    const images = body.messages[0].content.filter((c: { type: string }) => c.type === 'image');
    expect(images.map((i: { source: { data: string } }) => i.source.data)).toEqual([Buffer.from('THUMB').toString('base64'), Buffer.from('SCREENSHOT').toString('base64')]);
  });

  it('openai and openai-compatible: shapes, urls and code-fenced JSON', async () => {
    const fetchMock = vi.fn(async () => json(openaiBody('Here you go:\n```json\n{"kind":"point","x":100,"y":50}\n```')));
    const openai = resolveWith({ DAEMONIZE_MODEL_PROVIDER: 'openai', DAEMONIZE_MODEL_NAME: 'gpt', DAEMONIZE_MODEL_API_KEY: 'sk-1' }, fetchMock as unknown as typeof fetch);
    expect(await openai.locate(req)).toEqual({ kind: 'point', x: 100, y: 50 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-1');
    const parts = JSON.parse(init.body as string).messages[1].content;
    expect(parts.filter((p: { type: string }) => p.type === 'image_url')).toHaveLength(2);

    const local = resolveWith({ DAEMONIZE_MODEL_PROVIDER: 'openai-compatible', DAEMONIZE_MODEL_NAME: 'llava', DAEMONIZE_MODEL_BASE_URL: 'http://localhost:11434/v1/' }, fetchMock as unknown as typeof fetch);
    await local.locate(req);
    const [localUrl, localInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(localUrl).toBe('http://localhost:11434/v1/chat/completions');
    expect((localInit.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('malformed or invalid answers become none', async () => {
    for (const text of ['I cannot tell', '{"kind":"mark"', '{"kind":"mark","markId":99}', '{"kind":"point","x":5000,"y":1}']) {
      const healer = resolveWith({ DAEMONIZE_MODEL_PROVIDER: 'openai', DAEMONIZE_MODEL_NAME: 'g', DAEMONIZE_MODEL_API_KEY: 'k' }, (async () => json(openaiBody(text))) as unknown as typeof fetch);
      expect((await healer.locate(req)).kind).toBe('none');
    }
  });

  it('retries once on 429 and then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: 'slow down' }, 429))
      .mockResolvedValueOnce(json(openaiBody('{"kind":"mark","markId":1}')));
    const healer = resolveWith({ DAEMONIZE_MODEL_PROVIDER: 'openai', DAEMONIZE_MODEL_NAME: 'g', DAEMONIZE_MODEL_API_KEY: 'k' }, fetchMock as unknown as typeof fetch);
    expect(await healer.locate(req)).toEqual({ kind: 'mark', markId: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after one retry, does not retry a 400, and scrubs the key from errors', async () => {
    const key = 'sk-SECRET-KEY-123';
    const failing = vi.fn(async () => new Response(`bad key ${key}`, { status: 503 }));
    const healer = resolveWith({ DAEMONIZE_MODEL_PROVIDER: 'openai', DAEMONIZE_MODEL_NAME: 'g', DAEMONIZE_MODEL_API_KEY: key }, failing as unknown as typeof fetch);
    const error = await healer.locate(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HealProviderError);
    expect((error as Error).message).not.toContain(key);
    expect(failing).toHaveBeenCalledTimes(2);

    const bad = vi.fn(async () => new Response(`invalid ${key}`, { status: 400 }));
    const h2 = resolveWith({ DAEMONIZE_MODEL_PROVIDER: 'openai', DAEMONIZE_MODEL_NAME: 'g', DAEMONIZE_MODEL_API_KEY: key }, bad as unknown as typeof fetch);
    const e2 = await h2.locate(req).catch((e: unknown) => e);
    expect((e2 as Error).message).not.toContain(key);
    expect(bad).toHaveBeenCalledTimes(1);

    const network = vi.fn(async () => { throw new Error(`connect failed with ${key}`); });
    const h3 = resolveWith({ DAEMONIZE_MODEL_PROVIDER: 'anthropic', DAEMONIZE_MODEL_NAME: 'g', DAEMONIZE_MODEL_API_KEY: key }, network as unknown as typeof fetch);
    const e3 = await h3.locate(req).catch((e: unknown) => e);
    expect((e3 as Error).message).not.toContain(key);
  });
});

describe('prompt', () => {
  it('is deterministic and lists marks by id, role and name', () => {
    expect(buildPromptText(req)).toBe(buildPromptText({ ...req }));
    expect(buildPromptText(req)).toContain('1: role=button name=Save');
  });

  it('never carries planted values or secrets, in the prompt or the serialized request', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[A-Za-z0-9]{12,24}$/), async (secret) => {
        const planted = `SECRET-${secret}`;
        // A caller that wrongly passes extra fields must still not leak them
        const dirty = { ...req, value: planted, secretRef: planted, step: { ...req.step, value: planted, text: planted } } as unknown as HealRequest;
        expect(buildPromptText(dirty)).not.toContain(planted);
        const fetchMock = vi.fn(async () => json(openaiBody('{"kind":"none","reason":"x"}')));
        const healer = resolveWith({ DAEMONIZE_MODEL_PROVIDER: 'anthropic', DAEMONIZE_MODEL_NAME: 'm', DAEMONIZE_MODEL_API_KEY: 'k' }, fetchMock as unknown as typeof fetch);
        await healer.locate(dirty);
        const sent = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
        expect(sent).not.toContain(planted);
      }),
      { numRuns: 25 },
    );
  });
});

describe('extractJson', () => {
  it('finds JSON inside prose and fences, and handles braces in strings', () => {
    expect(extractJson('x {"a":"}"} y')).toEqual({ a: '}' });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('no json')).toBeUndefined();
  });
});
