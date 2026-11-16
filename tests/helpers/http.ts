import { request } from 'node:http';

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
}

/**
 * A request with full control of the method, the raw path (nothing is normalised) and every header,
 * including Host, which `fetch` does not let a test choose.
 */
export function rawRequest(
  base: { port: number },
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | Buffer
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: base.port, method, path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf-8') });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      // Content-Length unless the caller chose its own headers for it
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) req.setHeader('content-length', String(Buffer.byteLength(body)));
      req.write(body);
    }
    req.end();
  });
}
