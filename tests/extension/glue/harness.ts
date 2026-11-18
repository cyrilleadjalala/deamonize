import type * as vscode from 'vscode';
import { __commands, __reset, __setFolders } from '../fake-vscode';
import { activateWith, type ExtensionHandle } from '../../../kiro-extension/src/extension';
import type { ExtensionDeps } from '../../../kiro-extension/src/ui/controller';
import type { ProcessManager, StudioApi, StudioSessionLike } from '../../../kiro-extension/src/core/ports';
import { buildBrowserUrl } from '../../../kiro-extension/src/core/studio-url';
import type { ProcessState } from '../../../kiro-extension/src/core/types';

export const TEST_TOKEN = 'T0KEN-for-glue-tests-0123456789abcdef';
export const ORIGIN = 'http://127.0.0.1:45678';

export interface Harness {
  handle: ExtensionHandle;
  manager: FakeManager;
  api: Record<string, (...args: any[]) => unknown>;
  apiCalls: Array<{ method: string; args: unknown[] }>;
  run(command: string, ...args: unknown[]): Promise<unknown>;
}

export interface FakeManager extends ProcessManager {
  starts: number;
  staleMarks: number;
  startError: Error | undefined;
  setState(state: ProcessState): void;
}

function fakeSession(): StudioSessionLike {
  return {
    origin: ORIGIN,
    pid: 4242,
    client: {
      get: async () => { throw new Error('the glue must go through the api'); },
      post: async () => { throw new Error('the glue must go through the api'); },
    },
    browserUrl: (route, target) => buildBrowserUrl({ origin: ORIGIN, token: TEST_TOKEN }, route, target),
    sensitiveValues: () => [TEST_TOKEN],
  };
}

export function createFakeManager(): FakeManager {
  const listeners = new Set<(s: ProcessState) => void>();
  const session = fakeSession();
  const manager: FakeManager = {
    state: 'running',
    session,
    starts: 0,
    staleMarks: 0,
    startError: undefined,
    onDidChangeState(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    async ensureStarted() {
      manager.starts += 1;
      if (manager.startError) throw manager.startError;
      return session;
    },
    async restart() { return manager.ensureStarted(); },
    async stop() { manager.setState('stopped'); },
    markStale() { manager.staleMarks += 1; },
    setState(state) {
      (manager as { state: ProcessState }).state = state;
      for (const l of [...listeners]) l(state);
    },
  };
  return manager;
}

/** Activates the real glue against a fake `vscode`, a fake process manager and a scripted Studio API. */
export function createHarness(apiOverrides: Record<string, (...args: any[]) => unknown> = {}, options: { folders?: string[] | null } = {}): Harness {
  __reset();
  if (options.folders !== null) __setFolders(options.folders ?? ['/work/project']);
  const manager = createFakeManager();
  const apiCalls: Array<{ method: string; args: unknown[] }> = [];
  const defaults: Record<string, (...args: any[]) => unknown> = {
    workflows: async () => ({ ok: true, status: 200, data: [] }),
    secrets: async () => ({ ok: true, status: 200, data: [] }),
    powerInfo: async () => ({ ok: true, status: 200, data: { kiroHomeExists: false, installs: [], available: true } }),
  };
  const table = { ...defaults, ...apiOverrides };
  const api = new Proxy({}, {
    get(_target, method: string) {
      return async (...args: unknown[]) => {
        apiCalls.push({ method, args });
        const impl = table[method];
        if (!impl) throw new Error(`unscripted api call: ${method}`);
        return impl(...args);
      };
    },
  }) as unknown as StudioApi;
  const deps: ExtensionDeps = {
    env: {},
    createProcessManager: () => manager,
    createApi: () => api,
  };
  const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
  const handle = activateWith(context, deps);
  return {
    handle,
    manager,
    api: table,
    apiCalls,
    async run(command, ...args) {
      const handler = __commands.get(command);
      if (!handler) throw new Error(`command not registered: ${command}`);
      return handler(...args);
    },
  };
}

/** True when `needle` appears in any string inside `value` (keys and values, any depth). */
export function containsText(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key.includes(needle) || containsText(inner, needle, seen)) return true;
  }
  return false;
}
