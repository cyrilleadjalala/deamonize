/**
 * Result_Zone extraction shared by the generated run-time (copied verbatim into the output
 * directory and the Docker context, like screen-hash.ts) and the host Replayer.
 *
 * Dependency free: it imports nothing, not even node modules, and never anything from src/.
 *
 * Two parts:
 * - pure functions that turn what a page or a terminal screen holds into plain JSON
 *   (header normalisation, table to objects, regex captures, rectangle crop, redaction);
 * - `WEB_ZONE_FUNCTION`, the only code that touches the DOM, as the source of a function that
 *   runs in the page. It returns raw texts only; every decision is taken by the pure functions.
 *
 * Kinds (web): text, table, list, fields, json, attribute. Kinds (terminal): text, regex.
 */

export type ExtractorLike =
  | { kind: 'text' | 'table' | 'list' | 'fields' | 'json' }
  | { kind: 'attribute'; name?: string }
  | { kind: 'regex'; pattern: string; flags?: string };

export interface RectLike {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface FingerprintLike {
  tag: string;
  kind: string;
  count?: number;
}

export interface ZoneLike {
  selector?: string;
  /** Alternative selectors tried after `selector`, in order. */
  selectors?: string[];
  fingerprint?: FingerprintLike;
  rect?: RectLike;
  extractor?: ExtractorLike;
  schema?: Record<string, unknown>;
}

/** Longest text a result carries. */
export const MAX_RESULT_TEXT = 20000;

export type ZoneFailureError = 'result_zone_not_found' | 'result_extraction_failed';

export type ZoneOutcome =
  | { ok: true; text: string; data: unknown; fallback?: { position: number; of: number } }
  | { ok: false; error: ZoneFailureError; message: string; zone: { selector?: string; rect?: RectLike }; tried?: number };

export type Verdict = 'accepted' | 'soft' | 'rejected';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The zone of a workflow: its own, else the one of its last step that has one. */
export function pickResultZone<Z extends ZoneLike>(workflow: { resultZone?: Z; steps?: Array<{ resultZone?: Z }> }): Z | undefined {
  if (workflow.resultZone !== undefined) return workflow.resultZone;
  const steps = workflow.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const zone = steps[i].resultZone;
    if (zone !== undefined) return zone;
  }
  return undefined;
}

/** Cut a text to the maximum length of a result. */
export function boundText(text: string, max: number = MAX_RESULT_TEXT): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Visible text with spaces collapsed inside lines, lines trimmed, empty lines dropped. */
export function collapseText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0\u200b]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Text of one cell or item: all whitespace, newlines included, collapsed to single spaces. */
export function collapseInline(raw: string): string {
  return raw.replace(/[\s\u00a0\u200b]+/g, ' ').trim();
}

/**
 * Header names as object keys: whitespace collapsed, an empty header becomes `column_<n>`
 * (n from 1), a repeated one gets the suffix `_2`, `_3` and so on. The result has no duplicates.
 */
export function normalizeHeaders(headers: readonly string[]): string[] {
  const used = new Set<string>();
  return headers.map((raw, index) => {
    const base = collapseInline(raw) || `column_${index + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    return name;
  });
}

/**
 * A table as an array of objects keyed by header. `header` is the header row, or null when the
 * first of `body` is the header. A short row is padded with '', a cell beyond the header is keyed
 * `column_<n>`, and a row without any text is dropped. A table without rows gives [].
 */
export function tableToObjects(header: readonly string[] | null, body: readonly (readonly string[])[]): Array<Record<string, string>> {
  let head: readonly string[];
  let rows: readonly (readonly string[])[];
  if (header !== null) {
    head = header;
    rows = body;
  } else if (body.length === 0) {
    return [];
  } else {
    head = body[0];
    rows = body.slice(1);
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), head.length);
  const names = normalizeHeaders(Array.from({ length: width }, (_, i) => head[i] ?? ''));
  const out: Array<Record<string, string>> = [];
  for (const row of rows) {
    const cells = names.map((_, i) => collapseInline(row[i] ?? ''));
    if (cells.every((cell) => cell === '')) continue;
    out.push(Object.fromEntries(names.map((name, i) => [name, cells[i]])));
  }
  return out;
}

/** Items of a list as strings: whitespace collapsed, empty items dropped. */
export function listToStrings(items: readonly string[]): string[] {
  return items.map(collapseInline).filter((item) => item !== '');
}

/** Label/value pairs as an object: a trailing colon is dropped from the label, a repeated label gets `_2`, `_3`. */
export function pairsToObject(pairs: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const used = new Set<string>();
  const entries: Array<[string, string]> = [];
  for (const [rawLabel, rawValue] of pairs) {
    const base = collapseInline(rawLabel).replace(/\s*[:：]$/, '').trim();
    if (base === '') continue;
    let label = base;
    for (let n = 2; used.has(label); n++) label = `${base}_${n}`;
    used.add(label);
    entries.push([label, collapseInline(rawValue)]);
  }
  return Object.fromEntries(entries);
}

/** Parse the text of a zone as JSON. */
export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const source = text.replace(/^\uFEFF/, '').trim();
  if (source === '') return { ok: false, reason: 'the zone is empty, there is no JSON to parse' };
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch (err) {
    return { ok: false, reason: `the text of the zone is not valid JSON (${(err as Error).message})` };
  }
}

/** The names of the named capture groups of a regular expression source, in order. */
export function regexGroupNames(pattern: string): string[] {
  const names: string[] = [];
  const re = /\\.|\[(?:\\.|[^\]\\])*\]|\(\?<([A-Za-z_$][\w$]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern)) !== null) {
    if (m[1] !== undefined) names.push(m[1]);
  }
  return names;
}

const ALLOWED_FLAGS = /^[gimsu]*$/;

/**
 * Named capture groups of a pattern applied to a text. Without the `g` flag the first match as an
 * object, with it every match as an array of objects. Flags default to `m`. A pattern without named
 * group gives `{ match }`. No match is null. An invalid pattern or flag throws an Error.
 */
export function extractRegex(text: string, pattern: string, flags?: string): Record<string, string> | Array<Record<string, string>> | null {
  const used = flags ?? 'm';
  if (!ALLOWED_FLAGS.test(used)) throw new Error(`unsupported regular expression flags "${used}"`);
  const toObject = (m: RegExpMatchArray): Record<string, string> =>
    m.groups === undefined
      ? { match: m[0] }
      : Object.fromEntries(Object.entries(m.groups).map(([name, value]) => [name, value ?? '']));
  const re = new RegExp(pattern, used);
  if (used.includes('g')) {
    const all = [...text.matchAll(re)].map(toObject);
    return all.length > 0 ? all : null;
  }
  const first = re.exec(text);
  return first === null ? null : toObject(first);
}

/** Keep the rectangle (0-based row/col, size rows x cols) of a terminal text; shorter lines are cropped to what exists. */
export function cropRect(text: string, rect: RectLike): string {
  return text
    .split('\n')
    .slice(rect.row, rect.row + rect.rows)
    .map((line) => line.slice(rect.col, rect.col + rect.cols).trimEnd())
    .join('\n')
    .trimEnd();
}

/** Replace the secret values inside every string of a JSON value (keys included are left alone). */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, redact)])) as unknown as T;
  }
  return value;
}

function failure(error: ZoneFailureError, message: string, zone: ZoneLike): ZoneOutcome {
  const where: { selector?: string; rect?: RectLike } = {};
  if (zone.selector !== undefined) where.selector = zone.selector;
  if (zone.rect !== undefined) where.rect = zone.rect;
  return { ok: false, error, message, zone: where };
}

/** A failed outcome for a zone, built by a runtime that could not even read it. */
export function zoneFailure(error: ZoneFailureError, message: string, zone: ZoneLike): ZoneOutcome {
  return failure(error, message, zone);
}

const ACTION_RAN = 'the steps of the workflow already ran (a write step is not undone)';

/** The message for a zone that matches nothing: it says the action itself already ran. */
export function notFoundMessage(zone: ZoneLike): string {
  const where = zone.selector !== undefined ? `selector ${JSON.stringify(zone.selector)}` : 'rectangle ' + JSON.stringify(zone.rect);
  return `The result zone (${where}) matched nothing on the final screen; ${ACTION_RAN}, only reading its result failed.`;
}

/** The result of a call whose zone could not be read: the same shape on the host and in a container. */
export function zoneFailureResult(outcome: Extract<ZoneOutcome, { ok: false }>, elapsedMs: number): {
  success: false;
  drifted: true;
  error: ZoneFailureError;
  message: string;
  failure: { zone: { selector?: string; rect?: RectLike }; candidatesTried?: number };
  elapsedMs: number;
} {
  return { success: false, drifted: true, error: outcome.error, message: outcome.message, failure: outcome.tried === undefined ? { zone: outcome.zone } : { zone: outcome.zone, candidatesTried: outcome.tried }, elapsedMs };
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/** Extract a zone from the rendered text of a terminal screen (kinds text and regex). */
export function extractTerminalZone(screenText: string, zone: ZoneLike): ZoneOutcome {
  const text = zone.rect === undefined ? screenText : cropRect(screenText, zone.rect);
  const extractor: ExtractorLike = zone.extractor ?? { kind: 'text' };
  if (zone.rect !== undefined && text === '' && screenText !== '' && zone.rect.row >= screenText.split('\n').length) {
    return failure('result_zone_not_found', notFoundMessage(zone), zone);
  }
  if (extractor.kind === 'text') return { ok: true, text, data: text };
  if (extractor.kind === 'regex') {
    let found: ReturnType<typeof extractRegex>;
    try {
      found = extractRegex(text, extractor.pattern, extractor.flags);
    } catch (err) {
      return failure('result_extraction_failed', `The result regular expression is invalid: ${(err as Error).message}`, zone);
    }
    if (found === null) {
      return failure('result_zone_not_found', `The result pattern ${JSON.stringify(extractor.pattern)} matched nothing in the zone; ${ACTION_RAN}, only reading its result failed.`, zone);
    }
    return { ok: true, text, data: found };
  }
  return failure('result_extraction_failed', `The extractor "${extractor.kind}" needs a web page; a terminal zone supports text and regex.`, zone);
}

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

/** What `WEB_ZONE_FUNCTION` returns: raw texts, nothing interpreted. */
export interface RawWebZone {
  text: string;
  /** Why the kind cannot be read from this element (no table inside, ...). */
  problem?: string;
  header?: string[] | null;
  rows?: string[][];
  items?: string[];
  pairs?: Array<[string, string]>;
  json?: string;
  attr?: string | null;
}

/** undefined means: no candidates, use the old path. Otherwise dedupe([selector, ...selectors]), at most 6. */
export function zoneCandidatesOf(zone: ZoneLike): string[] | undefined {
  if (zone.selectors === undefined) return undefined;
  const list: string[] = [];
  for (const s of [...(zone.selector !== undefined ? [zone.selector] : []), ...zone.selectors]) {
    if (typeof s === 'string' && s !== '' && !list.includes(s)) list.push(s);
  }
  return list.slice(0, 6);
}

/** Wait per candidate: [T] for one; first = ceil(T/2), the others floor((T - first) / (n - 1)); every entry at least 1. */
export function candidateBudgets(timeoutMs: number, n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [Math.max(1, timeoutMs)];
  const first = Math.ceil(timeoutMs / 2);
  const rest = Math.floor((timeoutMs - first) / (n - 1));
  return [Math.max(1, first), ...Array.from({ length: n - 1 }, () => Math.max(1, rest))];
}

/** The count the zone has for its kind: table = non-empty rows of [header, ...rows]; list = non-empty items. */
export function zoneCount(raw: RawWebZone, kind: string): number | undefined {
  if (kind === 'table') {
    const rows = [...(raw.header ? [raw.header] : []), ...(raw.rows ?? [])];
    return rows.filter((row) => row.some((cell) => collapseInline(cell) !== '')).length;
  }
  if (kind === 'list') return (raw.items ?? []).filter((item) => collapseInline(item) !== '').length;
  return undefined;
}

/**
 * Judge the reading of one candidate. `rejected`: nothing matched, the extractor cannot read it, or the tag differs
 * from the fingerprint. `soft`: it reads, but it is empty where the recording had rows. Otherwise `accepted`.
 */
export function judgeCandidate(raw: RawWebZone | undefined, tag: string | undefined, zone: ZoneLike): { verdict: Verdict; outcome: ZoneOutcome } {
  const outcome = finishWebZone(raw, zone);
  if (raw === undefined || !outcome.ok) return { verdict: 'rejected', outcome };
  const fp = zone.fingerprint;
  if (fp !== undefined && tag !== fp.tag) return { verdict: 'rejected', outcome };
  const kind = zone.extractor?.kind ?? 'text';
  if (fp !== undefined && fp.count !== undefined && fp.count >= 1 && fp.kind === kind && zoneCount(raw, kind) === 0) {
    return { verdict: 'soft', outcome };
  }
  return { verdict: 'accepted', outcome };
}

/** The message for a zone that matched nothing after several candidates. It holds no page text. */
export function notFoundAfterCandidates(_zone: ZoneLike, tried: number): string {
  return `The result zone matched nothing after trying ${tried} ways to find it; ${ACTION_RAN}, only reading its result failed.`;
}
/** Turn the raw reading of the zone element into the result; `raw` is undefined when the element does not exist. */
export function finishWebZone(raw: RawWebZone | undefined, zone: ZoneLike): ZoneOutcome {
  if (raw === undefined) return failure('result_zone_not_found', notFoundMessage(zone), zone);
  const extractor: ExtractorLike = zone.extractor ?? { kind: 'text' };
  const text = collapseText(raw.text);
  const fail = (reason: string): ZoneOutcome => failure('result_extraction_failed', `The zone cannot be read as ${extractor.kind}: ${reason}; ${ACTION_RAN}, only reading its result failed.`, zone);
  if (raw.problem !== undefined) return fail(raw.problem);
  switch (extractor.kind) {
    case 'text':
      return { ok: true, text, data: text };
    case 'table':
      return { ok: true, text, data: tableToObjects(raw.header ?? null, raw.rows ?? []) };
    case 'list':
      return { ok: true, text, data: listToStrings(raw.items ?? []) };
    case 'fields':
      return { ok: true, text, data: pairsToObject(raw.pairs ?? []) };
    case 'json': {
      const parsed = parseJsonText(raw.json ?? raw.text);
      return parsed.ok ? { ok: true, text, data: parsed.value } : fail(parsed.reason);
    }
    case 'attribute':
      return raw.attr === null || raw.attr === undefined
        ? fail(extractor.name === undefined ? 'the element has no value' : `the element has no attribute "${extractor.name}"`)
        : { ok: true, text, data: raw.attr };
    case 'regex': {
      try {
        const found = extractRegex(text, extractor.pattern, extractor.flags);
        return found === null
          ? failure('result_zone_not_found', `The result pattern ${JSON.stringify(extractor.pattern)} matched nothing in the zone; ${ACTION_RAN}, only reading its result failed.`, zone)
          : { ok: true, text, data: found };
      } catch (err) {
        return fail((err as Error).message);
      }
    }
  }
}

/**
 * Source of a function `(element, extractor) => RawWebZone` that runs in the page.
 * Plain JavaScript in a string on purpose: Playwright serializes it as is, so no helper of a
 * bundler or of this module can be missing in the page. Install it with an expression
 * (`window.__daemonizeZone = <source>`), then call it from a real function with explicit arguments.
 */
export const WEB_ZONE_FUNCTION = String.raw`function (root, ex) {
  var TABLE = 'table, [role=table], [role=grid], [role=treegrid]';
  var LIST = 'ul, ol, [role=list]';
  var CELL = 'th, td, [role=cell], [role=gridcell], [role=columnheader], [role=rowheader]';
  var HEAD_CELL = 'th, [role=columnheader]';
  function txt(el) {
    return (el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent) || '';
  }
  function within(el, selector) {
    return el.matches(selector) ? el : el.querySelector(selector);
  }
  var CONTROL = 'textarea, select, input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image])';
  function cellValue(cell) {
    var control = cell.querySelector(CONTROL);
    if (!control) return txt(cell);
    if (control.tagName === 'SELECT') return control.selectedOptions.length > 0 ? control.selectedOptions[0].text : '';
    if (control.type === 'checkbox' || control.type === 'radio') return control.checked ? 'true' : 'false';
    return control.value;
  }
  function ownRows(table) {
    return Array.prototype.filter.call(table.querySelectorAll('tr, [role=row]'), function (row) {
      return row.closest(TABLE) === table;
    });
  }
  function ownCells(row) {
    return Array.prototype.filter.call(row.querySelectorAll(CELL), function (cell) {
      return cell.closest('tr, [role=row]') === row;
    });
  }
  var out = { text: txt(root) };
  var kind = ex && ex.kind ? ex.kind : 'text';
  if (kind === 'table') {
    var table = within(root, TABLE);
    if (!table) { out.problem = 'no table (table, role=table or role=grid) inside the zone'; return out; }
    var rows = ownRows(table);
    var header = null;
    var body = [];
    rows.forEach(function (row) {
      var cells = ownCells(row);
      if (cells.length === 0) return;
      var texts = cells.map(txt);
      var isHead = header === null && body.length === 0 &&
        (cells.every(function (c) { return c.matches(HEAD_CELL); }) || (row.parentElement && row.parentElement.tagName === 'THEAD'));
      if (isHead) header = texts; else body.push(texts);
    });
    out.header = header;
    out.rows = body;
  } else if (kind === 'list') {
    var list = within(root, LIST);
    if (!list) { out.problem = 'no list (ul, ol or role=list) inside the zone'; return out; }
    out.items = Array.prototype.filter.call(list.querySelectorAll('li, [role=listitem]'), function (item) {
      return item.closest(LIST) === list;
    }).map(txt);
  } else if (kind === 'fields') {
    var pairs = [];
    var dl = within(root, 'dl');
    if (dl) {
      var label = null;
      var children = [];
      Array.prototype.forEach.call(dl.children, function (child) {
        if (child.tagName === 'DIV') Array.prototype.forEach.call(child.children, function (c) { children.push(c); });
        else children.push(child);
      });
      children.forEach(function (child) {
        if (child.tagName === 'DT') label = txt(child);
        else if (child.tagName === 'DD' && label !== null) pairs.push([label, txt(child)]);
      });
    }
    if (pairs.length === 0) {
      Array.prototype.forEach.call(root.matches('label') ? [root] : root.querySelectorAll('label'), function (lab) {
        var control = lab.control || (lab.htmlFor ? document.getElementById(lab.htmlFor) : null);
        var value = null;
        if (control) {
          value = control.tagName === 'SELECT' && control.selectedOptions.length > 0 ? control.selectedOptions[0].text : (control.value !== undefined ? control.value : txt(control));
        } else if (lab.nextElementSibling) {
          value = txt(lab.nextElementSibling);
        }
        if (value !== null) pairs.push([txt(lab), value]);
      });
    }
    if (pairs.length === 0) {
      var tableRows = root.matches('tr, [role=row]') ? [root] : Array.prototype.slice.call(root.querySelectorAll('tr, [role=row]'));
      tableRows.forEach(function (row) {
        var cells = ownCells(row);
        if (cells.length === 2) pairs.push([txt(cells[0]), cellValue(cells[1])]);
        else if (cells.length > 2 && cells[0].matches('th')) {
          // A form laid out as a table (label cell, helper cells, then the control): the value is the last control
          var holders = cells.slice(1).filter(function (c) { return c.querySelector(CONTROL) !== null; });
          if (holders.length > 0) pairs.push([txt(cells[0]), cellValue(holders[holders.length - 1])]);
        }
      });
    }
    if (pairs.length === 0) {
      Array.prototype.forEach.call(root.children, function (child) {
        if (child.children.length === 2) pairs.push([txt(child.children[0]), txt(child.children[1])]);
      });
    }
    if (pairs.length === 0) { out.problem = 'no label and value pairs (dl, label + control, two-cell rows) inside the zone'; return out; }
    out.pairs = pairs;
  } else if (kind === 'json') {
    out.json = root.textContent || '';
  } else if (kind === 'attribute') {
    var el = root;
    if (!ex.name && !root.matches('input, select, textarea, option, output')) {
      el = root.querySelector('input, select, textarea, output') || root;
    }
    if (ex.name) {
      var named = ex.name === 'value' && el.value !== undefined && el.value !== null ? String(el.value) : el.getAttribute(ex.name);
      if (named === null && ex.name in el && typeof el[ex.name] !== 'object' && typeof el[ex.name] !== 'function') named = String(el[ex.name]);
      out.attr = named;
    } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      out.attr = el.checked ? 'true' : 'false';
    } else if (el.tagName === 'SELECT') {
      out.attr = el.value;
    } else if (el.value !== undefined && el.value !== null) {
      out.attr = String(el.value);
    } else {
      out.attr = null;
    }
  }
  return out;
}`;
