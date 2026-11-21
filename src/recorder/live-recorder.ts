import type { Frame, Page } from 'playwright';
import { CAPTURE_SCRIPT } from './capture-script.js';
import { buildSelectors, buildZoneSelector, type ElementInfo } from './selector-builder.js';
import { isFragile, limitCandidates, zoneCandidateSelectors, zoneFingerprint, type ZoneFacts } from './zone-candidates.js';
import type { WorkflowRecorder } from './workflow-recorder.js';
import type {
  EditVariableRequest,
  FieldsAnswer,
  FinishRequest,
  MarkVariableRequest,
  PanelField,
  PanelRequest,
  PanelSummary,
  RadioInfo,
  VariableAnswer,
} from './panel-protocol.js';
import { safeFieldLabel, validateEdit, validateRadioGroup, validateVariableSettings } from './variable-settings.js';
import { NetworkCapture } from './network-capture.js';
import { buildHttpRecipe } from './http-correlate.js';
import { followUpReads, selectRecipe } from './select-recipe.js';
import { prepareVisualAnchor, writeThumbnail, type PreparedVisual } from './visual-anchor.js';
import { dropNavigationReads, isScreenNavigation, navigationReason, type NavigationInfo } from './navigation-rule.js';
import type { Anchor, ExtractorKind, ResultZone, RowBinding, StepActionType, StepRisk, WorkflowVariable } from '../types.js';

/** The part of Playwright's binding source the recorder uses. */
interface BindingSource {
  frame: Frame;
}

/** Event sent by the capture script running inside the page. */
export interface CapturedEvent {
  actionType: StepActionType;
  info: ElementInfo;
  box?: { x: number; y: number; width: number; height: number };   // target in the viewport of the top page, measured by the page
  anchor?: Anchor;              // role, accessible name, parent context, frame path
  frameComplete?: boolean;      // false when the page could not walk up to the top document (cross-origin)
  value?: string;
  label?: string;
  secretRef?: string;           // the field holds a secret (PASSWORD, OTP, TOKEN): no value was captured
  submit?: boolean;             // click on a submit button of a form
  inForm?: boolean;             // Enter pressed in a field of a form
  rowBinding?: RowBinding;      // the target lies in a table row, card or list item
  rowTexts?: string[];          // texts of that row, to recognise the value of a variable in it
  canvas?: boolean;             // a click on a <canvas>: no selector, only the clicked point (`box`)
  replaces?: number;            // a `type` event: index of the previous flush of the same field (no other step since)
  continues?: boolean;          // the same, when that index is not known to the page yet: the last step is meant
  radio?: RadioInfo;            // a click on a radio that has no ancestor row: the group it belongs to
  radioGroup?: string;          // accessible group name of a radio click (legend, radiogroup label, or name attribute)
}

/** Binding the panel of the page calls to read its state and to store its collapse state. */
export const PANEL_BINDING = '__daemonizePanel';
/** Binding the "Finish and save" button calls: ends the session while the page is still open. */
export const FINISH_BINDING = '__daemonizeFinish';

export type {
  EditVariableRequest,
  FieldsAnswer,
  FinishRequest,
  MarkVariableRequest,
  PanelRequest,
  PanelSummary,
  RadioInfo,
  VariableAnswer,
} from './panel-protocol.js';

/** What the user wants next once the recording is saved: only save it, test it in the Studio, or add it to Kiro. */
export type FinishIntent = 'save' | 'test' | 'kiro';
const FINISH_INTENTS: readonly FinishIntent[] = ['save', 'test', 'kiro'];

/** Where the tool is added to Kiro: every project, or this one. Only set by `intent: 'kiro'`. */
export type FinishScope = 'global' | 'project';
const FINISH_SCOPES: readonly FinishScope[] = ['global', 'project'];

const MAX_FIELDS = 100;
const MAX_FILE_FIELDS = 1000;
const MAX_FILE_FIELD_ID_LENGTH = 100;

/** What the panel in the page shows. Labels only: a typed value never goes into it. */
export interface PanelState {
  steps: number;
  last: string[];
  collapsed: boolean;
  zone?: { kind: string };
  ending: boolean;
  /** True in a Studio-driven recording: "Finish and save" opens the end sheet (test it, add it to Kiro). */
  studio: boolean;
  /** True when the Kiro folder existed when the recording started: the end sheet then offers "All my projects". */
  kiroHomeExists: boolean;
}

/** Why the session ended: the panel button, an AbortSignal, or a call from Node (a Studio-driven recording). */
export type EndReason = 'panel' | 'signal' | 'api';

const LAST_LABELS = 3;

/** Where an event came from, when known by the recorder and not only by the page. */
export interface HandleContext {
  pageIndex?: number;           // 0 for the first page, then popups in opening order
  frame?: number[];             // frame path resolved by the recorder
  actionId?: number;            // network capture: id given when the event reached the recorder
}

export interface LiveRecorderOptions {
  /** Observe fetch/XHR requests to record Level 1 recipes (default false). */
  captureNetwork?: boolean;
  /** A Studio started this recording: the panel offers the next steps once the tool is saved. */
  studio?: boolean;
  /**
   * Capture a Visual_Anchor (rect, intent and a thumbnail in `<workflowFile>.assets/`) for each step with a target.
   * Off when absent. `thumbnails: false` keeps rect and intent and takes no picture.
   */
  visual?: { workflowFile: string; thumbnails?: boolean };
  /** The Kiro folder existed when the recording started: the end sheet offers a choice of scope. */
  kiroHomeExists?: boolean;
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

export type MarkVariableResult = VariableAnswer;

/** Request sent by the "Mark result" action shown in the page: the element the user clicked and the kind suggested for it. */
export interface MarkResultRequest {
  info: ElementInfo;
  kind: string;
  /** Facts computed in the page; absent from an older injected script. */
  zone?: ZoneFacts;
}

export type MarkResultResult =
  | { ok: true; selector: string; kind: ExtractorKind; selectors?: string[]; fragile?: boolean }
  | { ok: false; error: string };

const WEB_KINDS: readonly string[] = ['text', 'table', 'list', 'fields', 'json', 'attribute'];

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DELETE_NAME = /delete|remove|supprimer|drop|destroy|purge/i;
const WRITE_NAME = /save|create|add|submit|update|send|pay|enregistrer|créer|envoyer/i;
const CLICK_ROLES = new Set(['button', 'link', 'menuitem']);
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const MIN_SUBSTRING_LENGTH = 3;   // a shorter variable value only selects a row when a cell equals it
const POPUP_SETTLE_MS = 50;
const POPUP_LOAD_TIMEOUT_MS = 3000;
const VISUAL_TIMEOUT_MS = 4000;

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
  /** Candidates proven for the last marked element, so a kind tab click does not prove them again. */
  private readonly zoneCandidateCache = new Map<string, string[]>();
  private readonly network: NetworkCapture | undefined;
  private readonly stepActions = new Map<number, number>();
  private readonly visual: LiveRecorderOptions['visual'];
  private thumbnails = 0;
  private readonly thumbnailed = new Set<number>();
  private readonly lastLabels: string[] = [];
  private collapsed = false;
  private endReason: EndReason | undefined;
  private intent: FinishIntent = 'save';
  private readonly studio: boolean;
  private resolveEnded: (reason: EndReason) => void = () => { };
  private readonly urlBefore = new Map<number, { url: string; page: number }>();
  private readonly lastUrls = new Map<number, string>();
  private readonly typedKeys = new Map<number, string>();
  private readonly radios = new Map<number, RadioInfo>();
  private readonly radioLabels = new Map<number, string>();
  private readonly fileFields = new Set<string>();
  private readonly frameIds = new WeakMap<Frame, number>();
  private frameCount = 0;
  private scope: FinishScope | undefined;
  private readonly kiroHomeExists: boolean;

  /** Resolves once, with the reason of the first `requestEnd`. `record()` awaits it next to the terminal and the window. */
  readonly ended: Promise<EndReason>;

  constructor(
    private readonly page: Page,
    private readonly recorder: WorkflowRecorder,
    options: LiveRecorderOptions = {},
  ) {
    this.ended = new Promise<EndReason>((resolve) => {
      this.resolveEnded = resolve;
    });
    this.pages = [page];
    this.visual = options.visual;
    this.studio = options.studio === true;
    this.kiroHomeExists = options.kiroHomeExists === true;
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

      const allAttempts = requests.map((request) => ({ request, ...buildHttpRecipe(values, request) }));
      // A submit step is a write or delete in the UI (classifyRisk): a follow-up GET is not its recipe
      const submit = (step.risk ?? 'read') !== 'read';
      // A click that changes the route and carries no variable: the reads after it are mount requests of the new screen
      const screenNavigation = isScreenNavigation({ actionType: step.actionType, submit, nav: this.navigationOf(index) });
      const { kept: attempts, dropped } = dropNavigationReads(allAttempts, { screenNavigation, used });
      if (attempts.length === 0 && dropped.length > 0) {
        this.recorder.setHttp(index, undefined, 'read');
        reports.push({ ...base, level: 'accessibility', reason: navigationReason(dropped) });
        return;
      }
      const rank = (a: (typeof attempts)[number]): number => a.bound.length;
      const qualifying = selectRecipe(attempts, { submit, used });

      // The recipe carries the risk of its own method; without a recipe, a write seen anywhere must not be replayed twice
      const risk =
        qualifying?.recipe === undefined
          ? requests.map((r) => riskOfMethod(r.method)).reduce(maxRisk, 'read' as StepRisk)
          : riskOfMethod(qualifying.recipe.method);
      this.recorder.setHttp(index, qualifying?.recipe, risk);

      if (qualifying?.recipe !== undefined) {
        reports.push({ ...base, level: 'http', request: `${qualifying.recipe.method} ${qualifying.recipe.url}` });
        return;
      }
      const followUp = followUpReads(attempts, { submit, used })[0];
      if (followUp !== undefined) {
        reports.push({
          ...base,
          level: 'accessibility',
          reason: `${followUp.request.method} ${pathOf(followUp.request.url)}: follow-up read of a submit step, not used`,
        });
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

  /**
   * End the session from outside the page: the "Finish and save" button of the panel, an AbortSignal, or a
   * Studio-driven recording all go through here. Idempotent: only the first call counts.
   */
  requestEnd(reason: EndReason = 'api'): void {
    if (this.endReason !== undefined) return;
    this.endReason = reason;
    this.resolveEnded(reason);
  }

  /** What the user chose on the end sheet of the panel ('save' when the session ended another way). */
  get finishIntent(): FinishIntent {
    return this.intent;
  }

  /** Where to add the tool to Kiro, when the user chose it with "Save and add to Kiro"; otherwise undefined. */
  get finishScope(): FinishScope | undefined {
    return this.scope;
  }

  /** How many file fields the user filled during the session, each counted once. Never written to the workflow file. */
  get unrecordedFileFields(): number {
    return this.fileFields.size;
  }

  /** What the end sheet of the panel shows now. */
  panelSummary(): PanelSummary {
    const steps = this.recorder.stepsSoFar();
    return {
      steps: this.steps,
      variables: [...this.recorder.variableValues().keys()],
      secrets: new Set(steps.flatMap((step) => (step.secretRef === undefined ? [] : [step.secretRef]))).size,
      files: this.fileFields.size,
    };
  }

  /**
   * The fields of the session the user can turn into a variable or adjust: typed, selected, checked and radio steps,
   * without any secret. At most the last 100, by step index ascending. A typed value never goes into it.
   */
  panelFields(): FieldsAnswer {
    const variables = new Map(this.recorder.variableList().map((variable) => [variable.name, variable]));
    const fields: PanelField[] = [];
    this.recorder.stepsSoFar().forEach((step, stepIndex) => {
      if (step.secretRef !== undefined) return;
      let kind: PanelField['kind'];
      if (step.actionType === 'type') kind = 'text';
      else if (step.actionType === 'select') kind = 'choice';
      else if (step.actionType === 'check') kind = 'check';
      else if (step.actionType === 'click' && this.radios.has(stepIndex)) kind = 'radio';
      else return;
      const radioGroup = kind === 'radio' ? this.radioLabels.get(stepIndex) : undefined;
      const fieldStep = radioGroup === undefined ? step : { ...step, label: `choose ${radioGroup}` };
      const field: PanelField = { stepIndex, label: safeFieldLabel(fieldStep), kind };
      const variable = step.variable === undefined ? undefined : variables.get(step.variable);
      if (variable !== undefined) {
        field.variable = {
          name: variable.name,
          type: variable.type ?? 'string',
          optional: variable.optional === true,
          ...(variable.whenOmitted === undefined ? {} : { whenOmitted: variable.whenOmitted }),
        };
      }
      fields.push(field);
    });
    return { fields: fields.slice(-MAX_FIELDS) };
  }

  private frameId(frame: Frame): number {
    let id = this.frameIds.get(frame);
    if (id === undefined) {
      id = ++this.frameCount;
      this.frameIds.set(frame, id);
    }
    return id;
  }

  /** A file field was filled in: only a counter signal, nothing of the file. No step and no Variable. */
  private noteFileField(frame: Frame, fieldId: unknown): { ok: boolean } {
    if (typeof fieldId !== 'string' || fieldId === '' || fieldId.length > MAX_FILE_FIELD_ID_LENGTH) return { ok: false };
    if (this.fileFields.size < MAX_FILE_FIELDS) this.fileFields.add(`${this.frameId(frame)}:${fieldId}`);
    return { ok: true };
  }

  /** What the panel of the page shows now. */
  panelState(): PanelState {
    return {
      steps: this.steps,
      last: [...this.lastLabels],
      collapsed: this.collapsed,
      ...(this.zone === undefined ? {} : { zone: { kind: this.zone.extractor?.kind ?? 'text' } }),
      ending: this.endReason !== undefined,
      studio: this.studio,
      kiroHomeExists: this.kiroHomeExists,
    };
  }

  /**
   * The route before and after a step, from the URL of its page when the page reported it and the URL of the next
   * step of the same page (or the last URL the page had). Undefined when the step has no known URL.
   */
  navigationOf(index: number): NavigationInfo | undefined {
    const here = this.urlBefore.get(index);
    if (here === undefined) return undefined;
    let to: string | undefined;
    for (let next = index + 1; next < this.steps; next++) {
      const candidate = this.urlBefore.get(next);
      if (candidate !== undefined && candidate.page === here.page) {
        to = candidate.url;
        break;
      }
    }
    to ??= this.lastUrls.get(here.page);
    return to === undefined ? undefined : { from: here.url, to };
  }

  private noteLabel(label: string): void {
    this.lastLabels.push(label);
    if (this.lastLabels.length > LAST_LABELS) this.lastLabels.shift();
  }

  /** The Result_Zone the user marked in the page, if any (the last mark wins). */
  get resultZone(): ResultZone | undefined {
    return this.zone === undefined ? undefined : structuredClone(this.zone);
  }

  /** Wait until every event reported so far is recorded, with its visual anchor. Call it before `finish`. */
  async idle(): Promise<void> {
    await this.queue;
  }

  /** Number of thumbnails written so far. */
  get thumbnailCount(): number {
    return this.thumbnails;
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
    await page.exposeBinding('__daemonizeMarkResult', (source, request: MarkResultRequest) =>
      this.markResultInFrame(request, source.frame)
    );
    await page.exposeBinding('__daemonizeEditVariable', (_source, request: EditVariableRequest) =>
      this.handleEditVariable(request)
    );
    await page.exposeBinding(PANEL_BINDING, (source, request: PanelRequest) => {
      if (request?.type === 'collapse') {
        this.collapsed = request.collapsed === true;
        return { ok: true };
      }
      if (request?.type === 'summary') return this.panelSummary();
      if (request?.type === 'fields') return this.panelFields();
      if (request?.type === 'clearZone') return this.clearResultZone();
      if (request?.type === 'file') return this.noteFileField(source.frame, request.fieldId);
      return this.panelState();
    });
    await page.exposeBinding(FINISH_BINDING, (_source, request?: FinishRequest) => {
      const intent = FINISH_INTENTS.find((candidate) => candidate === request?.intent);
      if (this.endReason === undefined && intent !== undefined) {
        this.intent = intent;
        // The scope only goes with "add to Kiro", and only as one of the two known words
        this.scope = intent === 'kiro' ? FINISH_SCOPES.find((candidate) => candidate === request?.scope) : undefined;
      }
      this.requestEnd('panel');
      return { ok: true };
    });
    this.lastUrls.set(pageIndex, page.url());
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.lastUrls.set(pageIndex, frame.url());
    });
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
    const prepared = this.prepareVisual(event, source.frame);
    // The page has not navigated yet when it reports a click: this is the route the step started on
    const urlBefore = source.frame.page().url();
    const run = async (): Promise<number | null> => {
      const ctx: HandleContext = { pageIndex, actionId };
      if (event.frameComplete === false && source.frame.parentFrame() !== null) {
        ctx.frame = await frameChain(source.frame).catch(() => undefined);
      }
      const index = this.handle(event, ctx);
      if (index !== null && !this.urlBefore.has(index)) {
        this.urlBefore.set(index, { url: urlBefore, page: pageIndex });
      }
      if (index !== null) await this.attachVisual(index, await prepared);
      return index;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Turn one captured event into a recorded step. Returns its index, or null when ignored. */
  handle(event: CapturedEvent, ctx: HandleContext = {}): number | null {
    // A click on a canvas has no selector by design: it is replayed from the Visual_Anchor rectangle (heal mode)
    const canvas = event.canvas === true && event.actionType === 'click' && event.box !== undefined && this.visual !== undefined;
    const selectors = canvas ? [] : buildSelectors(event.info);
    if (selectors.length === 0 && !canvas) {
      return null;
    }

    this.switchTo(ctx.pageIndex ?? this.current);

    // A live field typed again with no other step in between updates its step instead of adding one
    const replaced = event.replaces ?? (event.continues === true ? this.steps - 1 : undefined);
    if (event.actionType === 'type' && replaced !== undefined && replaced === this.steps - 1) {
      const key = selectors.join('\n');
      if (this.typedKeys.get(replaced) === key) {
        if (event.secretRef !== undefined) {
          if (ctx.actionId !== undefined) this.stepActions.set(replaced, ctx.actionId);
          return replaced;
        }
        try {
          this.recorder.replaceValue(replaced, event.value ?? '');
          if (ctx.actionId !== undefined) this.stepActions.set(replaced, ctx.actionId);
          return replaced;
        } catch {
          // The step became a variable (or is not a plain typed value): the new text is a step of its own
        }
      }
    }

    const secretRef = event.secretRef !== undefined && SECRET_NAME.test(event.secretRef) ? event.secretRef : undefined;
    const anchor = canvas
      ? { role: 'canvas', name: event.info.name ?? '', frame: ctx.frame ?? event.anchor?.frame ?? [] }
      : event.anchor === undefined
        ? undefined
        : { ...event.anchor, frame: ctx.frame ?? event.anchor.frame };

    const index = this.recorder.addStep({
      actionType: event.actionType,
      selectors,
      // The value of a secret field is never stored
      value: secretRef === undefined ? (event.actionType === 'check' ? (event.value === 'true' ? 'true' : 'false') : event.value) : undefined,
      label: event.label,
      anchor,
      rowBinding: event.rowBinding,
      risk: classifyRisk(event),
      secretRef,
      // A one-time-code field holds a TOTP seed at replay time: the current code is typed
      totp: secretRef === 'OTP' ? true : undefined,
    });
    this.steps += 1;
    this.noteLabel(event.label ?? event.actionType);
    if (event.actionType === 'type') this.typedKeys.set(index, selectors.join('\n'));
    if (event.actionType === 'click' && event.radio !== undefined) {
      const radio = cleanRadio(event.radio);
      if (radio !== undefined) {
        this.radios.set(index, radio);
        const groupLabel = nonEmpty(event.radioGroup) ?? nonEmpty(event.info.nameAttr) ?? nonEmpty(event.anchor?.parent?.name);
        if (groupLabel !== undefined) this.radioLabels.set(index, groupLabel);
      }
    }
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

  /**
   * Start the Visual_Anchor of an event as soon as the page reports it, before the action changes the page, in
   * parallel with the events queued before it. Never rejects: a picture that cannot be taken only leaves the step
   * without thumbnail (or without visual anchor when its target cannot be located).
   */
  private prepareVisual(event: CapturedEvent, frame: Frame): Promise<PreparedVisual | undefined> {
    const visual = this.visual;
    if (visual === undefined) return Promise.resolve(undefined);
    const work = async (): Promise<PreparedVisual | undefined> => {
      const step = { actionType: event.actionType, anchor: event.anchor, label: event.label, secretRef: event.secretRef };
      const opts = { thumbnail: visual.thumbnails !== false };
      // The page measured the target when it reported the event
      if (event.box !== undefined) return prepareVisualAnchor(frame.page(), event.box, step, opts);
      // A frame the page could not walk up from: look the element up
      for (const selector of buildSelectors(event.info)) {
        const locator = frame.locator(selector);
        if ((await locator.count().catch(() => 0)) === 0) continue;
        return prepareVisualAnchor(frame.page(), locator.first(), step, opts);
      }
      return undefined;
    };
    return withTimeout(work(), VISUAL_TIMEOUT_MS).catch(() => undefined);
  }

  /** Store the Visual_Anchor prepared for a step, and write its thumbnail. Never throws. */
  private async attachVisual(index: number, prepared: PreparedVisual | undefined): Promise<void> {
    if (prepared === undefined || this.visual === undefined) return;
    try {
      const anchor = prepared.visual;
      if (prepared.png !== undefined) {
        anchor.thumbnailPath = await writeThumbnail(prepared.png, {
          workflowFile: this.visual.workflowFile,
          workflowId: this.recorder.id,
          index,
        });
        // A step typed again keeps its thumbnail file (same name): it is counted once
        if (!this.thumbnailed.has(index)) {
          this.thumbnailed.add(index);
          this.thumbnails += 1;
        }
      }
      this.recorder.setVisual(index, anchor);
    } catch {
      // The recording goes on without the visual anchor of this step
    }
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
    this.noteLabel(opens ? 'switch to new page' : `switch to page ${pageIndex}`);
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

  /** Clear the Result_Zone marked so far so the workflow captures the whole page again. */
  clearResultZone(): { ok: true } {
    this.zone = undefined;
    return { ok: true };
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

  /**
   * Like handleMarkResult, and with the facts of the page each candidate is proven in the frame by Playwright's own
   * locator engine: it must match exactly one element and that element must be the marked one. Never throws.
   */
  async markResultInFrame(request: MarkResultRequest, frame: Frame): Promise<MarkResultResult> {
    try {
      const legacy = this.handleMarkResult(request);
      if (!legacy.ok || request.zone === undefined) return legacy;
      const facts = request.zone;
      const kind = legacy.kind;

      const cacheKey = JSON.stringify([request.info, facts.minimal, facts.positional]);
      let verified = this.zoneCandidateCache.get(cacheKey);
      if (verified === undefined) {
        verified = [];
        for (const candidate of zoneCandidateSelectors(request.info, facts)) {
          try {
            const locator = frame.locator(candidate);
            if ((await locator.count()) !== 1) continue;
            const isTarget = await locator.evaluate(
              (el) => (window as unknown as { __daemonizeHelpers?: { isZoneTarget?: (e: Element) => boolean } }).__daemonizeHelpers?.isZoneTarget?.(el) === true,
            );
            if (isTarget) verified.push(candidate);
          } catch {
            // A candidate that cannot be checked is left out; the others go on
          }
        }
        this.zoneCandidateCache.clear();
        this.zoneCandidateCache.set(cacheKey, verified);
      }

      let list = limitCandidates(verified, [...this.recorder.variableValues().values()]);
      if (list.length === 0 && facts.positional) list = limitCandidates([facts.positional], []);
      if (list.length === 0) return legacy; // the legacy selector, alone

      const zone: ResultZone = { selector: list[0], selectors: list, extractor: { kind } as NonNullable<ResultZone['extractor']> };
      const fingerprint = zoneFingerprint(facts, kind);
      if (fingerprint !== undefined) zone.fingerprint = fingerprint;
      this.zone = zone;
      return { ok: true, selector: list[0], kind, selectors: list, fragile: isFragile(list) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Handle a variable named by the user in the page; never throws. */
  handleMarkVariable(request: MarkVariableRequest): MarkVariableResult {
    if (request === null || typeof request !== 'object' || typeof request.name !== 'string' || !VARIABLE_NAME.test(request.name)) {
      return { ok: false, error: 'Use letters, digits and underscores, not starting with a digit' };
    }

    // Every setting is checked before anything changes
    if (request.rowText !== undefined) {
      const checked = validateVariableSettings(request, undefined);
      if (!checked.ok) return checked;
      try {
        this.recorder.defineVariable({ name: request.name, description: 'text of a row', ...checked.settings }, request.rowText);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    const step = this.recorder.stepsSoFar()[request.stepIndex];
    const radio = step?.actionType === 'click' ? this.radios.get(request.stepIndex) : undefined;
    const checked = validateVariableSettings(
      request,
      step === undefined ? undefined : { actionType: step.actionType, value: step.value, isRadioClick: radio !== undefined },
    );
    if (!checked.ok) return checked;
    const group = radio === undefined ? undefined : validateRadioGroup(radio);
    if (group !== undefined && !group.ok) return group;

    const variable: WorkflowVariable = { name: request.name };
    const description = this.fieldNames.get(request.stepIndex);
    // The name of a radio is the choice itself, not a description of the field
    if (description !== undefined && radio === undefined) {
      variable.description = description;
    }
    Object.assign(variable, checked.settings);
    if (group !== undefined && group.ok) variable.enum = group.enum;

    try {
      if (group !== undefined && group.ok) this.recorder.markChoiceVariable(request.stepIndex, variable, group.value);
      else this.recorder.markVariable(request.stepIndex, variable);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Handle the edit of a Variable made in the Field_Drawer; never throws. Nothing changes on a refusal. */
  handleEditVariable(request: EditVariableRequest): VariableAnswer {
    if (request === null || typeof request !== 'object') return { ok: false, error: 'Choose the variable to change.' };
    const values = this.recorder.variableValues();
    const checked = validateEdit(request, this.recorder.variableList(), (name) => values.get(name));
    if (!checked.ok) return checked;

    // A checkbox stays true or false and a radio group stays a choice of texts
    if (request.type !== undefined) {
      const owner = this.recorder.stepsSoFar().find((step) => step.variable === request.name);
      if (owner?.actionType === 'check' && request.type !== 'boolean') {
        return { ok: false, error: 'A checkbox or switch can only be a true or false variable.' };
      }
    }
    const patch: Parameters<WorkflowRecorder['editVariable']>[1] = {};
    if (request.newName !== undefined) patch.newName = request.newName;
    if (request.type !== undefined) patch.type = request.type;
    if (request.optional !== undefined) patch.optional = request.optional;
    if (request.whenOmitted !== undefined) patch.whenOmitted = request.whenOmitted;
    try {
      this.recorder.editVariable(request.name, patch);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/** The radio group the page reported, kept only when it has the expected shape. */
function cleanRadio(radio: RadioInfo): RadioInfo | undefined {
  if (radio === null || typeof radio !== 'object') return undefined;
  if (!Array.isArray(radio.names) || radio.names.length > 52 || !radio.names.every((name) => typeof name === 'string')) return undefined;
  if (typeof radio.total !== 'number' || typeof radio.clicked !== 'string') return undefined;
  return { names: [...radio.names], total: radio.total, clicked: radio.clicked, clickedDisabled: radio.clickedDisabled === true };
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? undefined : trimmed;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
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
