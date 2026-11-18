import { describe, it, expect } from 'vitest';
import { buildRequest, withRecordedDefaults, planSteps, HttpReplayError, runHttpStep, type HttpRecipeLike } from '../../src/replay/runtime/http-replay.js';

const skip = new Set(['opt']);
const base = (over: Partial<HttpRecipeLike>): HttpRecipeLike => ({ method: 'POST', url: 'https://api.example.com/x', query: {}, ...over });

describe('HTTP request with skipped Variables', () => {
  it('drops a query key whose text mentions the skipped name, keeps it otherwise', () => {
    const r = base({ query: { a: '{{opt}}', b: 'k-{{opt}}', c: '{{keep}}' } });
    expect(buildRequest(r, { keep: 'v' }, {}, skip).url).toBe('https://api.example.com/x?c=v');
  });

  it('drops a header, even mixed text, and never adds an empty one', () => {
    const r = base({ headers: { authorization: 'Bearer {{opt}}', 'x-a': 'ok' } });
    const built = buildRequest(r, {}, {}, skip);
    expect(built.headers['authorization']).toBeUndefined();
    expect(built.headers['x-a']).toBe('ok');
  });

  it('removes object property, array item (order kept), form field and mixed string leaf', () => {
    const body = { a: { $var: 'opt' }, b: [1, { $var: 'opt' }, 3], c: 'x {{opt}}', d: { e: { $var: 'opt' } }, f: 'kept' };
    expect(JSON.parse(buildRequest(base({ body }), {}, {}, skip).body as string)).toEqual({ b: [1, 3], d: {}, f: 'kept' });
    const form = buildRequest(base({ body: { a: { $var: 'opt' }, b: 'y' }, bodyFormat: 'form' }), {}, {}, skip);
    expect(form.body).toBe('b=y');
  });

  it('sends no body and adds no content-type when the root body is skipped', () => {
    const built = buildRequest(base({ body: { $var: 'opt' } }), {}, {}, skip);
    expect(built.body).toBeUndefined();
    expect(built.headers['content-type']).toBeUndefined();
  });

  it('useRecorded keeps the recorded value; skip leaves the name out of the defaults', () => {
    const steps = [{ variable: 'opt', value: 'rec' }];
    expect(withRecordedDefaults(steps, {})).toEqual({ opt: 'rec' });
    expect(withRecordedDefaults(steps, {}, skip)).toEqual({});
    expect(withRecordedDefaults(steps, { opt: 'given' }, skip)).toEqual({ opt: 'given' });
  });

  it('refuses a skipped placeholder in the path with invalid and no secret', () => {
    const r = base({ url: 'https://api.example.com/u/{{opt}}', headers: { a: { $secret: 'S' } } });
    try {
      buildRequest(r, {}, { DAEMONIZE_SECRET_S: 'sekret-value' }, skip);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpReplayError);
      expect((err as HttpReplayError).kind).toBe('invalid');
      expect((err as Error).message).toContain('"opt"');
      expect((err as Error).message).not.toContain('sekret-value');
    }
  });

  it('never touches an entry bound to a secret', () => {
    const r = base({ headers: { a: { $secret: 'S' } }, query: { s: { $secret: 'S' } } });
    const built = buildRequest(r, {}, { DAEMONIZE_SECRET_S: 'v' }, new Set(['S']));
    expect(built.headers['a']).toBe('v');
    expect(built.url).toContain('s=v');
  });

  it('runHttpStep passes skipped to the request', async () => {
    let seen = '';
    const fetchImpl = (async (url: string) => {
      seen = url;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const out = await runHttpStep(base({ method: 'GET', query: { a: '{{opt}}', b: '1' } }), {}, {}, { timeoutMs: 1000, skipped: skip, fetchImpl });
    expect(out.ok).toBe(true);
    expect(seen).toBe('https://api.example.com/x?b=1');
  });

  it('plans a check step as preparatory before a later recipe', () => {
    const plan = planSteps([
      { actionType: 'check', variable: 'agree' },
      { actionType: 'click', http: { method: 'POST', url: 'https://a.b/x', query: {}, bindings: [{ variable: 'agree', in: 'body', name: 'agree' }] } },
    ]);
    expect(plan).toEqual(['prep', 'http']);
  });
});
