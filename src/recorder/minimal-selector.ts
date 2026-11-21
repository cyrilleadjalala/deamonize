/**
 * Shared Minimal_Selector / Positional_Path algorithm (group G-A).
 * The algorithm is plain JavaScript source text so it can run in the page (interpolated into CAPTURE_SCRIPT) and in Node
 * (evaluated once with `new Function`). The text holds no backtick and no dollar-brace, and uses no helper a bundler could add.
 */

/** What the algorithm needs to know about a document. N is a DOM Element or an HtmlNode. */
export interface NodeAdapter<N> {
  parent(n: N): N | undefined;
  tag(n: N): string;
  attr(n: N, name: string): string | undefined;
  classes(n: N): string[];
  sameTagSiblings(n: N): N[];
  resolve(selector: string): N[];
}

export interface MinimalSelectorOptions {
  maxLength?: number;
  includeBody?: boolean;
}

export interface MinimalSelectorResult {
  minimal?: string;
  positional: string;
  levels: { minimal: number; positional: number };
}

/**
 * Plain JavaScript, no backtick, no dollar-brace. Declares three functions: daemonizeIsGeneratedId(id),
 * daemonizeIsUnstableClass(name) and daemonizeMinimalSelector(adapter, target, options).
 *
 * Levels of a node: 1 #id, 2 tag[data-testid], 3 tag[role], 4 tag.class (at most 2 stable classes), 5 tag, 6 tag:nth-of-type(k).
 * Only plain identifiers and attribute values of [A-Za-z0-9 _.:/@-] (60 characters at most) are ever written.
 */
export const MINIMAL_SELECTOR_SOURCE: string = String.raw`
function daemonizeIsGeneratedId(id) {
  return /[0-9a-f]{8,}/i.test(id) || /^\d+$/.test(id) || /:[rR][0-9a-z]+:/.test(id) || /^_[rR]_[0-9a-z]+_/.test(id) ||
    /^\u00ab[^\u00bb]*\u00bb/.test(id) || /^radix-/.test(id);
}

function daemonizeIsUnstableClass(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 40) return true;
  if (!/^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return true;
  if (daemonizeIsGeneratedId(name)) return true;
  if (/\d{4,}/.test(name)) return true;
  if (/^css-[A-Za-z0-9]+(-[A-Za-z0-9]+)?$/.test(name)) return true;
  if (/^sc-[A-Za-z0-9]+$/.test(name) || /^jsx-\d+$/.test(name) || /^(?=.*[a-z])(?=.*[A-Z])[A-Za-z]{5,8}$/.test(name)) return true;
  if (/^svelte-[a-z0-9]{5,}$/.test(name)) return true;
  if (/^_[A-Za-z0-9]{5,}$/.test(name) || /^[A-Za-z0-9]+_[A-Za-z0-9-]+__[A-Za-z0-9_-]{5,}$/.test(name)) return true;
  if (/[-_](?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{5,8}$/.test(name)) return true;
  if (/[\[\]()\/:!@%,=.]/.test(name)) return true;
  if (/^-?(m|p|w|h|gap|space|text|bg|border|rounded|flex|grid|col|row|top|left|right|bottom|z|min|max|opacity|shadow|font|leading|tracking|justify|items|self|overflow|order)[xytblrse]?-[\w.]+$/.test(name)) return true;
  if (/^(flex|grid|hidden|block|inline|container|row|col)$/.test(name)) return true;
  if (/^(active|selected|open|opened|show|shown|hover|focus|focused|disabled|checked|expanded|collapsed|loading|current)$/.test(name) || /^(is|has)-/.test(name)) return true;
  return false;
}

function daemonizeMinimalSelector(adapter, target, options) {
  var maxLength = (options && options.maxLength) || 300;
  var includeBody = !!(options && options.includeBody);
  var PLAIN = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
  var VALUE = /^[A-Za-z0-9 _.:\/@-]{1,60}$/;
  var TAGOK = /^[a-z][a-z0-9-]*$/;
  var LANDMARK = { main: 1, nav: 1, header: 1, footer: 1, aside: 1, form: 1, section: 1, article: 1, table: 1, ul: 1, ol: 1, dl: 1 };
  var budget = 200;

  function resolveOnly(selector, node, free) {
    if (!free) {
      if (budget <= 0) return false;
      budget -= 1;
    }
    try {
      var found = adapter.resolve(selector);
      return found.length === 1 && found[0] === node;
    } catch (e) {
      return false;
    }
  }

  function plainId(node) {
    var id = adapter.attr(node, 'id');
    return id && PLAIN.test(id) && !daemonizeIsGeneratedId(id) ? id : undefined;
  }

  function compoundsOf(node) {
    var out = [];
    var tag = adapter.tag(node);
    if (!TAGOK.test(tag)) return out;
    var id = plainId(node);
    if (id !== undefined) out.push({ kind: 1, text: '#' + id });
    var testId = adapter.attr(node, 'data-testid');
    if (testId && VALUE.test(testId)) out.push({ kind: 2, text: tag + '[data-testid="' + testId + '"]' });
    var role = adapter.attr(node, 'role');
    if (role && VALUE.test(role)) out.push({ kind: 3, text: tag + '[role="' + role + '"]' });
    var classes = adapter.classes(node) || [];
    var used = 0;
    for (var i = 0; i < classes.length && used < 2; i += 1) {
      if (PLAIN.test(classes[i]) && !daemonizeIsUnstableClass(classes[i])) {
        out.push({ kind: 4, text: tag + '.' + classes[i] });
        used += 1;
      }
    }
    out.push({ kind: 5, text: tag });
    return out;
  }

  function partOf(node) {
    var tag = adapter.tag(node);
    var same = adapter.sameTagSiblings(node);
    return same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : tag;
  }

  // The full Positional_Path: nodes[0] is the target, parts are top-down.
  var nodes = [];
  var parts = [];
  var reachedBody = false;
  for (var node = target; node; node = adapter.parent(node)) {
    var tag = adapter.tag(node);
    if (tag === 'html' || tag === '#root') break;
    if (tag === 'body' && !includeBody) {
      reachedBody = true;
      break;
    }
    var id = plainId(node);
    if (id !== undefined && resolveOnly('#' + id, node, true)) {
      nodes.push(node);
      parts.unshift('#' + id);
      break;
    }
    nodes.push(node);
    parts.unshift(tag === 'body' ? 'body' : partOf(node));
    if (tag === 'body') break;
  }
  var positional = parts.join(' > ');
  // Levels and the suffix search always count body when the path reaches it, so both environments agree and a suffix is anchored.
  var anchored = reachedBody ? ['body'].concat(parts) : parts;
  var levelsPositional = anchored.length;
  if (nodes.length === 0) return { positional: positional, levels: { minimal: 0, positional: levelsPositional } };

  var result;
  var resultLevels = 0;
  function accept(selector, levels) {
    if (selector.length > maxLength) return false;
    result = selector;
    resultLevels = levels;
    return true;
  }
  function done() {
    var out = { positional: positional, levels: { minimal: result === undefined ? 0 : resultLevels, positional: levelsPositional } };
    if (result !== undefined) out.minimal = result;
    return out;
  }

  // 1. The target alone.
  var own = compoundsOf(target);
  for (var a = 0; a < own.length; a += 1) {
    if (resolveOnly(own[a].text, target, false) && accept(own[a].text, 1)) return done();
  }
  var targetBest = own.length > 0 ? own[0].text : undefined;

  // 2. Climb through anchors: A T, then A > T.
  var anchorIdx = [];
  for (var i = 1; i < nodes.length; i += 1) {
    var nodeTag = adapter.tag(nodes[i]);
    if (nodeTag === 'html' || nodeTag === 'body') continue;
    var cs = compoundsOf(nodes[i]);
    if (cs.length > 0 && (cs[0].kind <= 4 || LANDMARK[nodeTag] === 1)) anchorIdx.push({ index: i, text: cs[0].text });
  }
  if (targetBest !== undefined) {
    var chain = [];
    var previous = 0;
    for (var k = 0; k < anchorIdx.length && k < 6; k += 1) {
      chain.unshift(anchorIdx[k].text);
      var direct = anchorIdx[k].index - previous === 1;
      previous = anchorIdx[k].index;
      var descendant = chain.join(' ') + ' ' + targetBest;
      if (resolveOnly(descendant, target, false) && accept(descendant, chain.length + 1)) return done();
      if (direct) {
        var child = chain[0] + ' > ' + chain.slice(1).concat([targetBest]).join(' ');
        if (resolveOnly(child, target, false) && accept(child, chain.length + 1)) return done();
      }
    }
  }

  // 3. Positional extension below the nearest anchor.
  if (anchorIdx.length > 0) {
    var near = anchorIdx[0];
    var inner = [];
    for (var j = 0; j < near.index; j += 1) {
      inner.unshift(partOf(nodes[j]));
      var joined = near.text + (j === near.index - 1 ? ' > ' : ' ') + inner.join(' > ');
      if (resolveOnly(joined, target, false) && accept(joined, 1 + inner.length)) return done();
    }
  }

  // 4. The shortest unique suffix of the full Positional_Path.
  for (var s = 1; s <= anchored.length; s += 1) {
    var suffix = anchored.slice(anchored.length - s).join(' > ');
    if (resolveOnly(suffix, target, true) && accept(suffix, s)) return done();
  }
  return done();
}
`;

interface Compiled {
  run: (adapter: unknown, target: unknown, options?: MinimalSelectorOptions) => MinimalSelectorResult;
  isUnstableClass: (name: string) => boolean;
  isGeneratedId: (id: string) => boolean;
}

let compiled: Compiled | undefined;

function compile(): Compiled {
  if (compiled === undefined) {
    compiled = new Function(
      `${MINIMAL_SELECTOR_SOURCE}\nreturn { run: daemonizeMinimalSelector, isUnstableClass: daemonizeIsUnstableClass, isGeneratedId: daemonizeIsGeneratedId };`
    )() as Compiled;
  }
  return compiled;
}

/** Node side: the same text evaluated once with `new Function`. */
export function createMinimalSelector<N>(): (
  adapter: NodeAdapter<N>,
  target: N,
  options?: MinimalSelectorOptions,
) => MinimalSelectorResult {
  const run = compile().run;
  return (adapter, target, options) => run(adapter, target, options);
}

export function isUnstableClass(name: string): boolean {
  return compile().isUnstableClass(name);
}

export function isGeneratedId(id: string): boolean {
  return compile().isGeneratedId(id);
}

/** True when the selector relies on element position. */
export function isPositionalSelector(selector: string): boolean {
  return /:nth-of-type|:nth-child|:first-child|:last-child/.test(selector);
}
