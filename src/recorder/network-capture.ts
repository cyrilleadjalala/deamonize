/**
 * Observes the fetch and XHR requests a web page makes while the user records a workflow (requirement 13.1),
 * and attributes each one to the user action that triggered it.
 *
 * The recorder calls `beginAction()` when the page reports an action; a request started during the following
 * ACTION_WINDOW_MS belongs to the latest action. Static assets, analytics and beacons, WebSockets, requests
 * repeated at a fixed interval and failed requests are left out. A redirect chain is one logical request.
 * Only the SHAPE of a JSON response is kept (never its content), and credentials are replaced by references
 * as soon as the headers are read: a Cookie header is never kept, only the fact that there was one.
 */

import type { BrowserContext, Request } from 'playwright';
import { jsonShape, type CapturedRequest } from './http-correlate.js';
import { redactHeaders } from './redactor.js';

export const ACTION_WINDOW_MS = 4000;
/** Responses larger than this are not parsed: they count as JSON of unknown shape. */
export const MAX_RESPONSE_BYTES = 512 * 1024;
const SETTLE_TIMEOUT_MS = 3000;
const MIN_PERIODIC_REQUESTS = 4;
const PERIODIC_JITTER = 0.15;
const PERIODIC_MAX_INTERVAL_MS = 30_000;

const STATIC_PATH = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|m?js|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|wasm)$/i;
const STATIC_CONTENT = /^(image|font|audio|video)\/|text\/css|javascript/i;
const ANALYTICS_HOST = /(google-analytics|googletagmanager|doubleclick|segment\.(io|com)|mixpanel|hotjar|sentry|amplitude|datadoghq|newrelic|clarity\.ms|facebook\.net|fullstory|plausible)/i;
const ANALYTICS_PATH = /(^|\/)(analytics|beacon|collect|telemetry|tracking|track|metrics|pixel|gtag|stats|ping)(\/|$)/i;
/** Headers the browser adds on its own and that a replay does not need. */
const BROWSER_HEADERS = /^(host|connection|content-length|user-agent|referer|origin|accept-encoding|accept-language|cache-control|pragma|cookie|dnt|upgrade-insecure-requests|priority|te|if-.*|sec-.*)$/i;

/** A captured request and the action it belongs to. */
export interface ActionRequest extends CapturedRequest {
  actionId: number;
}

interface Entry {
  actionId: number;
  startedAt: number;
  method: string;
  url: string;
  postData?: string;
}

/** Framework dev servers: HMR updates, dev bundles, stack-frame endpoints. Never part of the application. */
const DEV_INTERNAL_PATH = [
  /\.hot-update\.(json|js)$/i,
  /(^|\/)_next\/(static|webpack-hmr)(\/|$)/,
  /(^|\/)__nextjs/,
  /(^|\/)__webpack_hmr(\/|$)/,
  /(^|\/)webpack-hmr(\/|$)/,
  /^\/(@vite|@react-refresh|@fs|__vite_ping)(\/|$)/,
  /^\/sockjs-node(\/|$)/,
];

export function isDevInternalUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return DEV_INTERNAL_PATH.some((pattern) => pattern.test(pathname));
  } catch {
    return false;
  }
}

export function isStaticUrl(url: string): boolean {
  try {
    return STATIC_PATH.test(new URL(url).pathname) || isDevInternalUrl(url);
  } catch {
    return true;
  }
}

export function isAnalyticsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ANALYTICS_HOST.test(parsed.hostname) || ANALYTICS_PATH.test(parsed.pathname);
  } catch {
    return true;
  }
}

/** Keys (method and path) of requests repeated at a fixed interval, from the start times of all requests seen. */
export function periodicKeys(timeline: ReadonlyMap<string, readonly number[]>): Set<string> {
  const periodic = new Set<string>();
  for (const [key, times] of timeline) {
    if (times.length < MIN_PERIODIC_REQUESTS) continue;
    const sorted = [...times].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((t, i) => t - sorted[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean > PERIODIC_MAX_INTERVAL_MS || mean <= 0) continue;
    // A poll is regular: no gap is far from the mean (a timer drifts by a few tens of ms)
    if (gaps.every((g) => Math.abs(g - mean) <= Math.max(PERIODIC_JITTER * mean, 60))) periodic.add(key);
  }
  return periodic;
}

function rootOf(request: Request): Request {
  let current = request;
  for (let from = current.redirectedFrom(); from !== null; from = current.redirectedFrom()) current = from;
  return current;
}

export class NetworkCapture {
  private current: { id: number; beganAt: number } | undefined;
  private nextId = 0;
  private started = false;
  private readonly entries = new Map<Request, Entry>();
  private readonly captured: ActionRequest[] = [];
  private readonly timeline = new Map<string, number[]>();
  private readonly pending = new Set<Promise<void>>();
  private readonly onRequest = (request: Request): void => this.requestStarted(request);
  private readonly onFinished = (request: Request): void => this.requestFinished(request);

  constructor(private readonly context: BrowserContext) { }

  /** Start listening. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.context.on('request', this.onRequest);
    this.context.on('requestfinished', this.onFinished);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.context.off('request', this.onRequest);
    this.context.off('requestfinished', this.onFinished);
  }

  /** The page reported a user action: the requests that follow belong to it. Returns the action id (increasing). */
  beginAction(): number {
    const id = this.nextId++;
    this.current = { id, beganAt: Date.now() };
    return id;
  }

  /** The kept requests of every action, once the pending responses have been read. */
  async requestsByAction(): Promise<Map<number, ActionRequest[]>> {
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS)),
    ]);
    const periodic = periodicKeys(this.timeline);
    const byAction = new Map<number, ActionRequest[]>();
    for (const request of this.captured) {
      if (periodic.has(keyOf(request.method, request.url))) continue;
      if (request.status >= 400) continue;
      // A read must answer with JSON; a write is also kept when it simply succeeded
      const structured = request.responseKind === 'json' || request.responseKind === 'empty';
      if (!structured && !(request.method !== 'GET' && request.status >= 200 && request.status < 400)) continue;
      const list = byAction.get(request.actionId) ?? [];
      list.push(request);
      byAction.set(request.actionId, list);
    }
    return byAction;
  }

  private requestStarted(request: Request): void {
    const type = request.resourceType();
    if (type !== 'fetch' && type !== 'xhr') return;
    const root = rootOf(request);
    if (this.entries.has(root) || !/^https?:/i.test(root.url())) return;

    const now = Date.now();
    const key = keyOf(root.method(), root.url());
    this.timeline.set(key, [...(this.timeline.get(key) ?? []), now]);

    if (this.current === undefined || now - this.current.beganAt > ACTION_WINDOW_MS) return;
    if (isStaticUrl(root.url()) || isAnalyticsUrl(root.url())) return;
    this.entries.set(root, {
      actionId: this.current.id,
      startedAt: now,
      method: root.method(),
      url: root.url(),
      postData: root.postData() ?? undefined,
    });
  }

  private requestFinished(request: Request): void {
    const root = rootOf(request);
    const entry = this.entries.get(root);
    if (entry === undefined) return;
    const task = this.complete(entry, root, request).catch(() => { });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private async complete(entry: Entry, root: Request, final: Request): Promise<void> {
    const response = await final.response();
    if (response === null) return;
    const contentType = response.headers()['content-type'] ?? '';
    if (STATIC_CONTENT.test(contentType)) return;

    const sent = await root.allHeaders();
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(sent)) if (!BROWSER_HEADERS.test(name)) kept[name] = value;
    const { headers, redacted } = redactHeaders(kept);

    let responseKind: ActionRequest['responseKind'] = 'other';
    let responseShape: ActionRequest['responseShape'];
    if (/json/i.test(contentType)) {
      responseKind = 'json';
      const length = Number(response.headers()['content-length'] ?? 0);
      if (length > MAX_RESPONSE_BYTES) {
        responseShape = {};
      } else {
        const text = (await response.text().catch(() => '')).trim();
        if (text.length > MAX_RESPONSE_BYTES) responseShape = {};
        else {
          try {
            responseShape = jsonShape(JSON.parse(text));
          } catch {
            responseKind = 'other';
          }
        }
      }
    } else if (response.status() === 204 || response.headers()['content-length'] === '0') {
      responseKind = 'empty';
    }

    this.captured.push({
      actionId: entry.actionId,
      method: entry.method,
      url: entry.url,
      startedAt: entry.startedAt,
      headers,
      redactedHeaders: redacted,
      hasCookie: 'cookie' in sent,
      ...(entry.postData === undefined ? {} : { postData: entry.postData }),
      status: response.status(),
      responseKind,
      ...(responseShape === undefined ? {} : { responseShape }),
    });
  }
}

function keyOf(method: string, url: string): string {
  try {
    return `${method} ${new URL(url).origin}${new URL(url).pathname}`;
  } catch {
    return `${method} ${url}`;
  }
}
