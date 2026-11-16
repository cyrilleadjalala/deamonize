/** Pieces the model providers have in common: the prompt, the tolerant parser, and the HTTP call. */
import { validateHealResult, type HealRequest, type HealResult, type Mark } from '../healer.js';

export interface ProviderConfig {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Wait before the one retry, in ms (doubled with each attempt; only one retry exists). */
  backoffMs?: number;
  /** Test seam: defaults to the global fetch. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class HealProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'HealProviderError';
  }
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_BACKOFF_MS = 500;

export const SYSTEM_PROMPT = [
  'You locate one user-interface element on a web page screenshot.',
  'Answer with a single JSON object and nothing else, in one of these shapes:',
  '{"kind":"mark","markId":<number>}  the numbered mark that is the element,',
  '{"kind":"point","x":<number>,"y":<number>}  viewport pixels, only when no mark fits (for example a canvas),',
  '{"kind":"none","reason":"<short text>"}  when the element is not visible.',
].join('\n');

/** The text part of the prompt. Built only from explicit fields, so nothing else can leak into it. */
export function buildPromptText(req: HealRequest): string {
  const lines: string[] = [];
  lines.push(`Intent: ${req.intent}`);
  lines.push(`Step action: ${req.step.action}`);
  if (req.step.role) lines.push(`Step role: ${req.step.role}`);
  if (req.step.name) lines.push(`Step name: ${req.step.name}`);
  lines.push(`Viewport: ${req.viewport.width}x${req.viewport.height} pixels`);
  lines.push(
    req.anchorThumbnailPng
      ? 'Image 1 is the element as it looked when recorded. Image 2 is the current page with numbered marks.'
      : 'The image is the current page with numbered marks.',
  );
  lines.push('Marks:');
  if (req.marks.length === 0) lines.push('(none)');
  for (const m of req.marks as Mark[]) {
    lines.push(`${m.id}: role=${m.role ?? ''} name=${m.name ?? ''}`);
  }
  return lines.join('\n');
}

/** The images in the order the prompt text refers to them: thumbnail first when present. */
export function promptImages(req: HealRequest): Buffer[] {
  return req.anchorThumbnailPng ? [req.anchorThumbnailPng, req.screenshotPng] : [req.screenshotPng];
}

/** Take the first JSON object out of a model answer, with or without a code fence. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1], text] : [text];
  for (const source of candidates) {
    const start = source.indexOf('{');
    if (start < 0) continue;
    // Try the longest balanced prefix first: scan for the matching brace
    let depth = 0;
    let inString = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/** Parse and validate a model answer. Anything unusable is `none`. */
export function parseHealAnswer(text: string, req: HealRequest): HealResult {
  const json = extractJson(text);
  if (json === undefined) return { kind: 'none', reason: 'model answer was not valid JSON' };
  return validateHealResult(json, req.marks, req.viewport);
}

export function scrubSecret(text: string, apiKey: string | undefined): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('[redacted]');
}

/** POST JSON with a timeout; one retry after a pause on 429 and 5xx. Errors never contain the key. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  config: ProviderConfig,
): Promise<unknown> {
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = JSON.stringify(body);
  let lastError: HealProviderError | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep((config.backoffMs ?? DEFAULT_BACKOFF_MS) * 2 ** (attempt - 1));
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return await response.json();
      const detail = scrubSecret((await response.text().catch(() => '')).slice(0, 300), config.apiKey);
      lastError = new HealProviderError(`model request failed with HTTP ${response.status}: ${detail}`, response.status);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      if (error instanceof HealProviderError) {
        if (error === lastError && (error.status === 429 || (error.status ?? 0) >= 500)) continue;
        throw error;
      }
      const message = scrubSecret(error instanceof Error ? error.message : String(error), config.apiKey);
      lastError = new HealProviderError(`model request failed: ${message}`);
    }
  }
  throw lastError ?? new HealProviderError('model request failed');
}
