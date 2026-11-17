/** The route seam: every new Studio route is a RouteDef; one dispatcher in server.ts applies the guard rules. */
import type { WorkflowSet } from '../../types.js';
import type { StudioOutputs } from '../model.js';
import type { PlaygroundSession } from '../playground.js';
import type { StudioServices } from '../contracts.js';

export type RouteMethod = 'GET' | 'POST';

export interface RouteRequest {
  /** HEAD is dispatched as GET and the body is dropped. */
  method: RouteMethod;
  query: URLSearchParams;
  /** POST only: parsed object, {} for an empty body. */
  body: Record<string, unknown>;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
}
export interface RouteResponse {
  status: number;
  body: unknown;
}
export type RouteHandler = (req: RouteRequest) => Promise<RouteResponse>;
export interface RouteDef {
  /** Exact, e.g. '/api/record/start'. */
  path: string;
  handlers: Partial<Record<RouteMethod, RouteHandler>>;
  /** blocked: 403 when the listener is not loopback. */
  remote: 'blocked' | 'allowed';
  /** When true the POST handler answers 409 in sample mode before running. Default true for POST. */
  writes?: boolean;
}
export interface RouteContext {
  services: StudioServices;
  playground: PlaygroundSession | undefined;
  workflowFile: string;
  outDir: string;
  sample: boolean;
  /** Tolerant load: set is undefined when the Workflow_File does not exist. Throws LoadError otherwise. */
  loadSet(): Promise<{ set: WorkflowSet | undefined; outputs: StudioOutputs }>;
  /** Upper-case `DAEMONIZE_SECRET_<NAME>` names non-empty in the vault, Studio env or mcp.json env. */
  configuredSecretVariables(): Promise<ReadonlySet<string>>;
  studioEnv: Record<string, string | undefined>;
}
export type RouteFactory = (ctx: RouteContext) => RouteDef[];
