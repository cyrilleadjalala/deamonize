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
export interface WorkflowStep {
  actionType: RecordedAction['actionType'];
  // Candidate selectors tried in order (e.g. accessibility role/name first,
  // CSS selector as fallback). The first one that resolves is used.
  selectors: string[];
  value?: string;       // constant value (typed text, option, key name)
  variable?: string;    // name of the workflow variable that supplies the value
  label?: string;
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
  observedPayloads: Record<string, unknown>[];
  inputSchema?: Record<string, unknown>;   // JSON Schema object
  outputSchema?: Record<string, unknown>;  // JSON Schema object
}

// The set of workflows recorded for one Target_Application
export interface WorkflowSet {
  version: '1';
  targetType: 'web' | 'tui';
  targetName: string;
  startUrl?: string;                       // web only
  startCommand?: string[];                 // tui only: the program and its arguments
  storageState?: string;                   // Playwright storage state file (logged-in start state)
  workflows: Workflow[];
}

// Structured content extracted from the final screen of a workflow
export interface WorkflowResult {
  screenType: 'dom' | 'terminal';
  title?: string;
  text: string;
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
  error?: 'timeout' | 'sandbox_unavailable' | string;
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
