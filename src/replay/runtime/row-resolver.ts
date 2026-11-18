/**
 * Relational locators for dynamic lists and tables, shared by the recorder tests
 * and the generated run-time (copied verbatim into the output directory).
 *
 * A step recorded inside a row, a card or a list item carries a `rowBinding`.
 * At replay the row is found by the VALUE of the bound Variable (never by
 * position), and the selectors of the step are applied inside that row.
 *
 * Pure and dependency-free. Never import anything from src/ here.
 */

export type RowKind = 'row' | 'card' | 'listitem';

/** Shape of `WorkflowStep.rowBinding` (kept structural so this file stays standalone). */
export interface RowBindingLike {
  container: { kind?: RowKind; role?: string; selectorHint?: string };
  key?: { text: string; column?: string };
  variable?: string;
}

export interface RowLocator {
  /** CSS selectors of the container elements to examine, most specific first. */
  containerSelectorCandidates: string[];
  /** Text that must identify the row: the Variable value, or the recorded key when the binding has no Variable. */
  hasText: string;
  /** Column header the text belongs to, when known. */
  column?: string;
}

export class RowResolutionError extends Error {
  constructor(
    readonly code: 'ROW_NOT_FOUND' | 'AMBIGUOUS_ROW' | 'ROW_VARIABLE_MISSING' | 'ROW_KEY_EMPTY',
    message: string,
    readonly matches: string[] = []
  ) {
    super(`${code}: ${message}`);
    this.name = 'RowResolutionError';
  }
}

const KIND_SELECTORS: Record<RowKind, string[]> = {
  row: ['tr', '[role=row]'],
  listitem: ['li', '[role=listitem]'],
  card: ['article', '[role=article]', '[data-card]', '[class~=card]'],
};

/**
 * Turn a recorded binding and the Variable values of the call into what the
 * page needs. When the binding names a Variable its value is the ONLY source of
 * the text: a missing Variable is an error, never a silent fallback to the
 * recorded value (that would act on the wrong row).
 */
export function buildRowLocator(binding: RowBindingLike, variables: Record<string, unknown>): RowLocator {
  let raw: unknown;
  if (binding.variable !== undefined) {
    raw = variables[binding.variable];
    if (raw === undefined || raw === null) {
      // An omitted optional Variable with "use the recorded value": the recorded key selects the row (2.10)
      const recorded = binding.key?.text;
      if (typeof recorded === 'string' && recorded.trim() !== '') {
        raw = recorded;
      } else throw new RowResolutionError('ROW_VARIABLE_MISSING', `no value for the variable "${binding.variable}" that selects the row`);
    }
  } else {
    raw = binding.key?.text;
  }
  const hasText = raw === undefined ? '' : String(raw).trim();
  if (hasText === '') {
    throw new RowResolutionError('ROW_KEY_EMPTY', 'the text that selects the row is empty');
  }

  const kind = binding.container.kind ?? kindOfRole(binding.container.role);
  const candidates: string[] = [];
  if (binding.container.selectorHint) candidates.push(binding.container.selectorHint);
  if (binding.container.role) candidates.push(`[role=${binding.container.role}]`);
  candidates.push(...KIND_SELECTORS[kind]);

  const locator: RowLocator = { containerSelectorCandidates: [...new Set(candidates)], hasText };
  if (binding.key?.column !== undefined && binding.key.column !== '') locator.column = binding.key.column;
  return locator;
}

function kindOfRole(role: string | undefined): RowKind {
  if (role === 'listitem') return 'listitem';
  if (role === 'article') return 'card';
  return 'row';
}

/**
 * Pick the rows whose text matches. A cell equal to the text (case, accents
 * form and whitespace normalised) wins; only when no cell is equal, a cell that
 * contains the text counts. `columnIndex` restricts the search to one cell.
 *
 * Self-contained on purpose: its source is embedded in ROW_RESOLVER_SOURCE.
 */
export function matchRows(
  rows: Array<{ cells: string[] }>,
  text: string,
  columnIndex?: number
): { matches: number[]; mode: 'exact' | 'contains' } {
  const norm = (s: string): string => String(s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const target = norm(text);
  if (target === '') return { matches: [], mode: 'exact' };
  const cellsOf = (row: { cells: string[] }): string[] =>
    typeof columnIndex === 'number' && columnIndex >= 0
      ? row.cells.slice(columnIndex, columnIndex + 1)
      : row.cells;
  const find = (mode: 'exact' | 'contains'): number[] => {
    const found: number[] = [];
    rows.forEach((row, index) => {
      const hit = cellsOf(row).some((cell) => {
        const value = norm(cell);
        return mode === 'exact' ? value === target : value.includes(target);
      });
      if (hit) found.push(index);
    });
    return found;
  };
  const exact = find('exact');
  if (exact.length > 0) return { matches: exact, mode: 'exact' };
  return { matches: find('contains'), mode: 'contains' };
}

const MARK_ATTRIBUTE = 'data-daemonize-row';

/**
 * Source of a function to run in the page, through `rowResolverExpression(args)`.
 * Argument: `{ selectors, text, column?, mark }`. It finds the unique container
 * matching the text, tags it with `data-daemonize-row="<mark>"` (removed from any
 * other element) and returns the element. It throws an Error whose message starts
 * with ROW_NOT_FOUND or AMBIGUOUS_ROW and lists the texts of the rows involved.
 */
export const ROW_RESOLVER_SOURCE = `(args) => {
  ${matchRows.toString()}
  const MARK = ${JSON.stringify(MARK_ATTRIBUTE)};
  const collapse = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const CELL = 'td, th, [role=cell], [role=gridcell], [role=rowheader], [role=columnheader]';
  const isCell = (el) => el.matches(CELL);
  const shown = (el) => el.getClientRects().length > 0;

  const seen = new Set();
  for (const selector of args.selectors) {
    let found = [];
    try { found = Array.from(document.querySelectorAll(selector)); } catch (e) { found = []; }
    for (const el of found) seen.add(el);
  }
  let rows = Array.from(seen).filter(shown);
  // Header rows (only header cells) never identify a record
  rows = rows.filter((row) => {
    const cells = Array.from(row.children).filter(isCell);
    return cells.length === 0 || cells.some((c) => !c.matches('th, [role=columnheader]'));
  });

  const cellTexts = (row) => {
    const cells = Array.from(row.children).filter(isCell);
    if (cells.length > 0) return cells.map((c) => collapse(c.textContent));
    // Cards and list items: the own text of each element is one cell
    const texts = [];
    for (const el of [row, ...Array.from(row.querySelectorAll('*'))]) {
      if (['SCRIPT', 'STYLE', 'TEMPLATE'].includes(el.tagName)) continue;
      const own = collapse(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' '));
      if (own) texts.push(own);
    }
    return texts;
  };

  let columnIndex;
  if (args.column) {
    const table = rows.length > 0 ? rows[0].closest('table, [role=table], [role=grid], [role=treegrid]') : null;
    const headerRow = table ? table.querySelector('tr:has(th), [role=row]:has([role=columnheader])') : null;
    if (headerRow) {
      const wanted = collapse(args.column).normalize('NFC').toLowerCase();
      const headers = Array.from(headerRow.children).filter(isCell).map((c) => collapse(c.textContent).normalize('NFC').toLowerCase());
      const at = headers.indexOf(wanted);
      if (at >= 0) columnIndex = at;
    }
  }

  const infos = rows.map((row) => ({ cells: cellTexts(row) }));
  const result = matchRows(infos, args.text, columnIndex);
  // A wrapper that contains another matching container is not the row itself
  let matched = result.matches.map((i) => rows[i]);
  matched = matched.filter((el) => !matched.some((other) => other !== el && el.contains(other)));
  const describe = (el) => cellTexts(el).filter(Boolean).join(' ').slice(0, 120);

  if (matched.length === 0) {
    const sample = rows.slice(0, 10).map(describe);
    throw new Error('ROW_NOT_FOUND: no row matches "' + args.text + '" among ' + rows.length + ' rows: ' + JSON.stringify(sample));
  }
  if (matched.length > 1) {
    throw new Error('AMBIGUOUS_ROW: ' + matched.length + ' rows match "' + args.text + '": ' + JSON.stringify(matched.map(describe)));
  }
  for (const old of document.querySelectorAll('[' + MARK + ']')) old.removeAttribute(MARK);
  matched[0].setAttribute(MARK, args.mark);
  return matched[0];
}`;

export interface RowResolverArgs {
  selectors: string[];
  text: string;
  column?: string;
  mark: string;
}

/**
 * Expression that runs ROW_RESOLVER_SOURCE with its argument. Playwright
 * evaluates a string as an expression, it does not call it, so the call is
 * part of the string; the argument is JSON, so no text can escape it.
 */
export function rowResolverExpression(args: RowResolverArgs): string {
  return `(${ROW_RESOLVER_SOURCE})(${JSON.stringify(args)})`;
}

/** The part of a Playwright Page or Frame the helper needs (no import of playwright here). */
export interface RowScope {
  evaluateHandle(expression: string): Promise<{ dispose(): Promise<void> }>;
}

export interface ResolvedRow {
  /** Selector of the resolved row; chain the step selector after it: `${rowSelector} >> ${selector}`. */
  rowSelector: string;
  /** The step selectors, scoped to the row. */
  scopedSelectors: string[];
  hasText: string;
}

/**
 * Resolve the row of a step in `scope` (a page or frame) and scope its
 * selectors to it. Throws RowResolutionError-like Errors (message starting with
 * ROW_NOT_FOUND / AMBIGUOUS_ROW) on 0 or more than 1 match.
 */
export async function resolveRowStep(
  scope: RowScope,
  step: { selectors: string[]; rowBinding?: RowBindingLike },
  variables: Record<string, unknown>,
  mark = '1'
): Promise<ResolvedRow | undefined> {
  if (step.rowBinding === undefined) return undefined;
  const locator = buildRowLocator(step.rowBinding, variables);
  const handle = await scope.evaluateHandle(rowResolverExpression({
    selectors: locator.containerSelectorCandidates,
    text: locator.hasText,
    column: locator.column,
    mark,
  }));
  await handle.dispose();
  const rowSelector = `css=[${MARK_ATTRIBUTE}="${mark}"]`;
  return { rowSelector, scopedSelectors: scopeSelectors(rowSelector, step.selectors), hasText: locator.hasText };
}

/** Apply selectors inside a row; a selector already chained from a container is cut to its own part. */
export function scopeSelectors(rowSelector: string, selectors: string[]): string[] {
  return selectors.map((selector) => `${rowSelector} >> ${selector.split(' >> ').pop()}`);
}
