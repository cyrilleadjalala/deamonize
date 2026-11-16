import type { StepFailure } from './replay/runtime/step-plan.js';
import type { PatternTimeoutFailure } from './replay/runtime/pattern-wait.js';
export type { StepFailure };

// Branded type for screen identifiers (16-char hex)
export type ScreenId = string & { readonly _brand: 'ScreenId' };

// Screen content captured from the sandbox
export interface ScreenContent {
  type: 'dom' | 'terminal';
  raw: string;           // raw DOM outerHTML or terminal buffer text
  normalized: string;    // canonical form used for hashing
  capturedAt: number;    // Unix ms timestamp
}

// A user action recorded during a session
export interface RecordedAction {
  actionType: 'click' | 'keypress' | 'form_submit' | 'type' | 'select';
  selector?: string;    // CSS selector (web) or element label (TUI)
  value?: string;       // typed text, selected option value, key name
  label?: string;       // human-readable label derived from UI context
  timeoutMs?: number;   // step timeout (action and effect wait) when replaying; overrides the default
  /** Terminal: wait for this pattern of the rendered screen instead of a moment of silence. */
  waitFor?: ScreenWait;
  /** Terminal: what is left of the whole replay in ms; a pattern wait never lasts longer. */
  waitBudgetMs?: number;
}

// A transition edge in the State Graph
export interface Transition {
  id: string;                             // UUID
  sourceScreenId: ScreenId;
  destinationScreenId: ScreenId;
  actionType: RecordedAction['actionType'];
  label: string;
  selector?: string;
  inputSchema?: Record<string, unknown>;   // JSON Schema object
  outputSchema?: Record<string, unknown>;  // JSON Schema object
  observedPayloads: Record<string, unknown>[];
}

// A screen node in the State Graph
export interface Screen {
  id: ScreenId;
  type: 'dom' | 'terminal';
  normalizedHash: string;    // full SHA-256 hex (64 chars)
  snapshot: string;          // raw screen content at first observation
  label?: string;
  firstSeenAt: string;       // ISO 8601 date-time
  observationCount: number;
}

// The full State Graph (nodes + edges)
export interface StateGraph {
  version: '1';
  createdAt: string;    // ISO 8601
  updatedAt: string;    // ISO 8601
  screens: Record<string, Screen>;      // keyed by ScreenId
  transitions: Transition[];
}

// State Graph with inferred schemas attached
export interface AnnotatedStateGraph extends StateGraph {
  targetName: string;
}

// A single step of a recorded workflow
/** Action types of a recorded step: the user actions plus the preparatory and page-switching steps of the web recorder. */
export type StepActionType = RecordedAction['actionType'] | 'hover' | 'scrollIntoView' | 'switch_page';

export interface WorkflowStep {
  actionType: StepActionType;
  // Candidate selectors tried in order (e.g. accessibility role/name first,
  // CSS selector as fallback). The first one that resolves is used.
  selectors: string[];
  value?: string;       // constant value (typed text, option, key name)
  variable?: string;    // name of the workflow variable that supplies the value
  label?: string;
  anchor?: Anchor;                       // Level 2 accessibility locator
  rowBinding?: RowBinding;               // Level 2, dynamic lists and tables
  http?: HttpRecipe;                     // Level 1 candidate
  visual?: VisualAnchor;                 // Level 3 (Heal_Mode only)
  risk?: StepRisk;                       // default 'read'
  allowHeal?: boolean;                   // write/delete steps: explicit opt-in to Level 3
  secretRef?: string;                    // name N of DAEMONIZE_SECRET_<N>, typed at run time
  totp?: boolean;                        // with secretRef: type the current TOTP code
  resultZone?: ResultZone;
  waitFor?: ScreenWait;                  // terminal only
  timeoutMs?: number;                    // per-step timeout
}

export type StepRisk = 'read' | 'write' | 'delete';

export interface Anchor {
  role: string;
  name: string;
  parent?: { kind: 'dialog' | 'region' | 'heading' | 'label'; name: string };
  frame: number[];                       // iframe index chain; [] for the main frame
  frameHints?: Array<{ name?: string; title?: string; src?: string }>;   // one hint per frame of the chain
  popup?: { page: number; opens?: boolean };
}

/**
 * The row, card or list item a step happens in. At replay the row is found by
 * the value of `variable` (or by `key.text` when there is no Variable) and the
 * selectors of the step are applied inside it.
 */
export interface RowBinding {
  container: { kind?: 'row' | 'card' | 'listitem'; role?: string; selectorHint?: string };
  key?: { text: string; column?: string };
  variable?: string;
}

/** A reference to a secret by name; the value is read from DAEMONIZE_SECRET_<NAME> at run time. */
export interface SecretValueRef {
  $secret: string;
}

export interface HttpRecipe {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  query: Record<string, string | SecretValueRef>;
  /** JSON (or form fields); a leaf bound to a Variable is `{"$var":"name"}` (`as`: the leaf was a number or a boolean). */
  body?: unknown;
  bodyFormat?: 'json' | 'form' | 'text';
  // Sensitive headers may only be Secret_Reference objects, never literals
  headers?: Record<string, string | SecretValueRef>;
  /**
   * Where a Variable value was found. `name`: the query key or header name; the JSON pointer of the leaf
   * (`/customer/emails/0`) for a body; the index of the segment in `pathname.split('/')` for a path.
   * Bound path segments and query values appear as `{{variable}}` in `url` and `query`.
   */
  bindings: Array<{ variable: string; in: 'query' | 'body' | 'path' | 'header'; name: string }>;
  redacted: Array<{ in: 'header' | 'query' | 'body'; name: string; secret: string }>;
  /** Where the authentication comes from at replay time; never a value. */
  auth?: 'storageState' | 'none' | `env:${string}`;
  expectStatus?: number;
  /** Shape (names and types, never values) of the JSON response, for the output schema. */
  responseShape?: Record<string, unknown>;
}

export interface VisualAnchor {
  thumbnailPath?: string;               // relative to the workflow file; absent when no thumbnail was captured
  rect: { x: number; y: number; w: number; h: number };   // fractions of the viewport in [0, 1]
  intent: string;
}

/**
 * Wait for the rendered terminal screen (see replay/runtime/pattern-wait.ts). Exactly one of `pattern`
 * (JavaScript RegExp source, flags in `flags`, default `m`) and `text` (literal) is set.
 */
export interface ScreenWait {
  pattern?: string;
  text?: string;
  flags?: string;
  region?: { row: number; col: number; rows: number; cols: number };
  mode?: 'appear' | 'disappear';         // default appear
  timeoutMs: number;
  when?: 'before' | 'after';
}

/**
 * How the content of a Result_Zone becomes JSON. Web: text, table (array of objects keyed by header),
 * list (array of strings), fields (label/value object), json (the zone text parsed), attribute (the value
 * of an input, or the named attribute). Terminal: text, regex (named capture groups; `g` in flags gives every match).
 */
export type ExtractorKind = 'text' | 'table' | 'list' | 'fields' | 'json' | 'attribute' | 'regex';

export type Extractor =
  | { kind: 'text' | 'table' | 'list' | 'fields' | 'json' }
  | { kind: 'attribute'; name?: string }
  | { kind: 'regex'; pattern: string; flags?: string };

/** The part of the final screen a call returns, and how it is turned into `data`. */
export interface ResultZone {
  selector?: string;                                   // web: element holding the result
  rect?: { row: number; col: number; rows: number; cols: number }; // terminal: crop of the rendered screen
  extractor?: Extractor;                               // default: text
  schema?: Record<string, unknown>;                    // JSON Schema of `data`, inferred when recording
}

export interface SecretReference {
  name: string;
  kind: 'password' | 'totp' | 'token' | 'header';
}

export interface SandboxSpec {
  image?: string;
  packages?: string[];
  install?: string[];
  network?: 'none' | 'bridge';
  user?: string;                           // unprivileged user of the program in the container
  workdir?: string;                        // working directory of the program in the container (absolute)
  mounts?: string[];                       // host:container[:ro], added to those of `serve --mount`
}

// A field the user marked as variable while recording a workflow
export interface WorkflowVariable {
  name: string;
  type?: 'string' | 'number' | 'boolean';   // default 'string'
  description?: string;
  optional?: boolean;
}

export interface FinalZone {
  selector?: string;
  rect?: { row: number; col: number; rows: number; cols: number };
}

// A complete recorded path from a known start state; one MCP tool per workflow
export interface Workflow {
  id: string;                              // UUID
  label: string;
  steps: WorkflowStep[];
  variables: WorkflowVariable[];
  finalScreenId?: ScreenId;                // used for drift detection only
  // Restricts the drift hash to a part of the final screen (web: CSS selector;
  // terminal: rectangle, 0-based). finalScreenId is then the hash of that zone.
  finalZone?: FinalZone;
  // What the call returns instead of the whole screen: the structured data of this zone
  resultZone?: ResultZone;
  observedPayloads: Record<string, unknown>[];
  inputSchema?: Record<string, unknown>;   // JSON Schema object
  outputSchema?: Record<string, unknown>;  // JSON Schema object
  cols?: number;                           // terminal: recorded columns (80 when absent)
  rows?: number;                           // terminal: recorded rows (24 when absent)
  // Secret names only, never values. Plain names or {name, kind} entries.
  secrets?: Array<string | SecretReference>;
  timeoutMs?: number;                      // per-workflow replay timeout
}

// The set of workflows recorded for one Target_Application
export interface WorkflowSet {
  version: '1';
  targetType: 'web' | 'tui';
  targetName: string;
  startUrl?: string;                       // web only
  startCommand?: string[];                 // tui only: the program and its arguments
  storageState?: string;                   // Playwright storage state file (logged-in start state)
  sandbox?: SandboxSpec;
  timeoutMs?: number;                      // default replay timeout
  workflows: Workflow[];
}

// Structured content extracted from the final screen of a workflow
export interface WorkflowResult {
  screenType: 'dom' | 'terminal';
  title?: string;
  text: string;
  data?: unknown;                    // structured content of the Result_Zone, when the workflow has one
}

// Daemonize runtime configuration
export interface DaemonizeConfig {
  targetType: 'web' | 'tui';
  targetUrl?: string;
  targetCommand?: string[];
  outputDir: string;
  stateGraphPath?: string;
  targetName: string;
  sandbox: {
    memoryMb: number;    // default 512
    cpuCount: number;    // default 1
  };
  replayTimeoutMs: number;      // default 10000
  snapshotIntervalMs: number;   // minimum 100
}

// Output of the Compiler
export interface CompileResult {
  openApiSpec: Record<string, unknown>;
  mcpServerSource: string;
  kiroPower: {
    plugin: Record<string, unknown>;
    mcp: Record<string, unknown>;
    skill: string;
    powerMd: string;
  };
  toolNames: Map<string, string>;    // workflowId → toolName
}

// Result of a workflow replay
export interface ReplayResult {
  success: boolean;
  screen?: ScreenContent;
  result?: WorkflowResult;
  drifted?: boolean;                 // final screen differs from the recorded one
  /** Terminal replays: the size the screen was rendered at. */
  terminalSize?: { cols: number; rows: number };
  /** Why `drifted` is true when the screen text alone does not say (e.g. another terminal size). */
  driftReason?: string;
  error?: 'timeout' | 'sandbox_unavailable' | 'step_failed' | string;
  /** Strict failure (error 'step_failed'): the step that no locator could perform; no later step ran. */
  failure?: StepFailure | PatternTimeoutFailure | { zone: { selector?: string; rect?: { row: number; col: number; rows: number; cols: number } } };
  /** Set with error 'result_zone_not_found' / 'result_extraction_failed': says the action itself already ran. */
  message?: string;
  elapsedMs: number;
}

// Validation error from the Validator
export interface ValidationError {
  errors: Array<{
    instancePath: string;
    schemaPath: string;
    message: string;
  }>;
}
