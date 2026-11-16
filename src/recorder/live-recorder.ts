import type { Frame, Page } from 'playwright';
import { CAPTURE_SCRIPT } from './capture-script.js';
import { buildSelectors, buildZoneSelector, type ElementInfo } from './selector-builder.js';
import type { WorkflowRecorder } from './workflow-recorder.js';
import { NetworkCapture } from './network-capture.js';
import { buildHttpRecipe } from './http-correlate.js';
import type { Anchor, ExtractorKind, ResultZone, RowBinding, StepActionType, StepRisk, WorkflowVariable } from '../types.js';

/** The part of Playwright's binding source the recorder uses. */
interface BindingSource {
  frame: Frame;
}

/** Event sent by the capture script running inside the page. */
export interface CapturedEvent {
  actionType: StepActionType;
  info: ElementInfo;
  anchor?: Anchor;              // role, accessible name, parent context, frame path
  frameComplete?: boolean;      // false when the page could not walk up to the top document (cross-origin)
  value?: string;
  label?: string;
  secretRef?: string;           // the field holds a secret (PASSWORD, OTP, TOKEN): no value was captured
  submit?: boolean;             // click on a submit button of a form
  inForm?: boolean;             // Enter pressed in a field of a form
  rowBinding?: RowBinding;      // the target lies in a table row, card or list item
  rowTexts?: string[];          // texts of that row, to recognise the value of a variable in it
}

/** Where an event came from, when known by the recorder and not only by the page. */
export interface HandleContext {
  pageIndex?: number;           // 0 for the first page, then popups in opening order
  frame?: number[];             // frame path resolved by the recorder
  actionId?: number;            // network capture: id given when the event reached the recorder
}

export interface LiveRecorderOptions {
  /** Observe fetch/XHR requests to record Level 1 recipes (default false). */
  captureNetwork?: boolean;
}

/** Which replay level can be used for a step, and why not Level 1 when it cannot. */
export interface NetworkStepReport {
  step: number;
  label?: string;
  level: 'http' | 'accessibility';
  /** The request of the recipe, `METHOD url`, when level is http. */
  request?: string;
  /** Why the step has no Level 1 recipe. */
  reason?: string;
}

/** Request sent by the "Make variable" box shown in the page. */
export interface MarkVariableRequest {
  stepIndex: number;
  name: string;
  rowText?: string;             // a text selected in a row becomes the variable (stepIndex is then ignored)
}

export type MarkVariableResult = { ok: true } | { ok: false; error: string };

/** Request sent by the "Mark result" action shown in the page: the element the user clicked and the kind suggested for it. */
export interface MarkResultRequest {
  info: ElementInfo;
  kind: string;
}

export type MarkResultResult = { ok: true; selector: string; kind: ExtractorKind } | { ok: false; error: string };

const WEB_KINDS: readonly string[] = ['text', 'table', 'list', 'fields', 'json', 'attribute'];

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DELETE_NAME = /delete|remove|supprimer|drop|destroy|purge/i;
const WRITE_NAME = /save|create|add|submit|update|send|pay|enregistrer|créer|envoyer/i;
const CLICK_ROLES = new Set(['button', 'link', 'menuitem']);
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const MIN_SUBSTRING_LENGTH = 3;   // a shorter variable value only selects a row when a cell equals it
const POPUP_SETTLE_MS = 50;
const POPUP_LOAD_TIMEOUT_MS = 3000;

/**
 * Classify what a step may change in the application: clicks on buttons and
 * links named like a deletion are `delete`; form submissions and clicks named
 * like a save, creation or payment are `write`; everything else is `read`.
 */
export function classifyRisk(event: Pick<CapturedEvent, 'actionType' | 'info' | 'submit' | 'inForm'>): StepRisk {
  const name = event.info.name ?? '';
  const role = event.info.role ?? '';
  if (event.actionType === 'click') {
    const clickable = CLICK_ROLES.has(role) || event.submit === true;
    if (clickable && DELETE_NAME.test(name)) return 'delete';
    if (event.submit === true || (clickable && WRITE_NAME.test(name))) return 'write';
  }
  if (event.actionType === 'keypress' && event.inForm === true) return 'write';
  return 'read';
}

/**
 * Connects a Playwright page to a WorkflowRecorder: every click, typed value,
 * selection or Enter press the user performs in the page (or in its frames and
 * popups) becomes a step, and the user can turn typed or selected values into
 * variables from the page.
 *
 * A page can be attached to one LiveRecorder only.
 */
export class LiveRecorder {
  private steps = 0;
  private attached = false;
  private readonly fieldNames = new Map<number, string>();
  private readonly rowTexts = new Map<number, string[]>();
  private readonly pages: Page[];
  private current = 0;
  private readonly unannounced = new Set<number>();
  private readonly switchSteps = new Map<number, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private zone: ResultZone | undefined;
  private readonly network: NetworkCapture | undefined;
  private readonly stepActions = new Map<number, number>();

  constructor(
    private readonly page: Page,
    private readonly recorder: WorkflowRecorder,
    options: LiveRecorderOptions = {},
  ) {
    this.pages = [page];
    this.network = options.captureNetwork === true ? new NetworkCapture(page.context()) : undefined;
  }

  /**
   * Correlate the requests observed after each action with the Variables marked meanwhile, and attach the
   * Level 1 recipes to the steps. Call it once, after the Variables are marked and before `finish`.
   * Returns, per step, the level that can be used and why a step is not Level 1.
   */
  async finalizeNetwork(): Promise<NetworkStepReport[]> {
    if (this.network === undefined) return [];
    const byAction = await this.network.requestsByAction();
    this.network.stop();

    const values = [...this.recorder.variableValues()].map(([name, value]) => ({ name, value }));
    const reports: NetworkStepReport[] = [];
    // Variables typed since the last action that made a request: the next request has to carry them
    const pending: string[] = [];

    this.recorder.stepsSoFar().forEach((step, index) => {
      if (step.actionType === 'switch_page' || step.actionType === 'hover' || step.actionType === 'scrollIntoView') return;
      const base = step.label === undefined ? { step: index } : { step: index, label: step.label };
      if (step.variable !== undefined) pending.push(step.variable);

      const actionId = this.stepActions.get(index);
      const requests = actionId === undefined ? [] : byAction.get(actionId) ?? [];
      if (requests.length === 0) {
        const input = step.actionType === 'type' || step.actionType === 'select';
        reports.push({
          ...base,
          level: 'accessibility',
          reason: input
            ? 'input only: the value is sent by a later step'
            : 'no fetch/XHR request followed this action (page navigation, server-rendered form, or a change made in the page only)',
        });
        return;
      }

      const used = [...new Set([...pending, ...(step.rowBinding?.variable === undefined ? [] : [step.rowBinding.variable])])];
      pending.length = 0;

      const attempts = requests.map((request) => ({ request, ...buildHttpRecipe(values, request) }));
      const rank = (a: (typeof attempts)[number]): number => a.bound.length;
      const qualifying = attempts
        .filter((a) => a.recipe !== undefined && used.every((name) => a.bound.includes(name)))
        .reduce<(typeof attempts)[number] | undefined>((best, a) => (best === undefined || rank(a) >= rank(best) ? a : best), undefined);

      const risk = requests.map((r) => riskOfMethod(r.method)).reduce(maxRisk, 'read' as StepRisk);
      this.recorder.setHttp(index, qualifying?.recipe, risk);

      if (qualifying?.recipe !== undefined) {
        reports.push({ ...base, level: 'http', request: `${qualifying.recipe.method} ${qualifying.recipe.url}` });
        return;
      }
      const closest = attempts.reduce((best, a) => (rank(a) > rank(best) ? a : best));
      const missing = used.filter((name) => !closest.bound.includes(name));
      reports.push({
        ...base,
        level: 'accessibility',
        reason:
          closest.recipe === undefined
            ? `${closest.request.method} ${pathOf(closest.request.url)}: ${closest.reason ?? 'not usable'}`
            : `${closest.request.method} ${pathOf(closest.request.url)} does not carry the variable(s) ${missing.map((m) => `"${m}"`).join(', ')}`,
      });
    });
    return reports;
  }

  /** The Result_Zone the user marked in the page, if any (the last mark wins). */
  get resultZone(): ResultZone | undefined {
    return this.zone === undefined ? undefined : structuredClone(this.zone);
  }

  /** Number of steps recorded so far. */
  get stepCount(): number {
    return this.steps;
  }

  /** Start capturing in the current page and in every page it navigates to. */
  async attach(): Promise<void> {
    if (this.attached) {
      throw new Error('This LiveRecorder is already attached to its page');
    }

    try {
      await this.bind(this.page, 0);
    } catch (err) {
      if ((err as Error).message.includes('already registered')) {
        throw new Error('This page already has a LiveRecorder attached');
      }
      throw err;
    }

    await this.page.evaluate(CAPTURE_SCRIPT);
    await this.injectInFrames(this.page);
    this.network?.start();
    this.attached = true;
  }

  /**
   * Capture in a page opened by the recorded page (window.open, target=_blank).
   * Records a `switch_page` step; the steps that follow belong to that page.
   */
  async attachPopup(popup: Page): Promise<void> {
    const index = this.pages.length;
    this.pages.push(popup);
    this.unannounced.add(index);

    await this.bind(popup, index);

    // The click that opened the page is recorded before the page opening
    await new Promise((resolve) => setTimeout(resolve, POPUP_SETTLE_MS));
    await this.queue;
    this.switchTo(index);

    await popup.waitForLoadState('domcontentloaded', { timeout: POPUP_LOAD_TIMEOUT_MS }).catch(() => { });
    await this.injectInFrames(popup);

    const stepIndex = this.switchSteps.get(index);
    if (stepIndex !== undefined && !popup.isClosed()) {
      const title = await popup.title().catch(() => '');
      this.recorder.setAnchor(stepIndex, pageAnchor(index, true, title || popup.url()));
    }
  }

  private async bind(page: Page, pageIndex: number): Promise<void> {
    await page.exposeBinding('__daemonizeRecord', (source, event: CapturedEvent) =>
      this.enqueue(source, event, pageIndex)
    );
    await page.exposeBinding('__daemonizeMarkVariable', (_source, request: MarkVariableRequest) =>
      this.handleMarkVariable(request)
    );
    await page.exposeBinding('__daemonizeMarkResult', (_source, request: MarkResultRequest) =>
      this.handleMarkResult(request)
    );
    await page.addInitScript(CAPTURE_SCRIPT);
  }

  private async injectInFrames(page: Page): Promise<void> {
    for (const frame of page.frames()) {
      await frame.evaluate(CAPTURE_SCRIPT).catch(() => { });
    }
  }

  /** Events are handled one at a time, in the order the page sent them. */
  private enqueue(source: BindingSource, event: CapturedEvent, pageIndex: number): Promise<number | null> {
    // The action starts now, when the page reports it, not when the queue reaches it
    const actionId = this.network?.beginAction();
    const run = async (): Promise<number | null> => {
      const ctx: HandleContext = { pageIndex, actionId };
      if (event.frameComplete === false && source.frame.parentFrame() !== null) {
        ctx.frame = await frameChain(source.frame).catch(() => undefined);
      }
      return this.handle(event, ctx);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Turn one captured event into a recorded step. Returns its index, or null when ignored. */
  handle(event: CapturedEvent, ctx: HandleContext = {}): number | null {
    const selectors = buildSelectors(event.info);
    if (selectors.length === 0) {
      return null;
    }

    this.switchTo(ctx.pageIndex ?? this.current);

    const secretRef = event.secretRef !== undefined && SECRET_NAME.test(event.secretRef) ? event.secretRef : undefined;
    const anchor = event.anchor === undefined
      ? undefined
      : { ...event.anchor, frame: ctx.frame ?? event.anchor.frame };

    const index = this.recorder.addStep({
      actionType: event.actionType,
      selectors,
      // The value of a secret field is never stored
      value: secretRef === undefined ? event.value : undefined,
      label: event.label,
      anchor,
      rowBinding: event.rowBinding,
      risk: classifyRisk(event),
      secretRef,
      // A one-time-code field holds a TOTP seed at replay time: the current code is typed
      totp: secretRef === 'OTP' ? true : undefined,
    });
    this.steps += 1;
    if (ctx.actionId !== undefined) this.stepActions.set(index, ctx.actionId);
    if (event.rowBinding !== undefined) {
      this.bindRowToKnownVariable(index, event.rowTexts ?? []);
    }

    const fieldName = event.info.name ?? event.info.nameAttr ?? event.info.id;
    if (fieldName !== undefined) {
      this.fieldNames.set(index, fieldName);
    }
    return index;
  }

  /** Record that the following steps happen on another page. */
  private switchTo(pageIndex: number): void {
    if (pageIndex === this.current) return;

    const page = this.pages[pageIndex];
    const opens = this.unannounced.delete(pageIndex);
    const index = this.recorder.addStep({
      actionType: 'switch_page',
      selectors: [],
      label: opens ? 'switch to new page' : `switch to page ${pageIndex}`,
      anchor: pageAnchor(pageIndex, opens, page?.url() ?? ''),
      risk: 'read',
    });
    this.steps += 1;
    this.current = pageIndex;
    if (opens) this.switchSteps.set(pageIndex, index);
  }

  /** Mark the value typed or selected in a recorded step as a variable. */
  markVariable(stepIndex: number, variable: WorkflowVariable): void {
    this.recorder.markVariable(stepIndex, variable);
  }

  /**
   * Bind the row, card or list item of a step to a variable that is already
   * defined: at replay the row is the one containing the value of the variable.
   */
  bindRowToVariable(stepIndex: number, variableName: string): void {
    const value = this.recorder.variableValues().get(variableName);
    if (value === undefined) {
      throw new Error(`Variable "${variableName}" is not defined`);
    }
    const texts = this.rowTexts.get(stepIndex) ?? [];
    const cell = findCell(texts, value);
    this.recorder.bindRow(stepIndex, variableName, cell);
  }

  /** A variable defined before the step (typed in a search box, or a text selected in the row) selects the row. */
  private bindRowToKnownVariable(stepIndex: number, texts: string[]): void {
    this.rowTexts.set(stepIndex, texts);
    for (const [name, value] of this.recorder.variableValues()) {
      if (findCell(texts, value) !== undefined) {
        this.recorder.bindRow(stepIndex, name, findCell(texts, value));
        return;
      }
    }
  }

  /** Handle the element the user marked as the result in the page; never throws. */
  handleMarkResult(request: MarkResultRequest): MarkResultResult {
    const selector = buildZoneSelector(request.info);
    if (selector === undefined) {
      return { ok: false, error: 'No stable selector for this element' };
    }
    if (!WEB_KINDS.includes(request.kind)) {
      return { ok: false, error: `Unknown kind "${request.kind}"` };
    }
    const kind = request.kind as ExtractorKind;
    this.zone = { selector, extractor: { kind } as NonNullable<ResultZone['extractor']> };
    return { ok: true, selector, kind };
  }

  /** Handle a variable named by the user in the page; never throws. */
  handleMarkVariable(request: MarkVariableRequest): MarkVariableResult {
    if (!VARIABLE_NAME.test(request.name)) {
      return { ok: false, error: 'Use letters, digits and underscores, not starting with a digit' };
    }

    if (request.rowText !== undefined) {
      try {
        this.recorder.defineVariable({ name: request.name, description: 'text of a row' }, request.rowText);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    const variable: WorkflowVariable = { name: request.name };
    const description = this.fieldNames.get(request.stepIndex);
    if (description !== undefined) {
      variable.description = description;
    }

    try {
      this.recorder.markVariable(request.stepIndex, variable);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/** GET and HEAD read, DELETE deletes, the other methods write. */
function riskOfMethod(method: string): StepRisk {
  const upper = method.toUpperCase();
  if (upper === 'GET' || upper === 'HEAD') return 'read';
  return upper === 'DELETE' ? 'delete' : 'write';
}

const RISK_ORDER: StepRisk[] = ['read', 'write', 'delete'];

function maxRisk(a: StepRisk, b: StepRisk): StepRisk {
  return RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function normalizeText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The text of the row that is the value (exact, else containing it); undefined when none. */
function findCell(texts: string[], value: string): string | undefined {
  const wanted = normalizeText(value);
  if (wanted === '') return undefined;
  const exact = texts.find((t) => normalizeText(t) === wanted);
  if (exact !== undefined || wanted.length < MIN_SUBSTRING_LENGTH) return exact;
  return texts.find((t) => normalizeText(t).includes(wanted));
}

function pageAnchor(pageIndex: number, opens: boolean, name: string): Anchor {
  return { role: 'document', name, frame: [], popup: opens ? { page: pageIndex, opens: true } : { page: pageIndex } };
}

/** Iframe index chain of a frame, for frames the page itself could not walk up from (cross-origin). */
async function frameChain(frame: Frame): Promise<number[]> {
  const path: number[] = [];
  let current: Frame | null = frame;
  while (current !== null && current.parentFrame() !== null) {
    const parent: Frame = current.parentFrame()!;
    const handle = await current.frameElement();
    try {
      const index = await parent.evaluate(
        (node) => {
          const el = node as Element;
          return Array.from(el.ownerDocument.querySelectorAll('iframe, frame')).indexOf(el);
        },
        handle
      );
      path.unshift(index);
    } finally {
      await handle.dispose();
    }
    current = parent;
  }
  return path;
}
