/**
 * A small, forgiving reader of a serialized final screen (the HTML the recorder stored), enough to pick a Result_Zone
 * and to check that a selector resolves on it. It is not a browser: selectors it cannot read do not resolve.
 */
import { buildZoneSelector, type ElementInfo } from '../recorder/selector-builder.js';
import type { SuggestedResultZone } from './suggester.js';

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent?: HtmlNode;
  /** Text directly inside the element. */
  text: string;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);

export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  let current = root;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  const addText = (text: string): void => {
    if (text.trim() !== '') current.text += `${current.text === '' ? '' : ' '}${decode(text).trim()}`;
  };
  while ((match = re.exec(html)) !== null) {
    addText(html.slice(last, match.index));
    last = re.lastIndex;
    if (match[1] !== undefined) {
      const tag = match[1].toLowerCase();
      for (let n: HtmlNode | undefined = current; n !== undefined && n !== root; n = n.parent) {
        if (n.tag === tag) {
          current = n.parent ?? root;
          break;
        }
      }
    } else if (match[2] !== undefined) {
      const tag = match[2].toLowerCase();
      const node: HtmlNode = { tag, attrs: parseAttrs(match[3] ?? ''), children: [], parent: current, text: '' };
      current.children.push(node);
      if (RAW_TEXT.has(tag) && match[4] !== '/') {
        const close = html.toLowerCase().indexOf(`</${tag}`, last);
        last = re.lastIndex = close < 0 ? html.length : close;
      } else if (!VOID.has(tag) && match[4] !== '/') {
        current = node;
      }
    }
  }
  addText(html.slice(last));
  return root;
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

function decode(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function allNodes(root: HtmlNode): HtmlNode[] {
  const out: HtmlNode[] = [];
  const walk = (n: HtmlNode): void => {
    for (const child of n.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

export function textOf(node: HtmlNode): string {
  return [node.text, ...node.children.map(textOf)].filter((t) => t !== '').join(' ');
}

const IMPLICIT_ROLES: Record<string, string> = {
  main: 'main',
  nav: 'navigation',
  aside: 'complementary',
  header: 'banner',
  footer: 'contentinfo',
  form: 'form',
  table: 'table',
  ul: 'list',
  ol: 'list',
  dialog: 'dialog',
  article: 'article',
  section: 'region',
  output: 'status',
};

export function roleOf(node: HtmlNode): string | undefined {
  return node.attrs['role'] || IMPLICIT_ROLES[node.tag];
}

/** The accessible name of a container: aria-label, aria-labelledby, a table caption, or the title attribute. */
export function nameOf(node: HtmlNode, root: HtmlNode): string | undefined {
  const label = node.attrs['aria-label']?.trim();
  if (label) return label;
  const by = node.attrs['aria-labelledby']?.trim();
  if (by) {
    const target = allNodes(root).find((n) => n.attrs['id'] === by.split(/\s+/)[0]);
    const text = target === undefined ? '' : textOf(target).trim();
    if (text !== '') return text;
  }
  if (node.tag === 'table') {
    const caption = node.children.find((c) => c.tag === 'caption');
    if (caption !== undefined && textOf(caption).trim() !== '') return textOf(caption).trim();
  }
  return node.attrs['title']?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// Selector resolution (only the forms the recorder writes)
// ---------------------------------------------------------------------------
export function selectorResolves(html: string, selector: string): boolean {
  return resolveSelector(parseHtml(html), selector).length > 0;
}

export function resolveSelector(root: HtmlNode, selector: string): HtmlNode[] {
  const nodes = allNodes(root);
  const sel = selector.trim();
  if (sel === '' || sel.length > 1000) return [];
  const role = /^role=([a-z]+)(?:\[name="((?:[^"\\]|\\.)*)"\])?$/.exec(sel);
  if (role) {
    const wanted = role[2]?.replace(/\\(.)/g, '$1');
    return nodes.filter((n) => roleOf(n) === role[1] && (wanted === undefined || nameOf(n, root) === wanted));
  }
  const css = parseCss(sel);
  if (css === undefined) return [];
  return nodes.filter((n) => matchesChain(n, css, css.length - 1));
}

interface Compound {
  combinator: ' ' | '>';
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<[string, string | undefined]>;
  nth?: number;
}

function parseCss(selector: string): Compound[] | undefined {
  const parts: Compound[] = [];
  let combinator: ' ' | '>' = ' ';
  // split on top-level whitespace and '>' outside quotes and brackets
  const tokens: string[] = [];
  let depth = 0;
  let quote = '';
  let buf = '';
  for (const ch of selector) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === '[' || ch === '(') {
      depth++;
      buf += ch;
    } else if (ch === ']' || ch === ')') {
      depth--;
      buf += ch;
    } else if (depth === 0 && (ch === ' ' || ch === '>')) {
      if (buf !== '') tokens.push(buf);
      buf = '';
      if (ch === '>') tokens.push('>');
    } else buf += ch;
  }
  if (buf !== '') tokens.push(buf);
  for (const token of tokens) {
    if (token === '>') {
      combinator = '>';
      continue;
    }
    const compound = parseCompound(token, combinator);
    if (compound === undefined) return undefined;
    parts.push(compound);
    combinator = ' ';
  }
  return parts.length === 0 ? undefined : parts;
}

function parseCompound(token: string, combinator: ' ' | '>'): Compound | undefined {
  const out: Compound = { combinator, classes: [], attrs: [] };
  let i = 0;
  const ident = /^(?:\\.|[A-Za-z0-9_-])+/;
  const readIdent = (): string | undefined => {
    const m = ident.exec(token.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    return m[0].replace(/\\(.)/g, '$1');
  };
  const first = token[0];
  if (first !== undefined && /[A-Za-z*]/.test(first)) {
    if (first === '*') i++;
    else out.tag = readIdent()?.toLowerCase();
  }
  while (i < token.length) {
    const ch = token[i];
    if (ch === '#') {
      i++;
      out.id = readIdent();
      if (out.id === undefined) return undefined;
    } else if (ch === '.') {
      i++;
      const c = readIdent();
      if (c === undefined) return undefined;
      out.classes.push(c);
    } else if (ch === '[') {
      const m = /^\[([A-Za-z_:][\w:-]*)(?:=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]]*)))?\]/.exec(token.slice(i));
      if (!m) return undefined;
      out.attrs.push([m[1].toLowerCase(), (m[2] ?? m[3] ?? m[4])?.replace(/\\(.)/g, '$1')]);
      i += m[0].length;
    } else if (ch === ':') {
      const m = /^:nth-of-type\((\d+)\)/.exec(token.slice(i));
      if (!m) return undefined;
      out.nth = Number(m[1]);
      i += m[0].length;
    } else return undefined;
  }
  return out;
}

function matchesCompound(node: HtmlNode, c: Compound): boolean {
  if (c.tag !== undefined && node.tag !== c.tag) return false;
  if (c.id !== undefined && node.attrs['id'] !== c.id) return false;
  const classes = (node.attrs['class'] ?? '').split(/\s+/);
  if (!c.classes.every((k) => classes.includes(k))) return false;
  for (const [name, value] of c.attrs) {
    if (!(name in node.attrs)) return false;
    if (value !== undefined && node.attrs[name] !== value) return false;
  }
  if (c.nth !== undefined) {
    const siblings = (node.parent?.children ?? []).filter((s) => s.tag === node.tag);
    if (siblings.indexOf(node) + 1 !== c.nth) return false;
  }
  return true;
}

function matchesChain(node: HtmlNode, chain: Compound[], index: number): boolean {
  if (!matchesCompound(node, chain[index])) return false;
  if (index === 0) return true;
  if (chain[index].combinator === '>') return node.parent !== undefined && matchesChain(node.parent, chain, index - 1);
  for (let p = node.parent; p !== undefined; p = p.parent) if (matchesChain(p, chain, index - 1)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Result_Zone heuristic
// ---------------------------------------------------------------------------
const LANDMARK_ROLES = new Set(['main', 'region', 'dialog', 'form', 'article', 'complementary']);

/** A CSS path from the document: tag names, with :nth-of-type where the parent has several of the same tag. */
function cssPath(node: HtmlNode): string {
  const parts: string[] = [];
  for (let n: HtmlNode | undefined = node; n !== undefined && n.tag !== '#root' && n.tag !== 'html'; n = n.parent) {
    if (n.tag === 'body') break;
    const same = (n.parent?.children ?? []).filter((s) => s.tag === n!.tag);
    parts.unshift(same.length > 1 ? `${n.tag}:nth-of-type(${same.indexOf(n) + 1})` : n.tag);
  }
  return parts.join(' > ');
}

function elementInfo(node: HtmlNode, root: HtmlNode): ElementInfo {
  const info: ElementInfo = { css: cssPath(node) };
  const role = roleOf(node);
  const name = nameOf(node, root);
  if (role !== undefined) info.role = role;
  if (name !== undefined) info.name = name;
  if (node.attrs['data-testid']) info.testId = node.attrs['data-testid'];
  if (node.attrs['id']) info.id = node.attrs['id'];
  return info;
}

/** The selector the recorder would write for this element, or undefined when none resolves on the document. */
function zoneSelectorFor(node: HtmlNode, root: HtmlNode): string | undefined {
  const selector = buildZoneSelector(elementInfo(node, root));
  if (selector !== undefined && resolveSelector(root, selector).includes(node)) return selector;
  const css = cssPath(node);
  return css !== '' && resolveSelector(root, css).includes(node) ? css : undefined;
}

/**
 * The main table, list, definition list or preformatted region of a final screen: the smallest named landmark that
 * contains the largest table (else list, definition list, pre or output), or that element itself.
 */
export function suggestResultZone(html: string): SuggestedResultZone | undefined {
  const root = parseHtml(html);
  const nodes = allNodes(root).filter((n) => !isHidden(n));
  const count = (n: HtmlNode, tag: string): number => allNodes(n).filter((d) => d.tag === tag).length;
  const largest = (items: HtmlNode[], size: (n: HtmlNode) => number, min: number): HtmlNode | undefined =>
    items.map((n) => ({ n, s: size(n) })).filter((x) => x.s >= min).sort((a, b) => b.s - a.s)[0]?.n;
  const table = largest(nodes.filter((n) => n.tag === 'table'), (n) => count(n, 'tr'), 2);
  const list = table ? undefined : largest(nodes.filter((n) => n.tag === 'ul' || n.tag === 'ol'), (n) => count(n, 'li'), 2);
  const dl = table || list ? undefined : largest(nodes.filter((n) => n.tag === 'dl'), (n) => count(n, 'dt'), 1);
  const text = table || list || dl ? undefined : largest(nodes.filter((n) => n.tag === 'pre' || n.tag === 'output'), (n) => textOf(n).length, 1);
  const target = table ?? list ?? dl ?? text;
  if (target === undefined) return undefined;
  const kind = table ? 'table' : list ? 'list' : dl ? 'fields' : 'text';
  let zone: HtmlNode = target;
  for (let p = target.parent; p !== undefined && p.tag !== '#root'; p = p.parent) {
    const role = roleOf(p);
    if (role !== undefined && LANDMARK_ROLES.has(role) && (nameOf(p, root) !== undefined || p.attrs['id'] !== undefined || role === 'main')) {
      zone = p;
      break;
    }
  }
  const selector = zoneSelectorFor(zone, root) ?? (zone === target ? undefined : zoneSelectorFor(target, root));
  return selector === undefined ? undefined : { selector, extractor: { kind } };
}

function isHidden(node: HtmlNode): boolean {
  for (let n: HtmlNode | undefined = node; n !== undefined; n = n.parent) {
    if ('hidden' in n.attrs || n.attrs['aria-hidden'] === 'true' || /display\s*:\s*none/i.test(n.attrs['style'] ?? '')) return true;
  }
  return false;
}
