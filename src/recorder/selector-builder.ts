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
  if (element.css && !(selectors.length > 0 && element.css.includes(':nth-of-type'))) {
    selectors.push(element.css);
  }

  return [...new Set(selectors)];
}

function escapeQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

/** Ids made of long hex runs or UUID fragments change between page loads. */
function looksGenerated(id: string): boolean {
  return /[0-9a-f]{8,}/i.test(id) || /^\d+$/.test(id);
}
