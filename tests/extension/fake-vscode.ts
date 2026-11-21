/**
 * A fake of the `vscode` module for the `extension` vitest project (alias `vscode` -> this file).
 * It implements only what the glue in kiro-extension/src uses. Every call is recorded in `__calls`
 * (arguments only, never answers), and scripted answers are queued per method with `__script`.
 */

export interface RecordedCall { api: string; args: unknown[] }

export const __calls: RecordedCall[] = [];
/** Every output channel, status bar item and tree view created, so tests can read their text. */
export const __objects: Array<{ kind: 'outputChannel' | 'statusBarItem' | 'treeView'; value: any }> = [];
export const __commands = new Map<string, (...args: any[]) => unknown>();
export const __config: Record<string, unknown> = {};

type Answer = unknown | ((...args: any[]) => unknown);
let scripts: Record<string, Answer[]> = {};

function record(api: string, args: unknown[]): void {
  __calls.push({ api, args });
}

/** Takes the next scripted answer for `api`, or `fallback`. An Error answer is thrown. A function answer is called. */
function answer<T>(api: string, args: unknown[], fallback: T): T {
  const queue = scripts[api];
  if (queue && queue.length > 0) {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return (typeof next === 'function' ? (next as (...a: unknown[]) => unknown)(...args) : next) as T;
  }
  return fallback;
}

/** Queue answers by method name, for example `{ 'window.showInputBox': ['abc', undefined] }`. */
export function __script(answers: Record<string, Answer[]>): void {
  for (const [api, list] of Object.entries(answers)) scripts[api] = [...(scripts[api] ?? []), ...list];
}

export function __reset(): void {
  __calls.length = 0;
  __objects.length = 0;
  __commands.clear();
  __hostCommands.clear();
  for (const key of Object.keys(__config)) delete __config[key];
  scripts = {};
  workspace.workspaceFolders = undefined;
  env.clipboardText = '';
}

export function __callsTo(api: string): unknown[][] {
  return __calls.filter((c) => c.api === api).map((c) => c.args);
}

// ---------- plain classes and enums ----------

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();
  readonly event = (listener: (e: T) => unknown): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(e: T): void { for (const l of [...this.listeners]) l(e); }
  dispose(): void { this.listeners.clear(); }
}

export class ThemeColor {
  constructor(readonly id: string) { }
}

export class ThemeIcon {
  constructor(readonly id: string, readonly color?: ThemeColor) { }
}

export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }

export class TreeItem {
  description?: string | boolean;
  tooltip?: string;
  iconPath?: unknown;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  id?: string;
  constructor(public label: string, public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) { }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
    private readonly text: string,
  ) { }
  static parse(value: string, _strict?: boolean): Uri {
    const url = new URL(value);
    return new Uri(url.protocol.replace(/:$/, ''), url.host, url.pathname, url.search.replace(/^\?/, ''), url.hash.replace(/^#/, ''), value);
  }
  static file(path: string): Uri {
    return new Uri('file', '', path.replace(/\\/g, '/'), '', '', `file://${path}`);
  }
  get fsPath(): string { return this.path; }
  toString(): string { return this.text; }
}

// ---------- window ----------

function outputChannel(name: string) {
  const lines: string[] = [];
  const channel = {
    name,
    lines,
    appendLine(line: string) { record('outputChannel.appendLine', [line]); lines.push(line); },
    append(text: string) { record('outputChannel.append', [text]); lines.push(text); },
    show(...args: unknown[]) { record('outputChannel.show', args); },
    dispose() { record('outputChannel.dispose', []); },
  };
  __objects.push({ kind: 'outputChannel', value: channel });
  return channel;
}

function statusBarItem(alignment?: StatusBarAlignment, priority?: number) {
  const item = {
    alignment, priority,
    text: '', tooltip: undefined as string | undefined, command: undefined as unknown, name: undefined as string | undefined,
    visible: false,
    show() { record('statusBarItem.show', []); item.visible = true; },
    hide() { record('statusBarItem.hide', []); item.visible = false; },
    dispose() { record('statusBarItem.dispose', []); },
  };
  __objects.push({ kind: 'statusBarItem', value: item });
  return item;
}

function treeView(id: string, options: { treeDataProvider: unknown }) {
  const visibility = new EventEmitter<{ visible: boolean }>();
  const view = {
    id, options,
    visible: false,
    message: undefined as string | undefined,
    description: undefined as string | undefined,
    badge: undefined as unknown,
    onDidChangeVisibility: visibility.event,
    reveal: async (...args: unknown[]) => { record('treeView.reveal', args); },
    dispose() { record('treeView.dispose', [id]); },
    /** Test helper: the user expands or collapses the view. */
    __setVisible(visible: boolean) { view.visible = visible; visibility.fire({ visible }); },
  };
  __objects.push({ kind: 'treeView', value: view });
  return view;
}

export const window = {
  showInputBox: async (options?: unknown) => { record('window.showInputBox', [options]); return answer<string | undefined>('window.showInputBox', [options], undefined); },
  showQuickPick: async (items: unknown, options?: unknown) => { record('window.showQuickPick', [items, options]); return answer<unknown>('window.showQuickPick', [items, options], undefined); },
  /**
   * `message` and then the buttons (strings) or `{ modal }` options. Script the button the user presses by its title:
   * `__script({ 'window.showInformationMessage': ['Approve'] })`; no script means the notification was dismissed.
   */
  showInformationMessage: async (message: string, ...rest: unknown[]) => { record('window.showInformationMessage', [message, ...rest]); return answer<unknown>('window.showInformationMessage', [message, ...rest], undefined); },
  showWarningMessage: async (message: string, ...rest: unknown[]) => { record('window.showWarningMessage', [message, ...rest]); return answer<unknown>('window.showWarningMessage', [message, ...rest], undefined); },
  showErrorMessage: async (message: string, ...rest: unknown[]) => { record('window.showErrorMessage', [message, ...rest]); return answer<unknown>('window.showErrorMessage', [message, ...rest], undefined); },
  showOpenDialog: async (options?: unknown) => { record('window.showOpenDialog', [options]); return answer<unknown>('window.showOpenDialog', [options], undefined); },
  createOutputChannel: (name: string) => { record('window.createOutputChannel', [name]); return outputChannel(name); },
  createStatusBarItem: (alignment?: StatusBarAlignment, priority?: number) => { record('window.createStatusBarItem', [alignment, priority]); return statusBarItem(alignment, priority); },
  createTreeView: (id: string, options: { treeDataProvider: unknown }) => { record('window.createTreeView', [id]); return treeView(id, options); },
  /** Runs the task with a progress that records every `report` as `progress.report`, and a token that never cancels. */
  withProgress: async <T>(
    options: unknown,
    task: (progress: { report(v: unknown): void }, token: { isCancellationRequested: boolean; onCancellationRequested: EventEmitter<unknown>['event'] }) => Promise<T> | T,
  ): Promise<T> => {
    record('window.withProgress', [options]);
    const cancelled = new EventEmitter<unknown>();
    return task({ report: (v: unknown) => { record('progress.report', [v]); } }, { isCancellationRequested: false, onCancellationRequested: cancelled.event });
  },
};

// ---------- commands ----------

/** Command ids the host itself provides (for example a chat-opening command): `commands.getCommands` lists them with ours. */
export const __hostCommands = new Set<string>();

export const commands = {
  registerCommand(id: string, handler: (...args: any[]) => unknown) {
    record('commands.registerCommand', [id]);
    __commands.set(id, handler);
    return { dispose: () => { __commands.delete(id); } };
  },
  async executeCommand(id: string, ...args: unknown[]) {
    record('commands.executeCommand', [id, ...args]);
    const handler = __commands.get(id);
    return handler ? handler(...args) : undefined;
  },
  /** The ids of the registered commands and of `__hostCommands`. Calls are recorded; the answer is never scripted. */
  async getCommands(filterInternal?: boolean): Promise<string[]> {
    record('commands.getCommands', [filterInternal]);
    return [...new Set([...__commands.keys(), ...__hostCommands])];
  },
};

// ---------- memento (globalState) ----------

export interface FakeMemento {
  get<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

/** A `vscode.Memento`: values live in a Map; every `update` is recorded as `memento.update`. */
export function __createMemento(initial: Record<string, unknown> = {}): FakeMemento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string, fallback?: T): T | undefined { return (store.has(key) ? store.get(key) : fallback) as T | undefined; },
    async update(key: string, value: unknown) {
      record('memento.update', [key, value]);
      if (value === undefined) store.delete(key); else store.set(key, value);
    },
    keys() { return [...store.keys()]; },
  };
}

/** A fake `vscode.ExtensionContext` with a `globalState`, a `globalStorageUri` and the extension version. */
export function __createContext(options: { globalState?: Record<string, unknown>; globalStoragePath?: string; version?: string } = {}) {
  return {
    subscriptions: [] as Array<{ dispose(): unknown }>,
    globalState: __createMemento(options.globalState),
    globalStorageUri: Uri.file(options.globalStoragePath ?? '/global-storage/daemonize'),
    extensionPath: '/extension',
    extension: { packageJSON: { version: options.version ?? '0.1.0' } },
  };
}

// ---------- workspace ----------

const foldersChanged = new EventEmitter<unknown>();
const configChanged = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();

export const workspace: {
  workspaceFolders: Array<{ uri: Uri; name: string; index: number }> | undefined;
  getConfiguration(section?: string): { get<T>(key: string, fallback?: T): T | undefined; update(key: string, value: unknown, target?: unknown): Promise<void> };
  onDidChangeWorkspaceFolders: EventEmitter<unknown>['event'];
  onDidChangeConfiguration: EventEmitter<{ affectsConfiguration(section: string): boolean }>['event'];
} = {
  workspaceFolders: undefined,
  getConfiguration(section?: string) {
    const prefix = section ? `${section}.` : '';
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        const full = `${prefix}${key}`;
        return (full in __config ? __config[full] : fallback) as T | undefined;
      },
      async update(key: string, value: unknown, target?: unknown) {
        record('config.update', [`${prefix}${key}`, value, target]);
        __config[`${prefix}${key}`] = value;
      },
    };
  },
  onDidChangeWorkspaceFolders: foldersChanged.event,
  onDidChangeConfiguration: configChanged.event,
};

/** Test helpers for the workspace. */
export function __setFolders(paths: string[], scheme = 'file'): void {
  workspace.workspaceFolders = paths.map((p, index) => ({
    uri: scheme === 'file' ? Uri.file(p) : Uri.parse(`${scheme}://host${p.startsWith('/') ? '' : '/'}${p}`),
    name: p,
    index,
  }));
}
export function __fireFoldersChanged(): void { foldersChanged.fire({}); }

// ---------- env ----------

export const env: {
  openExternal(uri: Uri): Promise<boolean>;
  clipboard: { writeText(text: string): Promise<void>; readText(): Promise<string> };
  clipboardText: string;
} = {
  async openExternal(uri: Uri) {
    record('env.openExternal', [uri.toString()]);
    return answer<boolean>('env.openExternal', [uri], true);
  },
  clipboard: {
    async writeText(text: string) { record('env.clipboard.writeText', [text]); env.clipboardText = text; },
    async readText() { return env.clipboardText; },
  },
  clipboardText: '',
};

export const version = '1.85.0';
