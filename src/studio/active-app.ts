/**
 * Which output folder belongs to the active application. See design "9. Application location".
 * `current()` only reads. `prepareCompile()` creates the Name_Map entry before any output is written.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { WorkflowSet } from '../types.js';
import type { ActiveApplication, ApplicationLocator } from './contracts.js';
import { deriveSlug, sourceOfSet, type AppNames, type AppSource } from './app-names.js';

async function isCompiled(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'mcp-server.js'))).isFile();
  } catch {
    return false;
  }
}

/** The server key that the legacy `mcp.json` already holds (kept unchanged), else the folder name. */
async function legacyServerKey(dir: string): Promise<string> {
  try {
    const root = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    const first = Object.keys(root.mcpServers ?? {})[0];
    if (first !== undefined) return first;
  } catch {
    // No usable mcp.json
  }
  return basename(dir);
}

export function createApplicationLocator(deps: {
  baseOutDir: string;
  apps: AppNames;
  loadSet: () => Promise<{ set: WorkflowSet | undefined }>;
}): ApplicationLocator {
  const sibling = (slug: string): string => join(dirname(deps.baseOutDir), slug);
  const keyOf = (source: AppSource): { applicationKey?: string } => ('origin' in source ? { applicationKey: source.origin } : {});

  const legacy = async (): Promise<ActiveApplication> => ({
    slug: await legacyServerKey(deps.baseOutDir),
    outDir: deps.baseOutDir,
    legacy: true,
  });

  return {
    async current() {
      const { set } = await deps.loadSet();
      if (set === undefined) return legacy();
      const source = sourceOfSet(set);
      let slug: string;
      try {
        slug = await deps.apps.peek(source);
      } catch {
        // Unreadable Name_Map: read only, so answer with the derived name
        slug = deriveSlug(source);
      }
      if (await isCompiled(sibling(slug))) return { ...keyOf(source), slug, outDir: sibling(slug), legacy: false };
      if (await isCompiled(deps.baseOutDir)) return { ...keyOf(source), ...(await legacy()) };
      return { ...keyOf(source), slug, outDir: sibling(slug), legacy: false };
    },

    async prepareCompile() {
      const { set } = await deps.loadSet();
      if (set === undefined) throw new Error('The workflow file cannot be read.');
      const source = sourceOfSet(set);
      const slug = await deps.apps.ensure(source);
      return { ...keyOf(source), slug, outDir: sibling(slug), legacy: false };
    },
  };
}
