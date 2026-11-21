/**
 * Test adapters of the Minimal_Selector algorithm (group G-A): one over the html-zone parser, one that runs the same
 * source text inside a Chromium page. Test only.
 */
import type { Page } from 'playwright';
import { allNodes, parseHtml, resolveSelector, type HtmlNode } from '../../src/suggest/html-zone.js';
import { MINIMAL_SELECTOR_SOURCE, type MinimalSelectorOptions, type MinimalSelectorResult, type NodeAdapter } from '../../src/recorder/minimal-selector.js';

export function htmlAdapter(root: HtmlNode): NodeAdapter<HtmlNode> {
  return {
    parent: (n) => (n.parent !== undefined && n.parent.tag !== '#root' ? n.parent : undefined),
    tag: (n) => n.tag,
    attr: (n, name) => n.attrs[name],
    classes: (n) => (n.attrs['class'] ?? '').split(/\s+/).filter((c) => c !== ''),
    sameTagSiblings: (n) => (n.parent?.children ?? [n]).filter((s) => s.tag === n.tag),
    resolve: (selector) => resolveSelector(root, selector),
  };
}

/** The parsed document and every element below its body, in document order. */
export function parseBodyElements(html: string): { root: HtmlNode; elements: HtmlNode[] } {
  const root = parseHtml(html);
  const body = allNodes(root).find((n) => n.tag === 'body');
  return { root, elements: body === undefined ? [] : allNodes(body) };
}

export const BODY_OPTIONS: MinimalSelectorOptions = { includeBody: true };

export interface BrowserRow {
  result: MinimalSelectorResult;
  again: MinimalSelectorResult;
  /** minimal resolves to exactly the element (undefined when there is no minimal). */
  uniqueMinimal?: boolean;
  uniquePositional: boolean;
  error?: string;
}

/** Plain text, evaluated in the page: no helper a bundler could add. */
const BROWSER_RUNNER = `(function (input) {
  var run = new Function(input.source + '\\nreturn daemonizeMinimalSelector;')();
  var adapter = {
    parent: function (e) { return e.parentElement || undefined; },
    tag: function (e) { return e.tagName.toLowerCase(); },
    attr: function (e, name) { var v = e.getAttribute(name); return v === null ? undefined : v; },
    classes: function (e) { return Array.from(e.classList); },
    sameTagSiblings: function (e) { var p = e.parentElement; return p ? Array.from(p.children).filter(function (c) { return c.tagName === e.tagName; }) : [e]; },
    resolve: function (s) { return Array.from(document.querySelectorAll(s)); }
  };
  var out = [];
  input.bodies.forEach(function (html) {
    document.body.innerHTML = html;
    var rows = [];
    Array.from(document.body.querySelectorAll('*')).slice(0, input.limit).forEach(function (el) {
      var row = {};
      try {
        row.result = run(adapter, el, input.options);
        row.again = run(adapter, el, input.options);
        if (row.result.minimal !== undefined) {
          var m = document.querySelectorAll(row.result.minimal);
          row.uniqueMinimal = m.length === 1 && m[0] === el;
        }
        var p = document.querySelectorAll(row.result.positional);
        row.uniquePositional = p.length === 1 && p[0] === el;
      } catch (e) {
        row.error = String(e && e.message ? e.message : e);
        row.uniquePositional = false;
      }
      rows.push(row);
    });
    out.push(rows);
  });
  return out;
})`;

/** Runs the algorithm on every element of the body of each document (many documents per evaluate). */
export async function runInBrowser(page: Page, bodies: string[], options: MinimalSelectorOptions = BODY_OPTIONS, limit = 40): Promise<BrowserRow[][]> {
  const input = JSON.stringify({ source: MINIMAL_SELECTOR_SOURCE, bodies, options, limit });
  return (await page.evaluate(`${BROWSER_RUNNER}(${input})`)) as BrowserRow[][];
}

/** The inner HTML of the body of a rendered page. */
export function bodyOf(html: string): string {
  const m = /<body>([\s\S]*)<\/body>/.exec(html);
  return m === null ? '' : m[1]!;
}
