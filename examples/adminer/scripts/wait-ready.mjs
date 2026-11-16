// Polls http://127.0.0.1:<port> until Adminer answers. Usage: node wait-ready.mjs [port] [timeoutMs]
import { pathToFileURL } from 'node:url';

export async function waitReady(port, timeoutMs = 90_000) {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return url;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Adminer did not answer on ${url} within ${timeoutMs} ms (${last})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2] ?? process.env.ADMINER_PORT ?? 8080);
  const timeout = Number(process.argv[3] ?? 90_000);
  waitReady(port, timeout).then(
    (u) => console.log(`ready: ${u}`),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
