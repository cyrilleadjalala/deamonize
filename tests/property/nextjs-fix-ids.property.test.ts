import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildSelectors, looksGenerated, type ElementInfo } from '../../src/recorder/selector-builder.js';

const token = fc.stringMatching(/^[0-9a-z]{1,12}$/);
const generatedId = fc.oneof(
  token.map((t) => `:r${t}:`),
  token.map((t) => `:R${t}:`),
  token.map((t) => `_R_${t}_-field`),
  token.map((t) => `_R_${t}_`),
  token.map((t) => `«r${t}»`),
  token.map((t) => `radix-:r${t}:`),
  token.map((t) => `radix-${t}`),
);
const role = fc.constantFrom('textbox', 'button', 'combobox', 'checkbox');
const label = fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,10}$/);

// Feature: nextjs-spa-replay-fixes, Property 7: Bug Condition - Generated ids never become selectors
// **Validates: Requirements 2.13, 2.14**
describe('Property 7: Bug Condition - Generated ids never become selectors', () => {
  it('drops #id and id-anchored css, and equals the result without the id', () => {
    fc.assert(
      fc.property(generatedId, role, label, fc.boolean(), (id, r, name, withTail) => {
        const css = withTail ? `#${id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)} > input` : `#${id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)}`;
        const base: ElementInfo = { role: r, name };
        const got = buildSelectors({ ...base, id, css });
        expect(looksGenerated(id)).toBe(true);
        expect(got.some((s) => s.startsWith('#'))).toBe(false);
        expect(got).toEqual(buildSelectors(base));
      }),
      { numRuns: 100 },
    );
  });
});

// Original (unfixed) implementation, kept as the oracle.
function originalLooksGenerated(id: string): boolean {
  return /[0-9a-f]{8,}/i.test(id) || /^\d+$/.test(id);
}
function originalBuildSelectors(element: ElementInfo): string[] {
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cssEsc = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  const selectors: string[] = [];
  if (element.role && element.name) {
    const own = `role=${element.role}[name="${esc(element.name)}"]`;
    if (element.parentSelector && !element.parentSelector.includes(':has-text(')) selectors.push(`${element.parentSelector} >> ${own}`);
    selectors.push(own);
  }
  if (element.testId) selectors.push(`[data-testid="${esc(element.testId)}"]`);
  if (element.id && !originalLooksGenerated(element.id)) selectors.push(`#${cssEsc(element.id)}`);
  if (element.nameAttr) selectors.push(`[name="${esc(element.nameAttr)}"]`);
  if (element.text) selectors.push(`text="${esc(element.text)}"`);
  if (element.css && !(selectors.length > 0 && element.css.includes(':nth-of-type'))) selectors.push(element.css);
  return [...new Set(selectors)];
}

// Feature: nextjs-spa-replay-fixes, Property 8: Preservation - Stable ids and selector order are unchanged
// **Validates: Requirements 3.11, 3.12**
describe('Property 8: Preservation - Stable ids and selector order are unchanged', () => {
  const stableId = fc.stringMatching(/^[a-z][a-z-]{0,12}$/).filter((id) => !/^radix-/.test(id));
  const opt = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });
  it('matches the original looksGenerated and buildSelectors', () => {
    fc.assert(
      fc.property(
        stableId,
        opt(role),
        opt(label),
        opt(label),
        opt(label),
        opt(fc.constantFrom('div > input:nth-of-type(2)', 'form > button', 'main > a')),
        (id, r, name, testId, text, css) => {
          expect(looksGenerated(id)).toBe(originalLooksGenerated(id));
          const el: ElementInfo = { id, role: r, name, testId, nameAttr: text, text, css: css ?? `#${id} > span` };
          expect(buildSelectors(el)).toEqual(originalBuildSelectors(el));
        },
      ),
      { numRuns: 200 },
    );
  });
});
