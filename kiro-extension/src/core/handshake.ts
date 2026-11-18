import { isLoopbackOrigin, isStudioToken } from './origin';
import type { Handshake } from './types';

/** Parses the one JSON line of `daemonize studio --machine`. Returns only the three known fields, or undefined. */
export function parseHandshakeLine(line: string): Handshake | undefined {
  if (typeof line !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { origin, token, pid } = value as Record<string, unknown>;
  if (typeof origin !== 'string' || !isLoopbackOrigin(origin)) return undefined;
  if (typeof token !== 'string' || !isStudioToken(token)) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  return { origin, token, pid };
}

/** Same bytes as the CLI writes: the three fields, then one line feed. */
export function formatHandshake(h: Handshake): string {
  return `${JSON.stringify({ origin: h.origin, token: h.token, pid: h.pid })}\n`;
}
