/**
 * Pure helpers for the Kiro `mcp.json` file: parse, merge, remove, serialize and the three target paths.
 * No file access. See design "8. Power installer".
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { InstallScope } from './contracts.js';
import type { ServerEntry } from './mcp-snippet.js';

export type ParseReason = 'json' | 'not-object' | 'servers-not-object';
export type ParsedConfig = { ok: true; root: Record<string, unknown> } | { ok: false; reason: ParseReason };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses `mcp.json` bytes. A usable file is a JSON object whose `mcpServers`, when present, is an object. */
export function parseConfig(bytes: Buffer): ParsedConfig {
  let text = bytes.toString('utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (!isPlainObject(value)) return { ok: false, reason: 'not-object' };
  if (Object.prototype.hasOwnProperty.call(value, 'mcpServers') && !isPlainObject(value.mcpServers)) {
    return { ok: false, reason: 'servers-not-object' };
  }
  return { ok: true, root: value };
}

/** A copy of `root` where `mcpServers[name]` is `entry`. Everything else is kept as is (same order). */
export function mergeServer(root: Record<string, unknown>, name: string, entry: ServerEntry): Record<string, unknown> {
  const servers = isPlainObject(root.mcpServers) ? root.mcpServers : {};
  const merged = { ...servers, [name]: entry };
  return { ...root, mcpServers: merged };
}

/** A copy of `root` without `mcpServers[name]`. `removed` tells whether the entry was there. */
export function removeServer(root: Record<string, unknown>, name: string): { root: Record<string, unknown>; removed: boolean } {
  const servers = root.mcpServers;
  if (!isPlainObject(servers) || !Object.prototype.hasOwnProperty.call(servers, name)) return { root, removed: false };
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(servers)) if (key !== name) rest[key] = servers[key];
  return { root: { ...root, mcpServers: rest }, removed: true };
}

export function serialize(root: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(root, null, 2) + '\n', 'utf-8');
}

export interface TargetPaths {
  mcp: string;
  backup: string;
  skill: string;
  skillDir: string;
}

/** The files an install may touch, under `kiroRoot` (`<home>/.kiro` for global, `<workspace>/.kiro` for project). */
export function targetPaths(_scope: InstallScope, kiroRoot: string, slug: string): TargetPaths {
  const mcp = join(kiroRoot, 'settings', 'mcp.json');
  const skillDir = join(kiroRoot, 'skills', slug);
  return { mcp, backup: mcp + '.bak', skill: join(skillDir, 'SKILL.md'), skillDir };
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
