export interface ElementInfo {
  role?: string;       // ARIA role (explicit or implicit), e.g. "button", "textbox"
  name?: string;       // accessible name, e.g. the label text or button caption
  id?: string;
  testId?: string;     // data-testid
  nameAttr?: string;   // name="" attribute of a form control
  text?: string;       // visible text, for clickable elements that have no role
  css?: string;        // last-resort CSS path
  parentSelector?: string;  // selector of the enclosing dialog or listbox that tells identical controls apart (rows use rowBinding)
}

/**
 * Build the ordered list of candidate selectors for one element: the
 * accessibility role and name first, scoped to the parent context when there
 * is one (stable across layout changes), then stable attributes, then the CSS
 * path as the last resort. A CSS path that relies on `:nth-of-type` is dropped
 * whenever something better exists.
 */
export function buildSelectors(element: ElementInfo): string[] {
  const selectors: string[] = [];

  if (element.role && element.name) {
    const own = `role=${element.role}[name="${escapeQuotes(element.name)}"]`;
    // A row selector that embeds the recorded text would replay the recorded
    // row whatever the Variable says: rows are found through `rowBinding`
    if (element.parentSelector && !element.parentSelector.includes(':has-text(')) {
      selectors.push(`${element.parentSelector} >> ${own}`);
    }
    selectors.push(own);
  }
  if (element.testId) {
    selectors.push(`[data-testid="${escapeQuotes(element.testId)}"]`);
  }
  if (element.id && !looksGenerated(element.id)) {
    selectors.push(`#${cssEscape(element.id)}`);
  }
  if (element.nameAttr) {
    selectors.push(`[name="${escapeQuotes(element.nameAttr)}"]`);
  }
  if (element.text) {
    selectors.push(`text="${escapeQuotes(element.text)}"`);
  }
  if (
    element.css &&
    !(selectors.length > 0 && element.css.includes(':nth-of-type')) &&
    !(selectors.length > 0 && cssStartsOnGeneratedId(element.css))
  ) {
    selectors.push(element.css);
  }

  return [...new Set(selectors)];
}

/**
 * The selector of a Result_Zone: the same order as a step (role and name, test id, id, name, CSS path)
 * but never a text selector, which would bind the zone to the text recorded in it. The first one wins.
 */
export function buildZoneSelector(element: ElementInfo): string | undefined {
  const own = buildSelectors({ ...element, text: undefined, parentSelector: undefined });
  return own[0];
}

function escapeQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

const GENERATED_ID: RegExp[] = [
  /[0-9a-f]{8,}/i,         // long hex runs, UUID fragments
  /^\d+$/,                 // digits only
  /:[rR][0-9a-z]+:/,       // React 18 useId (":r1:"), also inside Radix ids
  /^_[rR]_[0-9a-z]+_/,     // React 19 useId ("_R_jqatpesnelb_-field")
  /^«[^»]*»/,              // React 19.1 useId ("«r2»")
  /^radix-/,               // Radix UI
];

/** Ids made of long hex runs, UUID fragments or framework useId output change between page loads. */
export function looksGenerated(id: string): boolean {
  return GENERATED_ID.some((pattern) => pattern.test(id));
}

/** A CSS path from the recorder starts at the nearest ancestor with an id: does it start on a generated one? */
function cssStartsOnGeneratedId(css: string): boolean {
  const match = /^#((?:\\.|[^\s>+~.\[:#\\])+)/.exec(css) ?? /^#((?:\\.|[^\s>+~\[#])+)/.exec(css);
  if (!match) return false;
  return looksGenerated(match[1]!.replace(/\\(.)/g, '$1'));
}
