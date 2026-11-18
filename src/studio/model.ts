/**
 * Pure view models of the Studio: a WorkflowSet and what the compiler wrote next to it become the JSON the UI
 * shows. Nothing here reads a file or the network.
 *
 * What a view never contains: a typed or selected value (`step.value`), a header, a cookie, an HTTP body, the
 * query values or the credentials of a URL, the content of a storage state, the arguments of the target command,
 * the install commands of the sandbox, a screen snapshot, or an inline picture. Secrets appear by name only.
 */
import { basename } from 'node:path';
import type { HttpRecipe, SecretReference, WhenOmitted, Workflow, WorkflowSet, WorkflowStep } from '../types.js';
import { clipText, type PbtRunResult } from './pbt-result.js';
import { httpSecretSplit } from '../compiler/tool-description.js';

export type StepLevel = 'http' | 'accessibility' | 'vision' | 'coordinates';
export type PrimaryLevel = StepLevel | 'terminal' | 'none';

export interface StepLevels {
  levels: Record<StepLevel, boolean>;
  primaryLevel: PrimaryLevel;
}

/** What the compiler left in the output directory, as far as the Studio needs it. */
export interface StudioOutputs {
  /** workflow id -> tool name (name-map.json). */
  nameMap?: Record<string, string>;
  /** openapi.json. */
  openapi?: unknown;
  flags: { compiled: boolean; healSupport: boolean; http: boolean; pbtGenerated: boolean };
  /** Tools that have a generated test file. */
  testTools?: string[];
}

export const NO_OUTPUTS: StudioOutputs = { flags: { compiled: false, healSupport: false, http: false, pbtGenerated: false } };

export interface StudioTarget {
  set: WorkflowSet;
  outputs: StudioOutputs;
}

// Roles that give a locator nothing to find: a canvas is located by position only
const NON_ROLES = new Set(['', 'generic', 'document', 'canvas']);
const LEVEL_ORDER: StepLevel[] = ['http', 'accessibility', 'vision', 'coordinates'];
const PASSWORD_SELECTOR = /type\s*=\s*["']?password/i;
const PASSWORD_LABEL = /pass(word|wd)|mot de passe/i;
/** The recorder names thumbnails `step-<workflow id>-<index>.png`; the sample data uses `sample-*.png`. */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}\.png$/;

const MAX_STEPS_PER_WORKFLOW = 500;
const MAX_WORKFLOWS = 200;
export const MAX_GRAPH_NODES = 400;
export const MAX_GRAPH_EDGES = 800;

const text = (value: unknown, max = 200): string | undefined =>
  typeof value === 'string' && value !== '' ? clipText(value, max) : undefined;

/** True when a step types a secret: nothing about it (not even a thumbnail) is shown. */
export function isSecretStep(step: WorkflowStep): boolean {
  return (
    step.secretRef !== undefined ||
    step.totp === true ||
    (step.actionType === 'type' &&
      ((step.selectors ?? []).some((s) => PASSWORD_SELECTOR.test(s)) || (step.label !== undefined && PASSWORD_LABEL.test(step.label))))
  );
}

/**
 * Which replay levels a step can use. http: a recorded request; accessibility: a role and name or a recorded
 * selector (web); vision: a Visual_Anchor with a thumbnail or an intent (heal mode); coordinates: the Visual_Anchor
 * rect. A terminal step is replayed on the rendered screen and has no level of these.
 */
export function classifyStep(step: WorkflowStep, targetType: 'web' | 'tui'): StepLevels {
  const web = targetType === 'web';
  const anchor = step.anchor;
  const visual = step.visual;
  const levels: Record<StepLevel, boolean> = {
    http: web && step.http !== undefined,
    accessibility:
      web &&
      step.actionType !== 'switch_page' &&
      ((anchor !== undefined && !NON_ROLES.has(anchor.role) && anchor.name !== '') || (step.selectors ?? []).length > 0),
    vision: web && visual !== undefined && (visual.thumbnailPath !== undefined || (visual.intent ?? '').trim() !== ''),
    coordinates: web && visual?.rect !== undefined,
  };
  const primary = LEVEL_ORDER.find((level) => levels[level]);
  return { levels, primaryLevel: web ? (primary ?? 'none') : 'terminal' };
}

/** The path of a recorded URL: no credentials, query or fragment; `{{variable}}` placeholders stay readable. */
export function urlPath(url: string): string {
  let path: string;
  try {
    path = new URL(url, 'http://placeholder.invalid').pathname;
  } catch {
    path = url.split(/[?#]/)[0];
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the encoded form
  }
  return clipText(path, 200);
}

/** `origin + path` of a start URL: userinfo, query and fragment are dropped. */
export function displayUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return clipText(`${parsed.origin === 'null' ? `${parsed.protocol}//` : parsed.origin}${parsed.pathname}`, 200);
  } catch {
    return undefined;
  }
}

export interface HttpSummary {
  method: string;
  path: string;
  queryKeys: string[];
  bodyFormat?: string;
  auth?: string;
  expectStatus?: number;
  bindings: number;
  redacted: number;
}

function httpSummary(http: HttpRecipe): HttpSummary {
  return {
    method: http.method,
    path: urlPath(http.url),
    queryKeys: Object.keys(http.query ?? {}).slice(0, 20).map((k) => clipText(k, 60)),
    ...(http.bodyFormat === undefined ? {} : { bodyFormat: http.bodyFormat }),
    ...(http.auth === undefined ? {} : { auth: http.auth }),
    ...(http.expectStatus === undefined ? {} : { expectStatus: http.expectStatus }),
    bindings: (http.bindings ?? []).length,
    redacted: (http.redacted ?? []).length,
  };
}

export interface StepView {
  index: number;
  action: string;
  label?: string;
  intent?: string;
  target?: { role: string; name?: string; parentKind?: string; parentName?: string };
  risk: 'read' | 'write' | 'delete';
  allowHeal: boolean;
  levels: Record<StepLevel, boolean>;
  primaryLevel: PrimaryLevel;
  variable?: string;
  /** True when the step types a value taken from a secret (the name is in the workflow's `secrets`). */
  usesSecret: boolean;
  http?: HttpSummary;
  rowBinding?: { kind?: string; role?: string; variable?: string; keyColumn?: string };
  waitFor?: { kind: 'pattern' | 'text'; expression: string; mode: string; when?: string; timeoutMs: number };
  timeoutMs?: number;
  thumbnailUrl?: string;
}

function stepView(step: WorkflowStep, index: number, targetType: 'web' | 'tui'): StepView {
  const { levels, primaryLevel } = classifyStep(step, targetType);
  const secret = isSecretStep(step);
  const thumbName = step.visual?.thumbnailPath === undefined ? undefined : step.visual.thumbnailPath.split(/[\\/]/).pop();
  const anchor = step.anchor;
  const row = step.rowBinding;
  const wait = step.waitFor;
  const expression = wait === undefined ? undefined : (wait.pattern ?? wait.text);
  return {
    index,
    action: step.actionType,
    ...(text(step.label) === undefined ? {} : { label: text(step.label) }),
    ...(text(step.visual?.intent) === undefined ? {} : { intent: text(step.visual?.intent) }),
    ...(anchor === undefined
      ? {}
      : {
          target: {
            role: clipText(anchor.role, 40),
            ...(text(anchor.name) === undefined ? {} : { name: text(anchor.name) }),
            ...(anchor.parent === undefined ? {} : { parentKind: anchor.parent.kind, parentName: clipText(anchor.parent.name, 100) }),
          },
        }),
    risk: step.risk ?? 'read',
    allowHeal: step.allowHeal === true,
    levels,
    primaryLevel,
    ...(step.variable === undefined ? {} : { variable: clipText(step.variable, 60) }),
    usesSecret: secret,
    ...(step.http === undefined ? {} : { http: httpSummary(step.http) }),
    ...(row === undefined
      ? {}
      : {
          rowBinding: {
            ...(row.container?.kind === undefined ? {} : { kind: row.container.kind }),
            ...(row.container?.role === undefined ? {} : { role: row.container.role }),
            ...(row.variable === undefined ? {} : { variable: row.variable }),
            ...(row.key?.column === undefined ? {} : { keyColumn: clipText(row.key.column, 60) }),
          },
        }),
    ...(wait === undefined || expression === undefined
      ? {}
      : {
          waitFor: {
            kind: wait.pattern !== undefined ? ('pattern' as const) : ('text' as const),
            expression: clipText(expression, 120),
            mode: wait.mode ?? 'appear',
            ...(wait.when === undefined ? {} : { when: wait.when }),
            timeoutMs: wait.timeoutMs,
          },
        }),
    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    // A picture of a secret field is never offered, whatever the file holds
    ...(thumbName !== undefined && !secret && ASSET_NAME.test(thumbName) ? { thumbnailUrl: `/api/assets/${thumbName}` } : {}),
  };
}

export interface SecretName {
  name: string;
  kind?: SecretReference['kind'];
  /** `DAEMONIZE_SECRET_<name>`: the variable to set, never its value. */
  envVariable?: string;
  /** Present when the Studio knows the environment given to the server; absent for sample data and the static demo. */
  status?: 'configured' | 'missing';
}

/** Upper-case names of the `DAEMONIZE_SECRET_*` variables that are non-empty in the environment of the server. Names only. */
export interface SecretStatusSource {
  configured: ReadonlySet<string>;
}

/** The names (never values) of the secrets a workflow uses: declared, typed by a step, or referenced by a request. */
export function secretNames(workflow: Workflow): SecretName[] {
  const found = new Map<string, SecretName>();
  const add = (name: unknown, kind?: SecretReference['kind']): void => {
    if (typeof name !== 'string' || name === '') return;
    const known = found.get(name);
    if (known === undefined || (known.kind === undefined && kind !== undefined)) found.set(name, { name: clipText(name, 80), ...(kind === undefined ? {} : { kind }) });
  };
  for (const secret of workflow.secrets ?? []) {
    if (typeof secret === 'string') add(secret);
    else add(secret?.name, secret?.kind);
  }
  for (const step of workflow.steps ?? []) {
    add(step.secretRef, step.totp === true ? 'totp' : undefined);
    for (const r of step.http?.redacted ?? []) add(r.secret);
    for (const bag of [step.http?.query, step.http?.headers]) {
      for (const value of Object.values(bag ?? {})) {
        if (value !== null && typeof value === 'object') add((value as { $secret?: unknown }).$secret);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const SECRET_PREFIX = 'DAEMONIZE_SECRET_';

/**
 * The secrets the compiled mode needs, and the names recorded in HTTP recipes that it never reads. Required: the
 * declared secrets, the `secretRef` of the steps, and the `$secret` names of the steps a `--http` server runs over
 * HTTP. With a status source each required secret says `configured` or `missing`. Names and statuses only.
 */
export function workflowSecrets(
  workflow: Workflow,
  options: { http: boolean },
  status?: SecretStatusSource
): { required: SecretName[]; unused: SecretName[] } {
  const required = new Map<string, SecretName>();
  const add = (name: unknown, kind?: SecretReference['kind']): void => {
    if (typeof name !== 'string' || name === '') return;
    const known = required.get(name);
    if (known === undefined || (known.kind === undefined && kind !== undefined)) {
      required.set(name, { name: clipText(name, 80), ...(kind === undefined ? {} : { kind }) });
    }
  };
  for (const secret of workflow.secrets ?? []) {
    if (typeof secret === 'string') add(secret);
    else add(secret?.name, secret?.kind);
  }
  for (const step of workflow.steps ?? []) add(step.secretRef, step.totp === true ? 'totp' : undefined);
  const split = httpSecretSplit(workflow, { http: options.http });
  for (const name of split.used) add(name);
  const withStatus = (secret: SecretName): SecretName => {
    const envVariable = `${SECRET_PREFIX}${secret.name}`;
    return {
      ...secret,
      envVariable,
      ...(status === undefined ? {} : { status: status.configured.has(envVariable.toUpperCase()) ? ('configured' as const) : ('missing' as const) }),
    };
  };
  const byName = (a: SecretName, b: SecretName): number => a.name.localeCompare(b.name);
  return {
    required: [...required.values()].sort(byName).map(withStatus),
    unused: split.unused.filter((name) => !required.has(name)).map((name) => ({ name: clipText(name, 80), envVariable: `${SECRET_PREFIX}${name}` })).sort(byName),
  };
}

export interface WriteStepView {
  /** Zero-based step index, as in `StepView.index`. */
  index: number;
  label: string;
  risk: 'write' | 'delete';
  kind: 'login' | 'action';
}

/**
 * The steps that write (risk other than `read`), in order. The first write is the login when a secret step comes
 * before it. `summary` is `none`, `login-only` (the login is the only write) or `actions`.
 */
export function writeStepsOf(workflow: Workflow): { writeSteps: WriteStepView[]; writeSummary: 'none' | 'login-only' | 'actions' } {
  const steps = workflow.steps ?? [];
  const writeSteps: WriteStepView[] = [];
  let loginIndex: number | undefined;
  steps.forEach((step, index) => {
    const risk = step.risk ?? 'read';
    if (risk === 'read') return;
    if (writeSteps.length === 0 && steps.slice(0, index).some(isSecretStep)) loginIndex = index;
    const label = step.label !== undefined && step.label.trim() !== '' ? clipText(step.label, 80) : `${step.actionType} ${index + 1}`;
    writeSteps.push({ index, label, risk, kind: index === loginIndex ? 'login' : 'action' });
  });
  const writeSummary = writeSteps.length === 0 ? 'none' : writeSteps.every((w) => w.kind === 'login') ? 'login-only' : 'actions';
  return { writeSteps: writeSteps.slice(0, MAX_STEPS_PER_WORKFLOW), writeSummary };
}

export interface WorkflowView {
  id: string;
  label: string;
  toolName?: string;
  description?: string;
  target: { name: string; type: 'web' | 'tui' };
  risk: { read: number; write: number; delete: number; highest: 'read' | 'write' | 'delete' };
  /** whenOmitted only for an optional Variable: 'useRecorded' when the file has none. */
  variables: Array<{ name: string; type: string; description?: string; optional: boolean; whenOmitted?: WhenOmitted }>;
  /** Path of the start page of this workflow (no query or fragment), only when it differs from the set startUrl (10.12). */
  startPage?: string;
  /** Required for the compiled mode, with `status` when the environment of the server is known. */
  secrets: SecretName[];
  /** Recorded in HTTP recipes but not read by the compiled mode. */
  unusedSecrets: SecretName[];
  secretsBasis: 'not-compiled' | 'ui-only' | 'http';
  writeSteps: WriteStepView[];
  writeSummary: 'none' | 'login-only' | 'actions';
  steps: StepView[];
  stepCount: number;
  finalScreenId?: string;
  hasResultZone: boolean;
  timeoutMs?: number;
}

export function buildWorkflowView(set: WorkflowSet, workflow: Workflow, outputs: StudioOutputs, status?: SecretStatusSource): WorkflowView {
  const steps = (workflow.steps ?? []).slice(0, MAX_STEPS_PER_WORKFLOW);
  const risk = { read: 0, write: 0, delete: 0 };
  for (const step of workflow.steps ?? []) risk[step.risk ?? 'read'] += 1;
  const toolName = outputs.nameMap?.[workflow.id];
  const http = outputs.flags.compiled && outputs.flags.http;
  const { required, unused } = workflowSecrets(workflow, { http }, status);
  return {
    id: workflow.id,
    label: clipText(workflow.label ?? '', 200),
    ...(toolName === undefined ? {} : { toolName: clipText(toolName, 80) }),
    ...(text(workflow.description, 400) === undefined ? {} : { description: text(workflow.description, 400) }),
    target: { name: clipText(set.targetName ?? '', 100), type: set.targetType },
    risk: { ...risk, highest: risk.delete > 0 ? 'delete' : risk.write > 0 ? 'write' : 'read' },
    variables: (workflow.variables ?? []).map((v) => ({
      name: clipText(v.name, 60),
      type: v.type ?? 'string',
      ...(text(v.description, 300) === undefined ? {} : { description: text(v.description, 300) }),
      optional: v.optional === true,
      ...(v.optional === true ? { whenOmitted: v.whenOmitted ?? ('useRecorded' as const) } : {}),
    })),
    ...(workflow.startUrl !== undefined && workflow.startUrl !== set.startUrl && displayUrl(workflow.startUrl) !== undefined ? { startPage: displayUrl(workflow.startUrl) } : {}),
    secrets: required,
    unusedSecrets: unused,
    secretsBasis: !outputs.flags.compiled ? ('not-compiled' as const) : http ? ('http' as const) : ('ui-only' as const),
    ...writeStepsOf(workflow),
    steps: steps.map((step, index) => stepView(step, index, set.targetType)),
    stepCount: (workflow.steps ?? []).length,
    ...(workflow.finalScreenId === undefined ? {} : { finalScreenId: workflow.finalScreenId }),
    hasResultZone: workflow.resultZone !== undefined,
    ...(workflow.timeoutMs === undefined ? {} : { timeoutMs: workflow.timeoutMs }),
  };
}

export function buildWorkflows(targets: readonly StudioTarget[], status?: SecretStatusSource): { workflows: WorkflowView[]; truncated: boolean } {
  const all = targets.flatMap((t) => (t.set.workflows ?? []).map((w) => buildWorkflowView(t.set, w, t.outputs, status)));
  return { workflows: all.slice(0, MAX_WORKFLOWS), truncated: all.length > MAX_WORKFLOWS };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface TargetOverview {
  type: 'web' | 'tui';
  name: string;
  /** Web: origin and path of the start page. Terminal: the program (basename) and the number of arguments. */
  start?: string;
  storageState?: string;
  workflows: number;
  steps: number;
  variables: number;
  secrets: string[];
  stepsByLevel: Record<PrimaryLevel, number>;
  /** Mode support: what was compiled into the output directory. */
  modes: { compiled: boolean; strict: true; healSupport: boolean; http: boolean };
  sandbox: { image?: string; network: 'none' | 'bridge'; packages: string[]; installCommands: number; mounts: number };
  testsGenerated: boolean;
}

export function buildTargetOverview(target: StudioTarget): TargetOverview {
  const { set, outputs } = target;
  const stepsByLevel: Record<PrimaryLevel, number> = { http: 0, accessibility: 0, vision: 0, coordinates: 0, terminal: 0, none: 0 };
  let steps = 0;
  const secrets = new Set<string>();
  for (const workflow of set.workflows ?? []) {
    for (const step of workflow.steps ?? []) {
      steps += 1;
      stepsByLevel[classifyStep(step, set.targetType).primaryLevel] += 1;
    }
    for (const secret of workflowSecrets(workflow, { http: outputs.flags.compiled && outputs.flags.http }).required) secrets.add(secret.name);
  }
  const command = set.startCommand;
  const start =
    set.targetType === 'web'
      ? displayUrl(set.startUrl)
      : command === undefined || command.length === 0
        ? undefined
        : clipText(`${basename(command[0].replace(/\\/g, '/'))}${command.length > 1 ? ` (+${command.length - 1} argument${command.length > 2 ? 's' : ''})` : ''}`, 120);
  const sandbox = set.sandbox;
  return {
    type: set.targetType,
    name: clipText(set.targetName ?? '', 100),
    ...(start === undefined ? {} : { start }),
    ...(set.storageState === undefined ? {} : { storageState: basename(set.storageState.replace(/\\/g, '/')) }),
    workflows: (set.workflows ?? []).length,
    steps,
    variables: (set.workflows ?? []).reduce((n, w) => n + (w.variables ?? []).length, 0),
    secrets: [...secrets].sort(),
    stepsByLevel,
    modes: { compiled: outputs.flags.compiled, strict: true, healSupport: outputs.flags.healSupport, http: outputs.flags.http },
    sandbox: {
      ...(sandbox?.image === undefined ? {} : { image: clipText(sandbox.image, 120) }),
      network: sandbox?.network ?? (set.targetType === 'tui' ? 'none' : 'bridge'),
      packages: (sandbox?.packages ?? []).slice(0, 100).map((p) => clipText(p, 80)),
      installCommands: (sandbox?.install ?? []).length,
      mounts: (sandbox?.mounts ?? []).length,
    },
    testsGenerated: outputs.flags.pbtGenerated,
  };
}

export interface Overview {
  sample: boolean;
  targetType?: 'web' | 'tui';
  targetName?: string;
  targets: TargetOverview[];
}

export function buildOverview(targets: readonly StudioTarget[], sample: boolean): Overview {
  const views = targets.map(buildTargetOverview);
  return { sample, ...(views[0] === undefined ? {} : { targetType: views[0].type, targetName: views[0].name }), targets: views };
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  label: string;
  kind: 'start' | 'step' | 'final' | 'screen';
  type?: string;
  workflowId?: string;
  observations?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  action?: string;
  workflowId?: string;
  level?: PrimaryLevel;
}

export interface GraphView {
  source: 'state-graph' | 'workflows';
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** True when a parsed file looks like a State_Graph (screens keyed by id, a list of transitions). */
export function looksLikeStateGraph(value: unknown): boolean {
  const g = asObject(value);
  return g !== undefined && asObject(g.screens) !== undefined && Array.isArray(g.transitions);
}

/**
 * The graph of a State_Graph file: screens and transitions, never the snapshots, which hold what was on screen.
 */
export function buildStateGraphView(graph: unknown): GraphView {
  const g = asObject(graph) ?? {};
  const screens = Object.entries(asObject(g.screens) ?? {});
  const transitions = Array.isArray(g.transitions) ? g.transitions : [];
  const nodes: GraphNode[] = screens.slice(0, MAX_GRAPH_NODES).map(([id, raw]) => {
    const s = asObject(raw) ?? {};
    return {
      id: clipText(id, 64),
      label: text(s.label, 80) ?? clipText(id, 16),
      kind: 'screen' as const,
      ...(typeof s.type === 'string' ? { type: clipText(s.type, 20) } : {}),
      ...(typeof s.observationCount === 'number' ? { observations: s.observationCount } : {}),
    };
  });
  const known = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  for (const raw of transitions) {
    const t = asObject(raw);
    if (t === undefined || typeof t.sourceScreenId !== 'string' || typeof t.destinationScreenId !== 'string') continue;
    if (!known.has(t.sourceScreenId) || !known.has(t.destinationScreenId)) continue;
    if (edges.length >= MAX_GRAPH_EDGES) break;
    edges.push({
      id: clipText(typeof t.id === 'string' ? t.id : `${t.sourceScreenId}>${t.destinationScreenId}`, 80),
      from: t.sourceScreenId,
      to: t.destinationScreenId,
      label: text(t.label, 80) ?? '',
      ...(typeof t.actionType === 'string' ? { action: clipText(t.actionType, 20) } : {}),
    });
  }
  return { source: 'state-graph', nodes, edges, truncated: screens.length > nodes.length || transitions.length > edges.length };
}

/** A graph derived from the workflows: the start, the screen after each step, and the recorded final screen. */
export function buildWorkflowGraph(targets: readonly StudioTarget[]): GraphView {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let truncated = false;
  const addNode = (node: GraphNode): boolean => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= MAX_GRAPH_NODES) {
      truncated = true;
      return false;
    }
    nodes.set(node.id, node);
    return true;
  };
  for (const { set } of targets) {
    const startId = `start:${set.targetName}`;
    addNode({ id: startId, label: clipText(set.targetName || 'start', 60), kind: 'start' });
    for (const workflow of set.workflows ?? []) {
      let previous = startId;
      const steps = workflow.steps ?? [];
      for (let i = 0; i < steps.length; i++) {
        const last = i === steps.length - 1;
        const id = last && workflow.finalScreenId !== undefined ? `screen:${workflow.finalScreenId}` : `${workflow.id}:${i}`;
        const added = addNode(
          last
            ? { id, label: clipText(workflow.label, 60), kind: 'final', workflowId: workflow.id }
            : { id, label: text(steps[i].label, 60) ?? `${steps[i].actionType} ${i + 1}`, kind: 'step', workflowId: workflow.id }
        );
        if (!added || edges.length >= MAX_GRAPH_EDGES) {
          truncated = true;
          break;
        }
        edges.push({
          id: `${workflow.id}:${i}`,
          from: previous,
          to: id,
          label: text(steps[i].label, 60) ?? steps[i].actionType,
          action: steps[i].actionType,
          workflowId: workflow.id,
          level: classifyStep(steps[i], set.targetType).primaryLevel,
        });
        previous = id;
      }
    }
  }
  return { source: 'workflows', nodes: [...nodes.values()], edges, truncated };
}

export function buildGraph(targets: readonly StudioTarget[], stateGraph?: unknown): GraphView {
  return stateGraph !== undefined && looksLikeStateGraph(stateGraph) ? buildStateGraphView(stateGraph) : buildWorkflowGraph(targets);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface ToolSchemas {
  workflowId: string;
  toolName?: string;
  label: string;
  inputSchema: unknown;
  outputSchema: unknown;
  openapiPath?: string;
}

export interface SchemasView {
  tools: ToolSchemas[];
  openapi: Array<{ title: string; version: string; openapi: string; paths: Array<{ path: string; method: string; operationId?: string; summary?: string }> }>;
}

function schemaFromOpenapi(op: Record<string, unknown> | undefined, where: 'request' | 'response'): unknown {
  if (op === undefined) return undefined;
  const body = where === 'request' ? asObject(op.requestBody) : asObject(asObject(op.responses)?.['200']);
  return asObject(asObject(asObject(body?.content)?.['application/json'])?.schema);
}

export function buildSchemas(targets: readonly StudioTarget[]): SchemasView {
  const tools: ToolSchemas[] = [];
  const openapi: SchemasView['openapi'] = [];
  for (const { set, outputs } of targets) {
    const doc = asObject(outputs.openapi);
    const paths = asObject(doc?.paths) ?? {};
    const info = asObject(doc?.info);
    if (doc !== undefined) {
      const rows: SchemasView['openapi'][number]['paths'] = [];
      for (const [path, item] of Object.entries(paths).slice(0, 500)) {
        for (const [method, op] of Object.entries(asObject(item) ?? {})) {
          const o = asObject(op);
          if (o === undefined) continue;
          rows.push({
            path: clipText(path, 120),
            method: method.toUpperCase(),
            ...(typeof o.operationId === 'string' ? { operationId: clipText(o.operationId, 80) } : {}),
            ...(typeof o.summary === 'string' ? { summary: clipText(o.summary, 120) } : {}),
          });
        }
      }
      openapi.push({
        title: typeof info?.title === 'string' ? clipText(info.title, 100) : set.targetName,
        version: typeof info?.version === 'string' ? clipText(info.version, 20) : '',
        openapi: typeof doc.openapi === 'string' ? clipText(doc.openapi, 10) : '',
        paths: rows,
      });
    }
    for (const workflow of set.workflows ?? []) {
      const path = `/actions/${workflow.id}`;
      const op = asObject(asObject(paths[path])?.post);
      const toolName = outputs.nameMap?.[workflow.id];
      tools.push({
        workflowId: workflow.id,
        ...(toolName === undefined ? {} : { toolName }),
        label: clipText(workflow.label ?? '', 200),
        inputSchema: schemaFromOpenapi(op, 'request') ?? workflow.inputSchema ?? { type: 'object' },
        outputSchema: schemaFromOpenapi(op, 'response') ?? workflow.outputSchema ?? { type: 'object' },
        ...(op === undefined ? {} : { openapiPath: path }),
      });
    }
  }
  return { tools, openapi };
}

// ---------------------------------------------------------------------------
// Property-based test results
// ---------------------------------------------------------------------------

export interface PbtView {
  /** A result exists (a run was made). */
  available: boolean;
  running: boolean;
  /** Tools whose test file exists; they show as "not run" until a run completes. */
  generatedTools: string[];
  result?: PbtRunResult;
}

export function buildPbtView(result: PbtRunResult | undefined, targets: readonly StudioTarget[], running: boolean): PbtView {
  const generated = targets.flatMap((t) => t.outputs.testTools ?? []);
  return { available: result !== undefined, running, generatedTools: [...new Set(generated)].sort(), ...(result === undefined ? {} : { result }) };
}
