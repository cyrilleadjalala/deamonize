export interface ElementInfo {
  role?: string;       // ARIA role (explicit or implicit), e.g. "button", "textbox"
  name?: string;       // accessible name, e.g. the label text or button caption
  id?: string;
  testId?: string;     // data-testid
  nameAttr?: string;   // name="" attribute of a form control
  text?: string;       // visible text, for clickable elements that have no role
  css?: string;        // last-resort CSS path
}

/**
 * Build the ordered list of candidate selectors for one element: the
 * accessibility role and name first (stable across layout changes), then
 * stable attributes, then the CSS path as the last resort.
 */
export function buildSelectors(element: ElementInfo): string[] {
  const selectors: string[] = [];

  if (element.role && element.name) {
    selectors.push(`role=${element.role}[name="${escapeQuotes(element.name)}"]`);
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
  if (element.css) {
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
