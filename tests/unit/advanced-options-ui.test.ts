import { afterEach, describe, expect, it, vi } from 'vitest';
// The UI modules are plain browser JavaScript: they run here on a small in-memory DOM.

type Listener = (event: unknown) => unknown;

class FNode {
  parent: FEl | undefined;
  get isConnected(): boolean {
    return true;
  }
}
class FText extends FNode {
  constructor(public data: string) {
    super();
  }
}
class FEl extends FNode {
  attrs = new Map<string, string>();
  children: FNode[] = [];
  listeners = new Map<string, Listener[]>();
  hidden = false;
  checked = false;
  disabled = false;
  style: Record<string, string> = {};
  constructor(public tag: string) {
    super();
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  get classes(): string[] {
    return (this.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
  }
  detach(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = undefined;
  }
  appendChild(child: FNode): FNode {
    if (child instanceof FEl) child.detach();
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes: FNode[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  get firstChild(): FNode | undefined {
    return this.children[0];
  }
  replaceChildren(...nodes: FNode[]): void {
    this.children = [];
    this.append(...nodes);
  }
  replaceWith(node: FNode): void {
    const parent = this.parent;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    node.parent = parent;
    parent.children.splice(at, 1, node);
    this.parent = undefined;
  }
  get textContent(): string {
    return this.children.map((c) => (c instanceof FText ? c.data : (c as FEl).textContent)).join('');
  }
  set textContent(value: string) {
    this.children = [];
    this.appendChild(new FText(value));
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  async fire(type: string): Promise<void> {
    for (const fn of this.listeners.get(type) ?? []) await fn({ type });
  }
  focus(): void { }
  matches(part: string): boolean {
    const re = /([.#]?)([\w-]+)/g;
    for (const m of part.matchAll(re)) {
      if (m[1] === '.' && !this.classes.includes(m[2]!)) return false;
      if (m[1] === '#' && this.id !== m[2]) return false;
      if (m[1] === '' && this.tag !== m[2]) return false;
    }
    return true;
  }
  all(): FEl[] {
    return this.children.flatMap((c) => (c instanceof FEl ? [c, ...c.all()] : []));
  }
  querySelectorAll(selector: string): FEl[] {
    const parts = selector.split(/\s+/);
    return this.all().filter((el) => {
      if (!el.matches(parts[parts.length - 1]!)) return false;
      let at: FEl | undefined = el.parent;
      for (let i = parts.length - 2; i >= 0; i -= 1) {
        while (at && !at.matches(parts[i]!)) at = at.parent;
        if (!at) return false;
        at = at.parent;
      }
      return true;
    });
  }
  querySelector(selector: string): FEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const compiledTarget = (modes: Record<string, unknown>, type = 'web') => ({
  name: 'crm',
  type,
  start: 'https://x.test',
  workflows: 1,
  steps: 2,
  variables: 0,
  stepsByLevel: { http: 1 },
  modes: { compiled: true, strict: true, healSupport: false, http: false, ...modes },
  sandbox: { network: 'bridge', packages: [] },
  secrets: [],
});

let overviewBody: Record<string, unknown>;
let posts: Array<Record<string, unknown>>;
let statusAnswers: Array<Record<string, unknown>>;
let overviewReads: number;

function installGlobals(): void {
  const document = {
    createElementNS: (_ns: string, tag: string) => new FEl(tag),
    createTextNode: (text: string) => new FText(text),
    getElementById: () => null,
    querySelector: () => null,
    body: new FEl('body'),
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('Node', FNode);
  vi.stubGlobal('window', { setTimeout: (fn: () => void) => setTimeout(fn, 0), location: { hash: '' } });
  vi.stubGlobal('location', { hash: '' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
      if (init?.method === 'POST' && path === '/api/compile') {
        posts.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
        return json(202, { state: 'running' });
      }
      if (path === '/api/compile/status') return json(200, statusAnswers.shift() ?? { state: 'done', phase: null });
      if (path === '/api/overview') {
        overviewReads += 1;
        return json(200, overviewBody);
      }
      if (path === '/api/workflows') return json(200, { workflows: [{ target: { name: 'crm', type: 'web' }, toolName: 't' }] });
      if (path === '/api/pbt') return json(200, null);
      return json(404, { error: 'not found' });
    })
  );
}

const find = (root: FEl, id: string): FEl => {
  const el = root.querySelector(`#${id}`);
  if (!el) throw new Error(`no #${id}`);
  return el;
};

describe('Advanced options of the recompile screen', () => {
  let recompileControl: (opts?: { target?: unknown; onDone?: () => unknown }) => FEl & { applyTarget: (t: unknown) => void };
  let renderOverview: () => Promise<FEl>;
  let COPY_COMPILE: Record<string, string>;

  // A fresh copy of the modules per test: api.js keeps a page cache of GET answers
  const reset = async (): Promise<void> => {
    vi.resetModules();
    installGlobals();
    overviewBody = { targets: [compiledTarget({})], outputCompiled: false };
    posts = [];
    statusAnswers = [];
    overviewReads = 0;
    // @ts-expect-error no type declarations for the browser modules
    ({ recompileControl } = await import('../../src/studio/ui/js/views/recompile.js'));
    // @ts-expect-error no type declarations for the browser modules
    ({ renderOverview } = await import('../../src/studio/ui/js/views/overview.js'));
    // @ts-expect-error no type declarations for the browser modules
    ({ COPY_COMPILE } = await import('../../src/studio/ui/js/copy-compile.js'));
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('shows both checkboxes unchecked, before the Recompile button, with the sentences hidden', async () => {
    await reset();
    const control = recompileControl();
    const group = find(control, 'advanced-options');
    expect(control.children[0]).toBe(group);
    expect(control.children[1]).toBe(find(control, 'rebuild-btn'));
    expect(group.textContent).toContain('Advanced options');
    expect(group.textContent).toContain('Run recorded requests directly (faster, no page)');
    expect(group.textContent).toContain('Repair steps with a vision model when a page changes');
    expect(find(control, 'opt-http').checked).toBe(false);
    expect(find(control, 'opt-heal').checked).toBe(false);
    expect(find(control, 'opt-http-note').hidden).toBe(true);
    expect(find(control, 'opt-heal-note').hidden).toBe(true);
    expect(COPY_COMPILE.healNote).toContain('heal unavailable');
    expect(COPY_COMPILE.httpNote).toContain('not retried on the page');
  });

  it('shows each sentence while its checkbox is checked', async () => {
    await reset();
    const control = recompileControl();
    const heal = find(control, 'opt-heal');
    heal.checked = true;
    await heal.fire('change');
    expect(find(control, 'opt-heal-note').hidden).toBe(false);
    expect(find(control, 'opt-http-note').hidden).toBe(true);
    const http = find(control, 'opt-http');
    http.checked = true;
    await http.fire('change');
    expect(find(control, 'opt-http-note').hidden).toBe(false);
  });

  it('sets the checkboxes from the modes of the compiled output', async () => {
    await reset();
    const control = recompileControl({ target: compiledTarget({ http: true, healSupport: true }) });
    expect(find(control, 'opt-http').checked).toBe(true);
    expect(find(control, 'opt-heal').checked).toBe(true);
    control.applyTarget(compiledTarget({ http: false, healSupport: true }));
    expect(find(control, 'opt-http').checked).toBe(false);
    expect(find(control, 'opt-heal').checked).toBe(true);
    control.applyTarget(compiledTarget({ http: 'auto' }));
    expect(find(control, 'opt-http').checked).toBe(true);
  });

  it('disables and unchecks both for a terminal target and says they apply to web actions', async () => {
    await reset();
    const control = recompileControl({ target: compiledTarget({ http: true, healSupport: true }, 'terminal') });
    for (const id of ['opt-http', 'opt-heal']) {
      expect(find(control, id).disabled).toBe(true);
      expect(find(control, id).checked).toBe(false);
    }
    expect(find(control, 'opt-terminal-note').hidden).toBe(false);
    expect(find(control, 'opt-terminal-note').textContent).toContain('web actions');
  });

  it('sends the checked options in the body of the request', async () => {
    await reset();
    const control = recompileControl();
    await find(control, 'rebuild-btn').fire('click');
    expect(posts).toEqual([{ http: 'off', healSupport: false }]);
    find(control, 'opt-http').checked = true;
    find(control, 'opt-heal').checked = true;
    await find(control, 'rebuild-btn').fire('click');
    expect(posts[1]).toEqual({ http: 'auto', healSupport: true });
  });

  it('refreshes the HTTP and Heal flags and the checkboxes right after a build ends in done', async () => {
    await reset();
    overviewBody = { targets: [compiledTarget({})], outputCompiled: false };
    const root = await renderOverview();
    const on = (name: string): string | null => root.querySelectorAll('li.flag').find((li) => li.getAttribute('data-flag') === name)?.getAttribute('data-on') ?? null;
    expect(on('http')).toBe('false');
    expect(on('heal')).toBe('false');
    overviewBody = { targets: [compiledTarget({ http: true, healSupport: true })], outputCompiled: false };
    const started = Date.now();
    await find(root, 'rebuild-btn').fire('click');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(on('http')).toBe('true');
    expect(on('heal')).toBe('true');
    expect(find(root, 'opt-http').checked).toBe(true);
    expect(find(root, 'opt-heal').checked).toBe(true);
  });

  it('renders no Advanced options group in sample mode', async () => {
    await reset();
    overviewBody = { targets: [compiledTarget({})], sample: true };
    const root = await renderOverview();
    expect(root.querySelector('#advanced-options')).toBeNull();
    expect(root.querySelector('#rebuild-btn')).toBeNull();
  });

  it('renders the group on the live overview', async () => {
    await reset();
    const root = await renderOverview();
    expect(root.querySelector('#advanced-options')).not.toBeNull();
  });
});
