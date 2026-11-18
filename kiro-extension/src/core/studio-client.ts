import * as http from 'node:http';
import type { StudioClient } from './ports';
import { isLoopbackOrigin, isStudioToken } from './origin';

export type { StudioClient };

export interface TransportRequest {
  method: 'GET' | 'POST';
  hostname: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}
export interface TransportResponse { status: number; text: string }
export interface Transport { send(req: TransportRequest): Promise<TransportResponse> }

export type ClientErrorKind = 'refused-path' | 'network' | 'timeout' | 'redirect' | 'bad-body' | 'too-large' | 'unauthorized';

export class StudioClientError extends Error {
  constructor(readonly kind: ClientErrorKind, message: string) {
    super(message);
    this.name = 'StudioClientError';
  }
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const LONG_TIMEOUT_MS = 120_000;
const LONG_PATHS = new Set(['/api/power/install', '/api/power/preview']);

/** `node:http`, no agent, no redirect following, response capped at 4 MiB. */
export function createHttpTransport(): Transport {
  return {
    send: (req) =>
      new Promise<TransportResponse>((resolve, reject) => {
        let settled = false;
        const fail = (error: StudioClientError): void => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const request = http.request(
          {
            method: req.method,
            hostname: req.hostname.replace(/^\[|\]$/g, ''),
            port: req.port,
            path: req.path,
            headers: req.headers,
            agent: false,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_RESPONSE_BYTES) {
                fail(new StudioClientError('too-large', 'The answer was too large.'));
                request.destroy();
                return;
              }
              chunks.push(chunk);
            });
            response.on('end', () => {
              if (settled) return;
              settled = true;
              resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
            });
            response.on('error', () => fail(new StudioClientError('network', 'The connection was lost.')));
          }
        );
        request.setTimeout(req.timeoutMs, () => {
          fail(new StudioClientError('timeout', 'The request took too long.'));
          request.destroy();
        });
        request.on('error', () => fail(new StudioClientError('network', 'The connection failed.')));
        if (req.body !== undefined) request.write(req.body);
        request.end();
      }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function createStudioClient(deps: {
  origin: string;
  token: string;
  transport?: Transport;
  log?: (line: string) => void;
}): StudioClient {
  if (!isLoopbackOrigin(deps.origin)) throw new StudioClientError('refused-path', 'The Studio address is not on this computer.');
  if (!isStudioToken(deps.token)) throw new StudioClientError('refused-path', 'The Studio key is not valid.');
  const base = new URL(deps.origin);
  const transport = deps.transport ?? createHttpTransport();
  const log = deps.log ?? ((): void => undefined);

  const confine = (path: unknown): { sent: string; pathname: string } => {
    if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\\r\n\0#]/.test(path)) {
      throw new StudioClientError('refused-path', 'Only the Studio API can be called.');
    }
    let url: URL;
    try {
      url = new URL(path, base);
    } catch {
      throw new StudioClientError('refused-path', 'Only the Studio API can be called.');
    }
    if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) {
      throw new StudioClientError('refused-path', 'Only the Studio API can be called.');
    }
    return { sent: url.pathname + url.search, pathname: url.pathname };
  };

  const run = async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
    const target = confine(path);
    if (method === 'POST' && !isPlainObject(body)) throw new StudioClientError('bad-body', 'The request body must be an object.');
    const headers: Record<string, string> = {
      'x-studio-token': deps.token,
      Host: base.host,
      Accept: 'application/json',
    };
    let text: string | undefined;
    if (method === 'POST') {
      text = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['x-studio-request'] = '1';
      headers['Content-Length'] = String(Buffer.byteLength(text));
    }
    const logPath = path.split('?')[0]!;
    let response: TransportResponse;
    try {
      response = await transport.send({
        method,
        hostname: base.hostname,
        port: Number(base.port),
        path: target.sent,
        headers,
        ...(text === undefined ? {} : { body: text }),
        timeoutMs: method === 'POST' && LONG_PATHS.has(target.pathname) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      const kind: ClientErrorKind = error instanceof StudioClientError ? error.kind : 'network';
      log(`${method} ${logPath} ${kind}`);
      if (error instanceof StudioClientError) throw error;
      throw new StudioClientError('network', 'The connection failed.');
    }
    if (response.status >= 300 && response.status < 400) {
      log(`${method} ${logPath} ${response.status}`);
      throw new StudioClientError('redirect', 'The Studio sent a redirect.');
    }
    if (response.status === 401) {
      log(`${method} ${logPath} 401`);
      throw new StudioClientError('unauthorized', 'The Studio refused the key.');
    }
    if (response.status >= 500) log(`${method} ${logPath} ${response.status}`);
    let parsed: unknown = null;
    if (response.text.trim() !== '') {
      try {
        parsed = JSON.parse(response.text);
      } catch {
        throw new StudioClientError('bad-body', 'The Studio answer could not be read.');
      }
    }
    return { status: response.status, body: parsed };
  };

  return {
    get: (path) => run('GET', path),
    post: (path, body) => run('POST', path, body),
  };
}
