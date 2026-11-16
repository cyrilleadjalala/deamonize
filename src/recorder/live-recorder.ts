import type { Frame, Page } from 'playwright';
import { CAPTURE_SCRIPT } from './capture-script.js';
import { buildSelectors, type ElementInfo } from './selector-builder.js';
import type { WorkflowRecorder } from './workflow-recorder.js';
import type { Anchor, RowBinding, StepActionType, StepRisk, WorkflowVariable } from '../types.js';

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
}

/** Request sent by the "Make variable" box shown in the page. */
export interface MarkVariableRequest {
  stepIndex: number;
  name: string;
  rowText?: string;             // a text selected in a row becomes the variable (stepIndex is then ignored)
}

export type MarkVariableResult = { ok: true } | { ok: false; error: string };

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

  constructor(
    private readonly page: Page,
    private readonly recorder: WorkflowRecorder,
  ) {
    this.pages = [page];
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
    await page.addInitScript(CAPTURE_SCRIPT);
  }

  private async injectInFrames(page: Page): Promise<void> {
    for (const frame of page.frames()) {
      await frame.evaluate(CAPTURE_SCRIPT).catch(() => { });
    }
  }

  /** Events are handled one at a time, in the order the page sent them. */
  private enqueue(source: BindingSource, event: CapturedEvent, pageIndex: number): Promise<number | null> {
    const run = async (): Promise<number | null> => {
      const ctx: HandleContext = { pageIndex };
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
    });
    this.steps += 1;
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
