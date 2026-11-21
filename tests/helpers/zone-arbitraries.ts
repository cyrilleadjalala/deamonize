/**
 * Shared fast-check generators of the result-zone-selector-robustness work (pages, marked element, element info, zone facts, zones).
 * Owned by group G0: other groups import this file and do not edit it.
 *
 * Every id, class and value is built at run time from random characters in the SHAPE of an unstable family (hash suffix,
 * generated id, utility class). None is a credential, and the source holds no literal that looks like one.
 */
import fc from 'fast-check';
import type { ElementInfo } from '../../src/recorder/selector-builder.js';
import type { ZoneFacts } from '../../src/recorder/zone-candidates.js';
import type { ResultZone } from '../../src/types.js';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const ALNUM = `${LOWER}${UPPER}${DIGITS}`;
const HEX = '0123456789abcdef';

const chars = (alphabet: string, min: number, max: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...alphabet.split('')), { minLength: min, maxLength: max }).map((c) => c.join(''));

/** A short lower case word: a plain, stable identifier. */
const word: fc.Arbitrary<string> = fc.stringMatching(/^[a-z][a-z0-9]{2,9}$/);

// ---- classes and ids, one generator per family of the unstable table ----------------------------------------------

/** Stable class names: plain words and BEM names (`card__title`, `result-table`). */
export const stableClass: fc.Arbitrary<string> = fc.oneof(
  word,
  fc.tuple(word, word).map(([a, b]) => `${a}-${b}`),
  fc.tuple(word, word).map(([a, b]) => `${a}__${b}`)
);

/** One arbitrary per family (1 to 10) of the design's unstable-class table. Family 1 is a generated id used as a class. */
export const unstableClassByFamily: Record<number, fc.Arbitrary<string>> = {
  1: chars(HEX, 8, 12),
  2: fc.tuple(word, chars(DIGITS, 4, 7)).map(([a, d]) => `${a}${d}`),
  3: chars(ALNUM, 5, 8).map((s) => `css-${s}`),
  4: fc.oneof(
    chars(ALNUM, 5, 8).map((s) => `sc-${s}`),
    chars(DIGITS, 3, 6).map((d) => `jsx-${d}`),
    fc.constantFrom('aBcDe', 'xYzAb', 'kLmNoP')
  ),
  5: chars(`${LOWER}${DIGITS}`, 5, 8).map((s) => `svelte-${s}`),
  6: fc.oneof(
    chars(ALNUM, 5, 8).map((s) => `_${s}`),
    fc.tuple(word, word, chars(ALNUM, 5, 8)).map(([a, b, h]) => `${a}_${b}__${h}`),
    fc.tuple(word, chars(`${LOWER}${DIGITS}`, 4, 6)).map(([a, h]) => `${a}-${h}1a`)
  ),
  7: fc.tuple(word, fc.constantFrom('[', ']', ':', '/', '!', '@', '%', ',', '=', '.'), word).map(([a, c, b]) => `${a}${c}${b}`),
  8: fc.tuple(fc.constantFrom('m', 'p', 'w', 'h', 'gap', 'text', 'bg', 'border', 'rounded', 'col', 'z'), fc.integer({ min: 1, max: 96 })).map(([p, n]) => `${p}-${n}`),
  9: fc.constantFrom('active', 'selected', 'open', 'show', 'hover', 'focus', 'disabled', 'checked', 'expanded', 'loading', 'current', 'is-open', 'has-error'),
  10: fc.oneof(
    fc.tuple(word, fc.constantFrom('$', '~', '*', '+', '#')).map(([a, c]) => `${a}${c}`),
    word.map((a) => `${a}${'x'.repeat(45)}`),
    fc.tuple(chars(DIGITS, 1, 1), word).map(([d, a]) => `${d}${a}`)
  ),
};
export const FAMILIES: readonly number[] = Object.keys(unstableClassByFamily).map(Number);

/** A class of any of the ten unstable families. */
export const unstableClass: fc.Arbitrary<string> = fc.oneof(...FAMILIES.map((f) => unstableClassByFamily[f]));

/** A class that is stable or of any unstable family. */
export const anyClass: fc.Arbitrary<string> = fc.oneof({ arbitrary: stableClass, weight: 3 }, { arbitrary: unstableClass, weight: 2 });

/** An id a person wrote. */
export const stableId: fc.Arbitrary<string> = fc.oneof(word, fc.tuple(word, word).map(([a, b]) => `${a}-${b}`));

/** An id a framework generated: hex run, digits only, React `useId`, `radix-`. */
export const generatedId: fc.Arbitrary<string> = fc.oneof(
  chars(HEX, 8, 16),
  chars(DIGITS, 3, 10),
  chars(`${LOWER}${DIGITS}`, 1, 4).map((s) => `:r${s}:`),
  chars(`${LOWER}${DIGITS}`, 1, 4).map((s) => `\u00ab${s}\u00bb`),
  chars(ALNUM, 3, 8).map((s) => `radix-${s}`)
);

export const anyId: fc.Arbitrary<string> = fc.oneof({ arbitrary: stableId, weight: 2 }, { arbitrary: generatedId, weight: 1 });

// ---- hostile values -------------------------------------------------------------------------------------------------

/** Attribute values with quotes, brackets, `>`, spaces, backslashes, `&`, `<`, and a few plain ones. */
export const hostileValue: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: word, weight: 2 },
  { arbitrary: fc.constantFrom('a"b', "a'b", 'a]b', 'a[b', 'a > b', 'a b c', 'a\\b', '\\', '"]', '"] > *', 'x\\"y', '&amp;', '<b>', 'a,b', '#x', '.y', ':nth-of-type(2)', ' lead', 'trail '), weight: 3 },
  { arbitrary: fc.stringMatching(/^[a-z "'\[\]>\\.,:#=&<-]{1,30}$/), weight: 3 }
);

const ROLES = ['table', 'list', 'listitem', 'row', 'grid', 'main', 'region', 'navigation', 'article', 'button', 'textbox', 'heading', 'cell', 'img', 'dialog'] as const;
const role: fc.Arbitrary<string> = fc.constantFrom(...ROLES);

// ---- documents ------------------------------------------------------------------------------------------------------

export interface PageNode {
  tag: string;
  attrs: Array<[string, string]>;
  /** Text before the children. */
  text?: string;
  children: PageNode[];
}
export interface PageDocument { root: PageNode[] }   // the children of <body>

const TAGS = ['div', 'span', 'section', 'article', 'main', 'nav', 'aside', 'ul', 'ol', 'li', 'p', 'form', 'header', 'footer'] as const;
const text: fc.Arbitrary<string> = fc.oneof(fc.constant(undefined), fc.stringMatching(/^[A-Za-z0-9 .,]{0,24}$/));

const attrsArb: fc.Arbitrary<Array<[string, string]>> = fc
  .record({
    id: fc.option(anyId, { nil: undefined, freq: 3 }),
    classes: fc.array(anyClass, { maxLength: 4 }),
    testId: fc.option(hostileValue, { nil: undefined, freq: 5 }),
    role: fc.option(role, { nil: undefined, freq: 4 }),
    ariaLabel: fc.option(hostileValue, { nil: undefined, freq: 6 }),
    title: fc.option(hostileValue, { nil: undefined, freq: 6 }),
    name: fc.option(hostileValue, { nil: undefined, freq: 8 }),
  })
  .map((r) => {
    const out: Array<[string, string]> = [];
    if (r.id !== undefined) out.push(['id', r.id]);
    if (r.classes.length > 0) out.push(['class', r.classes.join(' ')]);
    if (r.testId !== undefined) out.push(['data-testid', r.testId]);
    if (r.role !== undefined) out.push(['role', r.role]);
    if (r.ariaLabel !== undefined) out.push(['aria-label', r.ariaLabel]);
    if (r.title !== undefined) out.push(['title', r.title]);
    if (r.name !== undefined) out.push(['name', r.name]);
    return out;
  });

/** Children of one level: each generated child is repeated 1 to 3 times, so same-tag siblings are common. */
const repeated = (child: fc.Arbitrary<PageNode>): fc.Arbitrary<PageNode[]> =>
  fc
    .array(fc.tuple(child, fc.integer({ min: 1, max: 3 })), { maxLength: 4 })
    .map((items) => items.flatMap(([node, n]) => Array.from({ length: n }, () => structuredClone(node))));

const { node: nodeArb } = fc.letrec<{ node: PageNode }>((tie) => ({
  node: fc
    .record({
      tag: fc.constantFrom(...TAGS),
      attrs: attrsArb,
      text,
      children: fc.oneof({ arbitrary: fc.constant<PageNode[]>([]), weight: 1 }, { arbitrary: repeated(tie('node')), weight: 2 }),
    })
    .map((n): PageNode => ({ tag: n.tag, attrs: n.attrs, ...(n.text ? { text: n.text } : {}), children: n.children })),
}));

/** A document of nested elements with repeated siblings. At least one element, depth bounded by fast-check's size. */
export const pageDocument: fc.Arbitrary<PageDocument> = fc
  .array(fc.tuple(nodeArb, fc.integer({ min: 1, max: 3 })), { minLength: 1, maxLength: 3 })
  .map((items) => ({ root: items.flatMap(([node, n]) => Array.from({ length: n }, () => structuredClone(node))) }));

const escapeAttr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escapeText = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function renderNode(n: PageNode): string {
  const attrs = n.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  return `<${n.tag}${attrs}>${n.text ? escapeText(n.text) : ''}${n.children.map(renderNode).join('')}</${n.tag}>`;
}

/** The HTML text of a document. */
export function renderPage(doc: PageDocument): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${doc.root.map(renderNode).join('')}</body></html>`;
}

/** Every element of the body in document order. */
export function elementsOf(doc: PageDocument): PageNode[] {
  const out: PageNode[] = [];
  const walk = (n: PageNode): void => {
    out.push(n);
    n.children.forEach(walk);
  };
  doc.root.forEach(walk);
  return out;
}

/** Child indexes from `<body>` down to the node (body's first child is `[0]`). */
export function pathOf(doc: PageDocument, index: number): number[] {
  const target = elementsOf(doc)[index];
  const search = (nodes: PageNode[], prefix: number[]): number[] | undefined => {
    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i] === target) return [...prefix, i];
      const found = search(nodes[i].children, [...prefix, i]);
      if (found) return found;
    }
    return undefined;
  };
  return search(doc.root, []) ?? [];
}

/** A page with its marked element: `index` is the position among `elementsOf(doc)`, `path` the child indexes from body. */
export interface MarkedPage {
  doc: PageDocument;
  html: string;
  index: number;
  path: number[];
  marked: PageNode;
}

/** Chooses the marked element of a document (any element, uniformly). */
export function chooseMarked(doc: PageDocument): fc.Arbitrary<MarkedPage> {
  const all = elementsOf(doc);
  return fc.integer({ min: 0, max: all.length - 1 }).map((index) => ({ doc, html: renderPage(doc), index, path: pathOf(doc, index), marked: all[index] }));
}

/** A page and its marked element. */
export const markedPage: fc.Arbitrary<MarkedPage> = pageDocument.chain(chooseMarked);

// ---- element info, zone facts, zones ----------------------------------------------------------------------------------

/** What the page reports about the marked element. Values are hostile on purpose. */
export const elementInfo: fc.Arbitrary<ElementInfo> = fc
  .record({
    role: fc.option(role, { nil: undefined }),
    name: fc.option(hostileValue, { nil: undefined }),
    id: fc.option(anyId, { nil: undefined }),
    testId: fc.option(hostileValue, { nil: undefined }),
    nameAttr: fc.option(hostileValue, { nil: undefined }),
    css: fc.option(fc.constantFrom('div.a', 'ul > li:nth-of-type(2)', 'body > div:nth-of-type(2) > p'), { nil: undefined }),
  })
  .map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as ElementInfo);

const compound: fc.Arbitrary<string> = fc.oneof(
  fc.tuple(fc.constantFrom(...TAGS), stableClass).map(([t, c]) => `${t}.${c}`),
  fc.tuple(fc.constantFrom(...TAGS), fc.integer({ min: 1, max: 4 })).map(([t, k]) => `${t}:nth-of-type(${k})`),
  stableId.map((i) => `#${i}`),
  fc.constantFrom(...TAGS)
);

/** A stable-looking selector the algorithm could return. */
export const minimalSelectorText: fc.Arbitrary<string> = fc.array(compound, { minLength: 1, maxLength: 4 }).map((p) => p.join(' '));
/** A Positional_Path in the format of `cssPath`. */
export const positionalSelectorText: fc.Arbitrary<string> = fc
  .array(fc.tuple(fc.constantFrom(...TAGS), fc.integer({ min: 1, max: 4 })), { minLength: 1, maxLength: 5 })
  .map((p) => `body > ${p.map(([t, k]) => `${t}:nth-of-type(${k})`).join(' > ')}`);

/** Facts as the page computes them; every field is optional, counts are 0 or more. */
export const zoneFacts: fc.Arbitrary<ZoneFacts> = fc
  .record({
    minimal: fc.option(minimalSelectorText, { nil: undefined }),
    positional: fc.option(positionalSelectorText, { nil: undefined }),
    shape: fc.option(
      fc.record({
        tag: fc.constantFrom('table', 'ul', 'ol', 'div', 'section', 'dl', 'main'),
        tableRows: fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
        listItems: fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
      }),
      { nil: undefined }
    ),
  })
  .map((f) => {
    const out: ZoneFacts = {};
    if (f.minimal !== undefined) out.minimal = f.minimal;
    if (f.positional !== undefined) out.positional = f.positional;
    if (f.shape) {
      const shape: NonNullable<ZoneFacts['shape']> = { tag: f.shape.tag };
      if (f.shape.tableRows !== undefined) shape.tableRows = f.shape.tableRows;
      if (f.shape.listItems !== undefined) shape.listItems = f.shape.listItems;
      out.shape = shape;
    }
    return out;
  });

export const zoneKind: fc.Arbitrary<string> = fc.constantFrom('text', 'table', 'list', 'fields', 'json', 'attribute', 'regex');

const selectorText: fc.Arbitrary<string> = fc.oneof(
  stableId.map((i) => `#${i}`),
  hostileValue.map((v) => `[data-testid="${v.replace(/["\\]/g, '')}"]`),
  hostileValue.map((v) => `role=table[name="${v.replace(/["\\]/g, '')}"]`),
  minimalSelectorText,
  positionalSelectorText
);

/** A web Result_Zone as the workflow file holds it: 1 to 5 selectors (`selector` equals the first), a fingerprint, or only `selector`. */
export const webZone: fc.Arbitrary<ResultZone> = fc.oneof(
  fc.record({ selector: selectorText }).map((z): ResultZone => ({ selector: z.selector, extractor: { kind: 'text' } as ResultZone['extractor'] })),
  fc
    .record({
      selectors: fc.uniqueArray(selectorText, { minLength: 1, maxLength: 5 }),
      tag: fc.constantFrom('table', 'ul', 'div', 'section', 'main'),
      kind: zoneKind,
      count: fc.option(fc.integer({ min: 1, max: 50 }), { nil: undefined }),
    })
    .map((r): ResultZone => ({
      selector: r.selectors[0],
      selectors: r.selectors,
      extractor: (r.kind === 'regex'
        ? { kind: 'regex', pattern: 'a+' }
        : r.kind === 'attribute'
          ? { kind: 'attribute', name: 'href' }
          : { kind: r.kind }) as ResultZone['extractor'],
      fingerprint: { tag: r.tag, kind: r.kind, ...(r.count !== undefined ? { count: r.count } : {}) },
    }))
);
