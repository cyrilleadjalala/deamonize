/**
 * Script injected in every page and every frame of a recording session. It turns
 * the user's clicks, typing, selections and Enter presses into events sent to
 * `window.__daemonizeRecord`, together with what is needed to find the element
 * again without depending on the page structure:
 *
 * - `info`: role, accessible name, id, test id, name attribute, text, CSS path
 *   (input of the selector builder);
 * - `anchor`: ARIA role, accessible name, parent context (dialog, row or card,
 *   listbox, form, section heading, neighbouring label) and the frame path
 *   (iframe index chain with a name/title/src hint per frame).
 *
 * Custom components are recognised by their ARIA role (combobox, listbox,
 * option, menuitem, tab, switch, checkbox, radio), including the ones rendered
 * in a portal at the end of the body. Typing in a contenteditable element is
 * recorded as a `type` step. A `hover` or `scrollIntoView` step is recorded
 * before a click only when the clicked element was hidden until the hover, or
 * was outside the viewport until the page was scrolled.
 *
 * After a typed or selected value is recorded, a small "Make variable" box
 * appears in the page; the user names the variable there and the choice is
 * sent to `window.__daemonizeMarkVariable`.
 *
 * The pure helpers are exposed as `window.__daemonizeHelpers` for tests.
 *
 * Plain JavaScript in a string on purpose: it is serialized into the page, and
 * a function compiled by a bundler could reference helpers that do not exist there.
 * Values of password, one-time-code and token fields are never captured; the
 * event carries a `secretRef` name (PASSWORD, OTP, TOKEN) instead.
 */
import { MINIMAL_SELECTOR_SOURCE } from './minimal-selector.js';
import { ZONE_COPY } from './zone-copy.js';

export const CAPTURE_SCRIPT = `
(() => {
  if (window.__daemonizeInstalled) return;
  window.__daemonizeInstalled = true;

  const UI_ATTR = 'data-daemonize-ui';
  const MAX_POINTER_CLIMB = 6;
  const MAX_TEXT_SELECTOR_LENGTH = 60;
  const MAX_NAME_LENGTH = 80;
  const MAX_SUMMARY_LENGTH = 60;
  const LIVE_FLUSH_MS = 600;
  const NOTICE_LIFETIME_MS = 6000;
  const STATE_POLL_MS = 2000;
  const HOVER_WINDOW_MS = 10000;
  const SCROLL_WINDOW_MS = 5000;
  const MAX_HOVER_CANDIDATES = 400;

  const lastValues = new WeakMap();
  const CLICKABLE = [
    'button', 'a[href]', 'summary',
    'input[type=button]', 'input[type=submit]', 'input[type=reset]', 'input[type=checkbox]', 'input[type=radio]',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]',
    '[role=combobox]', '[role=option]', '[role=switch]', '[role=checkbox]', '[role=radio]', '[role=treeitem]',
  ].join(', ');
  const CONTENT_ROLES = new Set([
    'button', 'link', 'tab', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio',
    'switch', 'heading', 'cell', 'gridcell', 'columnheader', 'rowheader', 'row', 'treeitem', 'tooltip', 'listitem',
    'article', 'figure', 'status', 'alert',
  ]);
  const BUTTON_INPUTS = ['button', 'submit', 'reset'];
  const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

  function inUi(target) {
    return target instanceof Element && target.closest('[' + UI_ATTR + ']') !== null;
  }

  function typeOf(el) {
    return (el.getAttribute('type') || 'text').toLowerCase();
  }

  function collapse(text) {
    return (text || '').replace(/\\s+/g, ' ').trim();
  }

  function clean(text) {
    const value = collapse(text);
    return value.length > MAX_NAME_LENGTH ? value.slice(0, MAX_NAME_LENGTH) : value;
  }

  // ---------------------------------------------------------------- role

  const TAG_ROLES = {
    BUTTON: 'button', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading',
    H5: 'heading', H6: 'heading', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row',
    TD: 'cell', TH: 'columnheader', NAV: 'navigation', MAIN: 'main', ARTICLE: 'article', DIALOG: 'dialog',
    OPTION: 'option', OPTGROUP: 'group', FIELDSET: 'group', SUMMARY: 'button', ASIDE: 'complementary',
    HEADER: 'banner', FOOTER: 'contentinfo', PROGRESS: 'progressbar', METER: 'meter', HR: 'separator',
  };

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().split(/\\s+/)[0].toLowerCase();
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    const tag = el.tagName;
    if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href') ? 'link' : undefined;
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'IMG') return el.getAttribute('alt') === '' ? undefined : 'img';
    if (tag === 'FORM') return hasLabelAttribute(el) ? 'form' : undefined;
    if (tag === 'SECTION') return hasLabelAttribute(el) ? 'region' : undefined;
    if (tag === 'INPUT') {
      const t = typeOf(el);
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (t === 'password' || t === 'hidden' || t === 'file' || t === 'color' || t === 'date') return undefined;
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
    }
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    if (isEditableHost(el)) return 'textbox';
    return undefined;
  }

  function hasLabelAttribute(el) {
    return !!collapse(el.getAttribute('aria-label')) || el.hasAttribute('aria-labelledby');
  }

  function isEditableHost(el) {
    return el.isContentEditable === true && !(el.parentElement && el.parentElement.isContentEditable);
  }

  // ---------------------------------------------------------------- accessible name
  // A compact approximation of the accessible name computation (accname 1.1,
  // as implemented by dom-accessibility-api): aria-labelledby, aria-label,
  // native labelling (label elements, alt, value, legend, caption, placeholder),
  // content of the element and its descendants, then the title attribute.

  function isHidden(el) {
    if (SKIPPED_TAGS.has(el.tagName) || el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const style = getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  }

  function embeddedValue(el) {
    const role = roleOf(el);
    if (el.tagName === 'SELECT') {
      return Array.from(el.selectedOptions || []).map((o) => collapse(o.textContent)).join(' ');
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return typeOf(el) === 'password' ? '' : collapse(el.value);
    }
    if (role === 'textbox' || role === 'combobox') return collapse(el.textContent);
    if (role === 'slider' || role === 'spinbutton') return collapse(el.getAttribute('aria-valuenow'));
    return '';
  }

  function contentOf(el, ctx) {
    let out = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue;
      } else if (child.nodeType === 1) {
        if (child === ctx.skip) continue;
        const text = computeName(child, { recursion: true, inLabelledby: ctx.inLabelledby, skip: ctx.skip });
        if (!text) continue;
        const display = getComputedStyle(child).display;
        out += display.indexOf('inline') === 0 ? text : ' ' + text + ' ';
      }
    }
    return collapse(out);
  }

  function nativeName(el, ctx) {
    const tag = el.tagName;
    const type = tag === 'INPUT' ? typeOf(el) : '';
    if (tag === 'INPUT' && BUTTON_INPUTS.includes(type)) {
      return collapse(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    }
    if (tag === 'IMG' || tag === 'AREA' || (tag === 'INPUT' && type === 'image')) {
      return collapse(el.getAttribute('alt'));
    }
    if (el.labels && el.labels.length > 0) {
      const parts = Array.from(el.labels).map((label) => contentOf(label, { skip: el, inLabelledby: ctx.inLabelledby }));
      const joined = collapse(parts.join(' '));
      if (joined) return joined;
    }
    if (tag === 'FIELDSET') {
      const legend = Array.from(el.children).find((c) => c.tagName === 'LEGEND');
      if (legend) return contentOf(legend, {});
    }
    if (tag === 'TABLE') {
      const caption = Array.from(el.children).find((c) => c.tagName === 'CAPTION');
      if (caption) return contentOf(caption, {});
    }
    if (tag === 'FIGURE') {
      const caption = el.querySelector('figcaption');
      if (caption) return contentOf(caption, {});
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') return collapse(el.getAttribute('placeholder'));
    if (isEditableHost(el)) {
      return collapse(el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder'));
    }
    if (el instanceof SVGElement) {
      const title = Array.from(el.children).find((c) => c.tagName.toLowerCase() === 'title');
      if (title) return collapse(title.textContent);
    }
    return '';
  }

  function computeName(el, ctx) {
    if (!ctx.referenced && isHidden(el)) return '';

    if (!ctx.inLabelledby) {
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
      if (ids.length > 0) {
        const root = el.getRootNode();
        const parts = ids
          .map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id)))
          .filter(Boolean)
          .map((ref) => computeName(ref, { recursion: true, inLabelledby: true, referenced: true }))
          .filter(Boolean);
        if (parts.length > 0) return collapse(parts.join(' '));
      }
    }

    if (ctx.recursion) {
      const embedded = embeddedValue(el);
      if (embedded) return embedded;
    }

    const aria = collapse(el.getAttribute('aria-label'));
    if (aria) return aria;

    const native = nativeName(el, ctx);
    if (native) return native;

    const role = roleOf(el);
    if (ctx.recursion || !role || CONTENT_ROLES.has(role)) {
      const content = contentOf(el, ctx);
      if (content) return content;
    }

    const title = collapse(el.getAttribute('title'));
    if (title) return title;

    // A custom combobox usually shows its current value or prompt as text
    // (a native select has no such text: the labels of all its options are not its name)
    if (role === 'combobox' && el.tagName !== 'SELECT') return contentOf(el, ctx);
    return '';
  }

  function accessibleNameOf(el) {
    return clean(computeName(el, { recursion: false }));
  }

  // ---------------------------------------------------------------- context

  function visibleText(node) {
    // Text of an element without the text of the controls inside it
    const parts = [];
    const walk = (current) => {
      for (const child of current.childNodes) {
        if (child.nodeType === 3) {
          const text = collapse(child.nodeValue);
          if (text) parts.push(text);
        } else if (child.nodeType === 1 && !isHidden(child)) {
          if (child.matches('button, a, input, select, textarea, [role=button], [role=link], [' + UI_ATTR + ']')) continue;
          walk(child);
        }
      }
    };
    walk(node);
    return parts;
  }

  function quoteForSelector(text) {
    return text.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
  }

  function dialogName(dialog) {
    const name = accessibleNameOf(dialog);
    if (name) return name;
    const heading = dialog.querySelector('h1, h2, h3, h4, h5, h6, [role=heading]');
    return heading ? clean(heading.textContent) : '';
  }

  function headingOf(section) {
    if (section.tagName === 'FIELDSET') {
      const legend = Array.from(section.children).find((c) => c.tagName === 'LEGEND');
      if (legend && !isHidden(legend)) return clean(contentOf(legend, {}));
    }
    const heading = section.querySelector('h1, h2, h3, h4, h5, h6, [role=heading]');
    return heading ? clean(heading.textContent) : '';
  }

  const ROW_SELECTOR = 'tr, [role=row], article, [role=article], li, [role=listitem], [data-card], [class~=card]';

  const CELL_SELECTOR = 'td, th, [role=cell], [role=gridcell], [role=rowheader], [role=columnheader]';
  const MAX_KEY_LENGTH = 80;
  const MAX_ROW_TEXTS = 20;
  const SELECTION_SETTLE_MS = 300;

  function sameStructure(a, b) {
    return a.tagName === b.tagName && (a.getAttribute('role') || '') === (b.getAttribute('role') || '');
  }

  function cellText(cell) {
    if (cell.querySelector('button, [role=button], input, select, textarea')) return collapse(visibleText(cell).join(' '));
    return collapse(cell.textContent);
  }

  function rowCells(row) {
    const cells = Array.from(row.children).filter((c) => c.matches(CELL_SELECTOR));
    if (cells.length > 0) return { cells: cells.map(cellText), tabular: true };
    return { cells: visibleText(row).map(collapse), tabular: false };
  }

  function normalizeKey(text) {
    return collapse(text).normalize('NFC').toLowerCase();
  }

  // Describes the record (table row, card, list item) the element belongs to,
  // or undefined when the container is not one of several of the same structure.
  function rowInfo(row) {
    const tag = row.tagName.toLowerCase();
    const role = (row.getAttribute('role') || '').toLowerCase();
    const tabular = tag === 'tr' || role === 'row';
    const kind = tabular ? 'row' : tag === 'li' || role === 'listitem' ? 'listitem' : 'card';
    const parent = row.parentElement;
    const siblings = parent ? Array.from(parent.children).filter((c) => c !== row && sameStructure(c, row)) : [];
    if (siblings.length === 0) return undefined;

    const own = rowCells(row);
    if (own.cells.length === 0 || own.cells.every((c) => !c)) return undefined;
    // A header row (only header cells) is not a record
    if (tabular && Array.from(row.children).every((c) => c.matches('th, [role=columnheader]'))) return undefined;

    const others = siblings.map(rowCells);
    const taken = new Set();
    others.forEach((o) => o.cells.forEach((c, i) => taken.add(tabular ? i + '|' + normalizeKey(c) : normalizeKey(c))));
    const usable = (c) => c && c.length <= MAX_KEY_LENGTH;
    let at = own.cells.findIndex((c, i) => usable(c) && !taken.has(tabular ? i + '|' + normalizeKey(c) : normalizeKey(c)));
    if (at < 0) at = own.cells.findIndex(usable);
    if (at < 0) return undefined;

    const key = { text: own.cells[at] };
    if (tabular && own.tabular) {
      const table = row.closest('table, [role=table], [role=grid], [role=treegrid]');
      const header = table ? table.querySelector('tr:has(th), [role=row]:has([role=columnheader])') : null;
      if (header) {
        const names = Array.from(header.children).filter((c) => c.matches(CELL_SELECTOR));
        const column = names[at] ? collapse(names[at].textContent) : '';
        if (column) key.column = column;
      }
    }

    const container = { kind };
    if (role) container.role = role;
    if (kind === 'card') {
      // A class every sibling shares narrows the search to the cards of this list
      const shared = Array.from(row.classList).find((cls) => siblings.every((s) => s.classList.contains(cls)));
      container.selectorHint = tag + (shared ? '.' + CSS.escape(shared) : '');
    }
    return { rowBinding: { container, key }, texts: own.cells.filter(Boolean).slice(0, MAX_ROW_TEXTS) };
  }

  function isFormLayoutRow(row, el) {
    if (row.tagName !== 'TR' || !row.firstElementChild || row.firstElementChild.tagName !== 'TH') return false;
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return false;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes(typeOf(el));
  }

  // The nearest enclosing context that tells two identical controls apart
  function parentContext(el) {
    const up = el.parentElement;
    if (!up) return undefined;

    const list = up.closest('[role=listbox], [role=menu]');
    if (list) {
      const name = accessibleNameOf(list);
      return { kind: 'region', name, selector: name ? 'role=' + roleOf(list) + '[name="' + quoteForSelector(name) + '"]' : undefined };
    }

    let row = up.closest(ROW_SELECTOR);
    while (row) {
      // A form laid out as a table (label in a th, then the control) is not a list of records: its rows are not bound
      if (isFormLayoutRow(row, el)) {
        row = row.parentElement ? row.parentElement.closest(ROW_SELECTOR) : null;
        continue;
      }
      const parts = visibleText(row);
      const binding = rowInfo(row);
      if (binding) {
        // Rows of a dynamic list are found again by the value of a Variable, not by a selector that embeds the recorded text
        return {
          kind: 'region',
          name: clean(parts.join(' ')).slice(0, MAX_SUMMARY_LENGTH),
          rowBinding: binding.rowBinding,
          rowTexts: binding.texts,
        };
      }
      if (parts.length > 0) {
        const tag = row.tagName.toLowerCase();
        const container = row.hasAttribute('role') ? '[role=' + row.getAttribute('role') + ']' : tag;
        return {
          kind: 'region',
          name: clean(parts.join(' ')).slice(0, MAX_SUMMARY_LENGTH),
          selector: container + ':has-text("' + quoteForSelector(parts[0].slice(0, MAX_SUMMARY_LENGTH)) + '")',
        };
      }
      row = row.parentElement ? row.parentElement.closest(ROW_SELECTOR) : null;
    }

    const dialog = up.closest('dialog, [role=dialog], [role=alertdialog]');
    if (dialog) {
      const name = dialogName(dialog);
      return { kind: 'dialog', name, selector: name ? 'role=dialog[name="' + quoteForSelector(name) + '"]' : undefined };
    }

    const form = up.closest('form');
    if (form) {
      const name = hasLabelAttribute(form) ? accessibleNameOf(form) : '';
      if (name) return { kind: 'region', name };
    }

    let section = up.closest('section, fieldset, [role=region], [role=group], [role=radiogroup]');
    while (section) {
      const name = hasLabelAttribute(section) ? accessibleNameOf(section) : '';
      if (name) return { kind: 'region', name };
      const heading = headingOf(section);
      if (heading) return { kind: 'heading', name: heading };
      section = section.parentElement ? section.parentElement.closest('section, fieldset, [role=region], [role=group], [role=radiogroup]') : null;
    }

    const previous = el.previousElementSibling;
    if (previous && previous.tagName === 'LABEL' && !(el.labels && Array.from(el.labels).includes(previous))) {
      const name = clean(previous.textContent);
      if (name) return { kind: 'label', name };
    }
    return undefined;
  }

  // Chain of iframe positions from the top document to this frame
  function framePath() {
    const path = [];
    const hints = [];
    let complete = true;
    let current = window;
    while (current !== current.top) {
      let frameElement = null;
      try { frameElement = current.frameElement; } catch (e) { frameElement = null; }
      if (!frameElement) {
        complete = false;
        break;
      }
      const siblings = Array.from(frameElement.ownerDocument.querySelectorAll('iframe, frame'));
      path.unshift(siblings.indexOf(frameElement));
      const hint = {};
      const name = frameElement.getAttribute('name');
      const title = frameElement.getAttribute('title');
      const src = frameElement.getAttribute('src');
      if (name) hint.name = name;
      if (title) hint.title = title;
      if (src) hint.src = src;
      hints.unshift(hint);
      current = current.parent;
    }
    return { path, hints, complete };
  }

  // ---------------------------------------------------------------- secrets

  const OTP_PATTERN = /one-time-code|otp|totp|2fa|mfa|verification[-_ ]?code|authenticator/i;
  const TOKEN_PATTERN = /token|api[-_ ]?key/i;

  // PASSWORD, OTP or TOKEN when the value of this field must never be recorded
  function secretKind(el) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return undefined;
    if (el.tagName === 'INPUT' && typeOf(el) === 'password') return 'PASSWORD';
    const autocomplete = el.getAttribute('autocomplete') || '';
    if (/password/i.test(autocomplete)) return 'PASSWORD';
    const hint = [autocomplete, el.getAttribute('name'), el.id].join(' ');
    if (OTP_PATTERN.test(hint)) return 'OTP';
    if (TOKEN_PATTERN.test(hint)) return 'TOKEN';
    return undefined;
  }

  // ---------------------------------------------------------------- selector info

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  // Minimal_Selector and Positional_Path: one algorithm, shared with the Node side (src/recorder/minimal-selector.ts)
  ${MINIMAL_SELECTOR_SOURCE}

  const ZONE_ADAPTER = {
    parent: (n) => (n === document.documentElement ? undefined : n.parentElement || undefined),
    tag: (n) => n.tagName.toLowerCase(),
    attr: (n, name) => {
      const v = n.getAttribute(name);
      return v === null ? undefined : v;
    },
    classes: (n) => Array.from(n.classList),
    sameTagSiblings: (n) => (n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [n]),
    resolve: (s) => Array.from(document.querySelectorAll(s)),
  };

  function minimalOf(el) {
    try {
      return daemonizeMinimalSelector(ZONE_ADAPTER, el, { includeBody: true });
    } catch (e) {
      return null;
    }
  }

  // What the recorder needs to rank, prove and fingerprint the selectors of a result zone
  function zoneFactsOf(el) {
    const facts = {};
    const found = minimalOf(el);
    if (found) {
      if (found.minimal) facts.minimal = found.minimal;
      if (found.positional) facts.positional = found.positional;
    }
    facts.shape = { tag: el.tagName.toLowerCase() };
    const table = analyzeZone(el, 'table');
    if (table.count >= 1) facts.shape.tableRows = table.count;
    const list = analyzeZone(el, 'list');
    if (list.count >= 1) facts.shape.listItems = list.count;
    return facts;
  }

  let zoneTarget = null;

  function infoOf(el, context) {
    const role = roleOf(el);
    const name = accessibleNameOf(el);
    const info = {
      role,
      name: name || undefined,
      id: el.id || undefined,
      testId: el.getAttribute('data-testid') || undefined,
      nameAttr: el.getAttribute('name') || undefined,
      css: cssPath(el),
    };
    // Elements without a role (clickable divs, spans) are found by their text
    if (!role && name && name.length <= MAX_TEXT_SELECTOR_LENGTH) info.text = name;
    if (context && context.selector) info.parentSelector = context.selector;
    return info;
  }

  function anchorOf(el, info, context) {
    const frame = framePath();
    const anchor = {
      role: info.role || (el.tagName === 'INPUT' ? 'textbox' : 'generic'),
      name: info.name || '',
      frame: frame.path,
    };
    if (context) anchor.parent = { kind: context.kind, name: context.name };
    if (frame.hints.some((h) => h.name || h.title || h.src)) anchor.frameHints = frame.hints;
    return { anchor, frameComplete: frame.complete };
  }

  // The element the user meant to click: a standard control, or the outermost
  // element that behaves like one (onclick handler or pointer cursor).
  function clickTarget(start) {
    if (!(start instanceof Element)) return null;
    if (start.isContentEditable) return null;
    const standard = start.closest(CLICKABLE);
    if (standard) return standard;
    if (start.closest('label, input, textarea, select')) return null;

    const behavesLikeButton = (node) =>
      node.hasAttribute('onclick') || typeof node.onclick === 'function' || getComputedStyle(node).cursor === 'pointer';

    if (!behavesLikeButton(start)) return null;
    let target = start;
    for (let i = 0; i < MAX_POINTER_CLIMB; i++) {
      const parent = target.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (!behavesLikeButton(parent)) break;
      target = parent;
    }
    return target;
  }

  function toSnake(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value';
  }

  // ---------------------------------------------------------------- result zone

  const RESULT_KINDS = ['text', 'table', 'list', 'fields', 'json', 'attribute'];
  const RESULT_CONTAINERS = 'table, [role=table], [role=grid], ul, ol, [role=list], dl, pre, code, input, select, textarea';
  const MAX_TRAIL_DEPTH = 24;
  const MAX_PREVIEW_ITEMS = 12;
  let markingResult = false;

  // The element holding a result: the table, list, definition list, pre or field around the click
  function resultZoneElement(target) {
    if (!(target instanceof Element)) return document.body;
    return target.closest(RESULT_CONTAINERS) || target;
  }

  function zoneText(el) {
    return (el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent) || '';
  }

  function zoneWithin(el, selector) {
    return el.matches(selector) ? el : el.querySelector(selector);
  }

  function elLabel(el) {
    if (!el || !el.tagName) return 'element';
    const tag = el.tagName.toLowerCase();
    if (el.id && el.id.length <= 24) return tag + '#' + el.id;
    const cls = Array.from(el.classList || []).find((c) => /^[a-z][a-z0-9_-]{1,22}$/i.test(c));
    return cls ? tag + '.' + cls : tag;
  }

  // Ancestor chain from the pointed element up to the top container inside <body>, with initial cursor on the snapped result box
  function buildMarkTrail(rawEl) {
    if (!(rawEl instanceof Element)) return { trail: [document.body], cursor: 0 };
    const snapped = resultZoneElement(rawEl);
    const trail = [];
    let node = rawEl;
    while (node && node.nodeType === 1 && node !== document.documentElement && trail.length < MAX_TRAIL_DEPTH) {
      if (node === document.body && trail.length > 0) break;
      trail.push(node);
      node = node.parentElement;
    }
    if (trail.length === 0) trail.push(document.body);
    const idx = trail.indexOf(snapped);
    return { trail, cursor: idx >= 0 ? idx : 0 };
  }

  function clipLine(text, max) {
    const s = collapse(text);
    return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
  }

  // Live preview + matching sub-element rects aligned with WEB_ZONE_FUNCTION in extract.ts
  function analyzeZone(el, kind) {
    if (!(el instanceof Element)) return { ok: false, badge: 'nothing selected', lines: [], rects: [] };
    if (kind === 'table') {
      const TABLE = 'table, [role=table], [role=grid], [role=treegrid]';
      const CELL = 'th, td, [role=cell], [role=gridcell], [role=columnheader], [role=rowheader]';
      const table = zoneWithin(el, TABLE);
      if (!table) return { ok: false, badge: 'no table here', lines: ['Try "list" or "text", or click Wider.'], rects: [] };
      const rows = Array.from(table.querySelectorAll('tr, [role=row]')).filter((row) => row.closest(TABLE) === table);
      const nonEmpty = [];
      for (let i = 0; i < rows.length; i++) {
        const cells = Array.from(rows[i].querySelectorAll(CELL)).filter((cell) => cell.closest('tr, [role=row]') === rows[i]).map((c) => collapse(zoneText(c)));
        if (cells.some(Boolean)) nonEmpty.push({ row: rows[i], cells });
      }
      const cols = nonEmpty.reduce((m, r) => Math.max(m, r.cells.length), 0);
      const lines = nonEmpty.slice(0, 3).map((r) => clipLine(r.cells.slice(0, 4).join(' \u00b7 '), 68));
      if (nonEmpty.length > 3) lines.push('+' + (nonEmpty.length - 3) + ' more rows');
      return {
        ok: nonEmpty.length > 0,
        badge: nonEmpty.length + (nonEmpty.length === 1 ? ' row' : ' rows') + (cols ? ' \u00d7 ' + cols + ' cols' : ''),
        lines: lines.length ? lines : ['(empty table)'],
        count: nonEmpty.length,
        rects: nonEmpty.slice(0, MAX_PREVIEW_ITEMS).map((r) => r.row.getBoundingClientRect()),
      };
    }
    if (kind === 'list') {
      const LIST = 'ul, ol, [role=list]';
      const list = zoneWithin(el, LIST);
      if (!list) return { ok: false, badge: 'no list here', lines: ['Try "text", or click Wider to wrap a list.'], rects: [] };
      const allItems = Array.from(list.querySelectorAll('li, [role=listitem]')).filter((it) => it.closest(LIST) === list);
      const items = allItems.map((it) => ({ el: it, text: collapse(zoneText(it)) })).filter((x) => x.text.length > 0);
      const lines = items.slice(0, 3).map((x) => '\u2022 ' + clipLine(x.text, 64));
      if (items.length > 3) lines.push('+' + (items.length - 3) + ' more items');
      return {
        ok: items.length > 0,
        badge: items.length + (items.length === 1 ? ' item' : ' items'),
        lines: lines.length ? lines : ['(empty list)'],
        count: items.length,
        rects: items.slice(0, MAX_PREVIEW_ITEMS).map((x) => x.el.getBoundingClientRect()),
      };
    }
    if (kind === 'fields') {
      const pairs = [];
      const rects = [];
      const dl = zoneWithin(el, 'dl');
      if (dl) {
        let lbl = null;
        Array.from(dl.children).forEach((child) => {
          const nodes = child.tagName === 'DIV' ? Array.from(child.children) : [child];
          nodes.forEach((n) => {
            if (n.tagName === 'DT') lbl = collapse(zoneText(n));
            else if (n.tagName === 'DD' && lbl !== null) { pairs.push([lbl, collapse(zoneText(n))]); rects.push(n.getBoundingClientRect()); }
          });
        });
      }
      if (pairs.length === 0) {
        Array.from(el.matches('label') ? [el] : el.querySelectorAll('label')).forEach((lab) => {
          const ctl = lab.control || (lab.htmlFor ? document.getElementById(lab.htmlFor) : null);
          const val = ctl ? (ctl.value !== undefined ? String(ctl.value) : collapse(zoneText(ctl))) : (lab.nextElementSibling ? collapse(zoneText(lab.nextElementSibling)) : null);
          if (val !== null) { pairs.push([collapse(zoneText(lab)), val]); rects.push(lab.getBoundingClientRect()); }
        });
      }
      if (pairs.length === 0) {
        Array.from(el.children).forEach((child) => {
          if (child.children.length === 2) { pairs.push([collapse(zoneText(child.children[0])), collapse(zoneText(child.children[1]))]); rects.push(child.getBoundingClientRect()); }
        });
      }
      if (pairs.length === 0) return { ok: false, badge: 'no pairs found', lines: ['Try "text" or "table", or click Wider.'], rects: [] };
      const lines = pairs.slice(0, 3).map((p) => clipLine(p[0] + ': ' + p[1], 68));
      if (pairs.length > 3) lines.push('+' + (pairs.length - 3) + ' more fields');
      return { ok: true, badge: pairs.length + (pairs.length === 1 ? ' field' : ' fields'), lines, rects: rects.slice(0, MAX_PREVIEW_ITEMS) };
    }
    if (kind === 'json') {
      try {
        const parsed = JSON.parse((el.textContent || '').trim());
        const badge = Array.isArray(parsed) ? 'JSON array (' + parsed.length + ')' : parsed && typeof parsed === 'object' ? 'JSON (' + Object.keys(parsed).length + ' keys)' : 'valid JSON';
        return { ok: true, badge, lines: [clipLine(JSON.stringify(parsed), 110)], rects: [] };
      } catch (e) {
        return { ok: false, badge: 'not JSON', lines: ['Switch to "text" to read plain text.'], rects: [] };
      }
    }
    if (kind === 'attribute') {
      const target = el.matches('input, select, textarea, output') ? el : (el.querySelector('input, select, textarea, output') || el);
      let val = null;
      if (target.tagName === 'INPUT' && (target.type === 'checkbox' || target.type === 'radio')) val = target.checked ? 'true' : 'false';
      else if (target.tagName === 'SELECT') val = target.value;
      else if (target.value !== undefined && target.value !== null) val = String(target.value);
      return val === null
        ? { ok: false, badge: 'no value attribute', lines: ['Pick a form field or switch to "text".'], rects: [] }
        : { ok: true, badge: 'value', lines: [clipLine(val || '(empty)', 68)], rects: [] };
    }
    const text = collapse(zoneText(el));
    return {
      ok: text.length > 0,
      badge: text.length + ' chars',
      lines: [text ? clipLine(text, 120) : '(empty element)'],
      rects: [],
    };
  }

  // What the element looks like: table => table, ul/ol => list, dl => fields, pre/code with JSON => json
  function suggestResultKind(el) {
    if (el.matches('table, [role=table], [role=grid]')) return 'table';
    if (el.matches('ul, ol, [role=list]')) return 'list';
    if (el.matches('dl')) return 'fields';
    if (el.matches('input, select, textarea')) return 'attribute';
    if (el.matches('pre, code')) {
      try {
        JSON.parse((el.textContent || '').trim());
        return 'json';
      } catch (e) {
        return 'text';
      }
    }
    return 'text';
  }

  // The name of a content role (a status, a row) changes with the content: the zone is found by role alone then
  function resultInfoOf(el) {
    const info = infoOf(el, null);
    const content = collapse(el.textContent);
    if (info.name && (CONTENT_ROLES.has(info.role) || content === info.name || content.startsWith(info.name))) {
      info.name = undefined;
    }
    info.text = undefined;
    // The shortest selector that is unique in the page and uses stable parts first
    const found = minimalOf(el);
    if (found && found.minimal) info.css = found.minimal;
    return info;
  }

  // ---------------------------------------------------------------- recording panel

  // One root element per frame (data-daemonize-ui): everything the recorder shows lives inside it, so inUi() and the
  // screen hash drop it as a whole. The top frame shows the whole panel, a sub-frame only the offer row.
  const IS_TOP = window === window.top;
  const hasPanelBinding = () => typeof window.__daemonizePanel === 'function';
  const hasFinishBinding = () => typeof window.__daemonizeFinish === 'function';

  // Colours of the panel: the Kiro dark surfaces (docs/design-tokens.md). The panel sits over any site, light or dark,
  // so it has its own opaque surface and a hairline instead of borrowing the colours of the page.
  const K = {
    surface: '#19161d', raised: '#28242e', line: '#352f3d', tray: '#27272a', neutral: '#09090b',
    text: '#fafafa', muted: '#c1bec6', violet: '#9147ff', violetSoft: '#c59eff', violetText: '#e0ccff', violetDeep: '#471d86',
    red: '#f94358', green: '#35d482',
  };
  const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';
  // A page can style any tag: every control of the panel resets itself first and sets all it needs inline
  const BUTTON_BASE = 'all:initial;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;margin:0;font:500 13px/1.2 ' + FONT + ';';
  const BUTTONS = {
    quiet: BUTTON_BASE + 'color:' + K.text + ';background:transparent;border:1px solid ' + K.muted + ';border-radius:10px;padding:5px 12px',
    primary: BUTTON_BASE + 'color:#fff;background:' + K.violet + ';border:1px solid ' + K.violet + ';border-radius:12px;padding:9px 16px;width:100%',
    icon: BUTTON_BASE + 'color:' + K.text + ';background:' + K.line + ';border:1px solid transparent;border-radius:8px;width:26px;height:26px;padding:0',
    tab: BUTTON_BASE + 'color:' + K.muted + ';background:transparent;border:1px solid transparent;border-radius:8px;padding:5px 6px;font-size:12px',
    bubble: BUTTON_BASE + 'position:relative;color:' + K.text + ';background:' + K.surface + ';border:0;border-radius:50%;width:48px;height:48px;padding:0;box-shadow:0 8px 20px rgba(0,0,0,.45),0 0 0 1px ' + K.line,
  };
  // The look of a button under the pointer; a pressed tab keeps its own look
  const HOVERS = {
    quiet: { background: K.text, color: '#000', borderColor: K.text },
    primary: { background: '#fff', color: '#000', borderColor: '#fff' },
    icon: { background: '#4a464e' },
    tab: { background: K.line, color: K.text },
    bubble: {},
  };
  const ROOT_BASE = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;display:block;box-sizing:border-box;color:' + K.text + ';font:13px/1.45 ' + FONT + ';';
  const CARD = 'background:' + K.surface + ';border-radius:16px;box-shadow:0 12px 28px rgba(0,0,0,.45),0 0 0 1px ' + K.line + ';padding:12px 14px;';
  const TOP_STYLE = ROOT_BASE + CARD + 'width:max-content;min-width:290px;max-width:calc(100vw - 24px)';
  const BUBBLE_ROOT = ROOT_BASE + 'width:max-content';
  const FRAME_STYLE = ROOT_BASE + CARD + 'width:max-content;max-width:calc(100vw - 24px);display:none';
  const FLOAT = 'position:fixed;box-sizing:border-box;background:' + K.surface + ';color:' + K.text + ';font:13px/1.45 ' + FONT + ';box-shadow:0 12px 28px rgba(0,0,0,.45),0 0 0 1px ' + K.line + ';';
  const PHASES = ['1 \u00b7 Record the steps', '2 \u00b7 Choose the result', '3 \u00b7 Save the tool'];
  const ICON_PATHS = {
    click: 'm5 3 14 7-6 2-2 6z',
    type: 'M4 7V5h16v2M12 5v14M9 19h6',
    min: 'M5 12h14',
    target: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM12 2v3M12 19v3M2 12h3M19 12h3',
    check: 'm5 12.5 4.5 4.5L19 7.5',
    text: 'M4 6h16M4 12h16M4 18h10',
    table: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 10h18M9 4v16',
    list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
    fields: 'M4 5h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 14h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z',
    json: 'M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3',
    attribute: 'm8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14',
    select: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  };

  let root = null;
  let ui = {};
  let panelState = { steps: 0, last: [], collapsed: false, ending: false, studio: false, kiroHomeExists: false };
  let saving = false;
  let sheetOpen = false;
  let sheetSummarySeq = 0;
  let drawerOpen = false;
  let editOpen = false;
  let fileNoticeUntil = 0;
  let rootLook = '';
  let lastMark = null;
  let markTrail = [];
  let markCursor = 0;
  let markAdjusted = false;
  let markEl = null;
  let inspectHighlight = false;
  let inspectTimer = null;
  let offerKey = null;
  let offerMode = 'none';
  let resultKey = null;
  let noticeTimer = null;

  // A page can style any tag (p, ul, strong...): the base values come first, the given style overrides them
  function uiEl(tag, text, style, action) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    el.style.cssText = 'margin:0;padding:0;font:inherit;color:inherit;' + (style || '');
    if (action) el.setAttribute('data-daemonize-action', action);
    return el;
  }

  function uiIcon(name, size) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'width:' + size + 'px;height:' + size + 'px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.click);
    svg.appendChild(path);
    return svg;
  }

  // The red dot breathes unless the person asked for less motion (the Web Animations API needs no stylesheet, which a CSP may refuse)
  function pulse(dot) {
    try {
      if (typeof dot.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      dot.animate([{ boxShadow: '0 0 0 0 rgba(249,67,88,.5)' }, { boxShadow: '0 0 0 6px rgba(249,67,88,0)' }], { duration: 1600, iterations: Infinity });
    } catch (e) {
      // No animation is fine
    }
  }

  function uiButton(text, action, onClick, kind, icon) {
    const look = kind || 'quiet';
    const button = uiEl('button', '', BUTTONS[look], action);
    button.type = 'button';
    if (icon) button.appendChild(uiIcon(icon, 14));
    if (text) button.appendChild(document.createTextNode(text));
    button.addEventListener('click', onClick);
    const hover = HOVERS[look];
    let rest = null;
    button.addEventListener('mouseenter', () => {
      if (button.disabled || button.getAttribute('aria-pressed') === 'true' || rest !== null) return;
      rest = {};
      Object.keys(hover).forEach((property) => { rest[property] = button.style[property]; button.style[property] = hover[property]; });
    });
    button.addEventListener('mouseleave', () => {
      if (rest === null) return;
      Object.keys(rest).forEach((property) => { button.style[property] = rest[property]; });
      rest = null;
    });
    // The page may remove every outline: the focus ring is drawn inline, for the keyboard only
    button.addEventListener('focus', () => {
      if (button.matches(':focus-visible')) {
        button.style.outline = '2px solid ' + K.violetSoft;
        button.style.outlineOffset = '2px';
      }
    });
    button.addEventListener('blur', () => { button.style.outline = 'none'; });
    return button;
  }

  function uiPill(text, tone) {
    const colors = { violet: [K.violetDeep, K.violetText], green: ['#0f2f23', K.green], plain: [K.line, K.muted] }[tone || 'plain'];
    return uiEl('span', text, 'display:inline-block;font:500 11px/1.6 ' + FONT + ';padding:0 8px;border-radius:999px;white-space:nowrap;background:' + colors[0] + ';color:' + colors[1]);
  }

  function buildRoot() {
    const el = uiEl('div', '', IS_TOP ? TOP_STYLE : FRAME_STYLE);
    el.setAttribute(UI_ATTR, '');
    ui = {};
    if (IS_TOP) {
      el.setAttribute('data-daemonize-panel', '');
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', 'Daemonize recorder');
      ui.header = uiEl('div', '', 'display:flex;align-items:center;gap:8px');
      ui.dot = uiEl('span', '', 'width:10px;height:10px;border-radius:50%;background:' + K.red + ';flex:none');
      pulse(ui.dot);
      ui.title = uiEl('strong', 'Recording', 'flex:1;font-weight:600;font-size:14px');
      ui.count = uiEl('span', '', 'color:' + K.muted);
      ui.toggle = uiButton('', 'toggle-panel', togglePanel, 'icon', 'min');
      ui.header.append(ui.dot, ui.title, ui.count, ui.toggle);
      // The three times of a recording: steps, result, save
      ui.bars = [0, 1, 2].map(() => uiEl('span', '', 'flex:1;height:4px;border-radius:2px;background:' + K.tray));
      ui.progress = uiEl('div', '', 'display:flex;gap:6px;margin-top:10px');
      ui.progress.setAttribute('aria-hidden', 'true');
      ui.progress.append(...ui.bars);
      ui.phase = uiEl('p', '', 'margin-top:6px;font-size:12px;color:' + K.muted);
      el.append(ui.header, ui.progress, ui.phase);
      // Collapsed: a round bubble with the red dot and the number of steps
      ui.bubbleCount = uiEl('span', '', 'position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;background:' + K.violet + ';color:#fff;font:600 11px/18px ' + FONT + ';text-align:center;padding:0 4px;box-sizing:border-box');
      ui.bubble = uiButton('', 'expand-panel', togglePanel, 'bubble');
      const bubbleDot = uiEl('span', '', 'width:10px;height:10px;border-radius:50%;background:' + K.red);
      pulse(bubbleDot);
      ui.bubble.append(bubbleDot, ui.bubbleCount);
      ui.bubble.style.display = 'none';
      el.appendChild(ui.bubble);
      // While the person picks the result: a slim single-row bar at the top, an interactive outline and live preview
      ui.banner = uiEl('div', '', FLOAT + 'top:8px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 24px);display:none;align-items:center;gap:6px;white-space:nowrap;border-radius:12px;padding:4px 8px 4px 10px', 'mark-banner');
      ui.banner.setAttribute('role', 'status');
      const bannerText = uiEl('span', 'Click the element that holds the result', 'font-weight:500;font-size:12px');
      ui.bannerWider = uiButton('\u2191', 'mark-wider', () => stepMarkDepth(1), 'icon');
      ui.bannerWider.setAttribute('aria-label', 'Expand to parent');
      ui.bannerWider.title = 'Expand to parent container (ArrowUp)';
      ui.bannerNarrower = uiButton('\u2193', 'mark-narrower', () => stepMarkDepth(-1), 'icon');
      ui.bannerNarrower.setAttribute('aria-label', 'Shrink to child');
      ui.bannerNarrower.title = 'Shrink to child element (ArrowDown)';
      ui.bannerPick = uiButton('Pick', 'mark-confirm', confirmHoveredMark, 'primary');
      ui.bannerPick.style.width = 'auto';
      ui.bannerPick.style.padding = '3px 9px';
      ui.bannerPick.style.fontSize = '12px';
      ui.bannerPick.title = 'Use highlighted zone (Enter)';
      const esc = uiEl('span', 'Esc', 'font:500 11px/1.4 ui-monospace,Consolas,monospace;background:' + K.line + ';border-radius:4px;padding:0 5px;color:' + K.text);
      const cancelBtn = uiButton('Cancel', 'cancel-mark-result', cancelMarkResult, 'quiet');
      cancelBtn.style.padding = '3px 9px';
      cancelBtn.style.fontSize = '12px';
      const target = uiIcon('target', 15);
      target.style.color = K.violetSoft;
      ui.banner.append(target, bannerText, ui.bannerWider, ui.bannerNarrower, ui.bannerPick, esc, cancelBtn);
      ui.hl = uiEl('div', '', 'position:fixed;box-sizing:border-box;display:none;pointer-events:none;border:2px solid ' + K.violet + ';border-radius:4px;background:rgba(145,71,255,.12);transition:left .08s ease-out,top .08s ease-out,width .08s ease-out,height .08s ease-out');
      ui.hlItems = uiEl('div', '', 'position:fixed;inset:0;display:none;pointer-events:none');
      ui.tip = uiEl('div', '', FLOAT + 'display:none;pointer-events:none;border-radius:10px;padding:6px 10px;font-size:12px;max-width:340px;min-width:170px');
      ui.tipHead = uiEl('div', '', 'font-weight:600;color:' + K.text + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
      ui.tipBody = uiEl('div', '', 'margin-top:2px;font-size:11px;color:' + K.muted + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
      ui.tipHint = uiEl('div', 'Click to select \u00b7 \u2191\u2193 resize \u00b7 Esc cancel', 'margin-top:3px;font-size:10px;color:' + K.violetSoft);
      ui.tip.append(ui.tipHead, ui.tipBody, ui.tipHint);
      el.append(ui.banner, ui.hl, ui.hlItems, ui.tip);
    }
    ui.body = uiEl('div', '', IS_TOP ? 'display:block;margin-top:10px' : 'display:block');
    if (IS_TOP) {
      ui.last = uiEl('ul', '', 'list-style:none;display:none;flex-direction:column;gap:2px;margin-bottom:10px', 'last-steps');
      ui.body.appendChild(ui.last);
    }
    ui.offer = uiEl('div', '', 'display:none;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px');
    ui.body.appendChild(ui.offer);
    if (IS_TOP) {
      ui.result = uiEl('div', '', 'display:flex;flex-direction:column;gap:8px;margin-bottom:10px');
      ui.finish = uiButton('Finish and save', 'finish', finishPressed, 'primary');
      ui.sheet = uiEl('div', '', 'display:none;flex-direction:column;gap:10px', 'finish-sheet');
      // The field list opened from the end sheet: the fields of the session, and the form of the one being edited
      ui.drawer = uiEl('div', '', 'display:none;flex-direction:column;gap:8px;margin-top:10px;max-height:40vh;overflow:auto;border-top:1px solid ' + K.line + ';padding-top:10px', 'field-drawer');
      ui.drawer.setAttribute('role', 'region');
      ui.drawer.setAttribute('aria-label', 'Review fields');
      ui.drawerList = uiEl('ul', '', 'list-style:none;display:flex;flex-direction:column;gap:6px');
      ui.drawerForm = uiEl('div', '', 'display:block');
      const drawerHead = uiEl('div', '', 'display:flex;align-items:center;gap:8px');
      drawerHead.append(uiEl('strong', 'Review fields', 'flex:1;font-weight:600;font-size:14px'), uiButton('Close', 'close-drawer', closeDrawer, 'quiet'));
      ui.drawer.append(drawerHead, ui.drawerList, ui.drawerForm);
      ui.drawer.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !editOpen) {
          e.preventDefault();
          closeDrawer();
        }
      });
      ui.body.append(ui.result, ui.finish, ui.sheet, ui.drawer);
    }
    ui.status = uiEl('p', '', 'margin-top:8px;display:none;color:' + K.muted);
    ui.status.setAttribute('role', 'status');
    ui.status.setAttribute('aria-live', 'polite');
    ui.body.appendChild(ui.status);
    el.appendChild(ui.body);
    return el;
  }

  // A document that was rewritten (document.open) loses the listeners of the panel: a detached root is built again
  function ensurePanel() {
    if (!document.documentElement) return;
    if (root && root.parentNode !== document.documentElement) {
      root = null;
      offerKey = null;
      resultKey = null;
      if (offerMode === 'naming') offerMode = 'none';
    }
    if (!root) {
      if (!IS_TOP) return;
      root = buildRoot();
      document.documentElement.appendChild(root);
      renderPanel();
      refreshState();
      return;
    }
  }

  // A sub-frame shows its root only while it has something to show
  function ensureFrameRoot() {
    if (IS_TOP) {
      ensurePanel();
      return;
    }
    if (!document.documentElement) return;
    if (root && root.parentNode !== document.documentElement) {
      root = null;
      offerKey = null;
    }
    if (!root) {
      root = buildRoot();
      document.documentElement.appendChild(root);
    }
  }

  function showOrHideFrameRoot() {
    if (IS_TOP || !root) return;
    root.style.display = offerMode !== 'none' || ui.status.textContent !== '' ? 'block' : 'none';
  }

  const FILE_NOTICE = 'File upload is not supported yet. This field is not recorded as an input.';

  function setStatus(text, keep, important) {
    ensureFrameRoot();
    if (!root) return;
    // The notice about a file field stays at least 5 seconds: only a message that must be seen replaces it
    if (!important && !keep && performance.now() < fileNoticeUntil && ui.status.textContent === FILE_NOTICE) return;
    clearTimeout(noticeTimer);
    ui.status.textContent = text;
    ui.status.style.display = text ? 'block' : 'none';
    if (text && !keep) {
      noticeTimer = setTimeout(() => setStatus(''), NOTICE_LIFETIME_MS);
    }
    showOrHideFrameRoot();
  }

  // The first step of a recording that is not done: 0 record, 1 choose the result, 2 save
  function phaseNow() {
    if (sheetOpen) return 2;
    if (markingResult || lastMark !== null || panelState.zone) return 1;
    return 0;
  }

  function stepIcon(label) {
    const word = String(label).split(' ')[0];
    return word === 'type' ? 'type' : word === 'select' ? 'select' : word === 'check' ? 'check' : 'click';
  }

  function renderPanel() {
    if (!root || !IS_TOP) return;
    const stateKnown = hasPanelBinding();
    const collapsed = panelState.collapsed;
    const look = collapsed ? 'bubble' : 'card';
    if (look !== rootLook) {
      rootLook = look;
      root.style.cssText = collapsed ? BUBBLE_ROOT : TOP_STYLE;
    }
    const countText = stateKnown ? panelState.steps + (panelState.steps === 1 ? ' step' : ' steps') : '';
    ui.count.textContent = countText;
    ui.bubbleCount.textContent = stateKnown ? String(panelState.steps) : '';
    ui.bubble.setAttribute('aria-label', 'Expand the recorder panel' + (countText ? ' (' + countText + ')' : ''));
    ui.header.style.display = collapsed ? 'none' : 'flex';
    ui.progress.style.display = collapsed ? 'none' : 'flex';
    ui.phase.style.display = collapsed ? 'none' : 'block';
    ui.bubble.style.display = collapsed ? 'inline-flex' : 'none';
    const phase = phaseNow();
    ui.bars.forEach((bar, index) => { bar.style.background = index <= phase ? K.violet : K.tray; });
    ui.phase.textContent = PHASES[phase];
    ui.last.textContent = '';
    panelState.last.forEach((label, index) => {
      const now = index === panelState.last.length - 1;
      const chip = uiEl('span', '', 'display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;flex:none;background:' + (now ? K.violet : K.line) + ';color:' + (now ? '#fff' : K.violetSoft));
      chip.appendChild(uiIcon(stepIcon(label), 13));
      const row = uiEl('li', '', 'display:flex;align-items:center;gap:9px;padding:4px 6px;border-radius:8px;min-width:0;' + (now ? 'background:' + K.raised : ''));
      row.append(chip, uiEl('span', label, 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px'));
      ui.last.appendChild(row);
    });
    ui.last.style.display = panelState.last.length > 0 && !sheetOpen ? 'flex' : 'none';
    ui.body.style.display = collapsed ? 'none' : 'block';
    ui.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    ui.toggle.setAttribute('aria-label', 'Collapse the recorder panel');
    // Without the finish binding (a page recorded by other means) the button and the counter are not offered
    ui.finish.style.display = hasFinishBinding() && !sheetOpen ? 'inline-flex' : 'none';
    ui.result.style.display = sheetOpen ? 'none' : 'flex';
    ui.sheet.style.display = sheetOpen ? 'flex' : 'none';
    ui.drawer.style.display = sheetOpen && drawerOpen ? 'flex' : 'none';
    if (panelState.ending && !saving) {
      saving = true;
      setStatus('Saving\u2026', true);
    }
    ui.finish.disabled = saving;
    ui.finish.style.opacity = saving ? '.6' : '1';
    Array.from(ui.sheet.querySelectorAll('button')).forEach((button) => {
      button.disabled = saving;
      button.style.opacity = saving ? '.6' : '1';
    });
    renderResult();
    renderOffer();
    // The offer to name a variable is for the recording, not for the end sheet
    ui.offer.style.display = sheetOpen || offerMode === 'none' ? 'none' : 'flex';
  }

  async function refreshState() {
    if (!IS_TOP || !hasPanelBinding()) return;
    try {
      const state = await window.__daemonizePanel({ type: 'state' });
      if (state && typeof state.steps === 'number') {
        panelState = state;
        renderPanel();
      }
    } catch (e) {
      // The page is going away
    }
  }

  function togglePanel() {
    panelState.collapsed = !panelState.collapsed;
    renderPanel();
    if (hasPanelBinding()) Promise.resolve(window.__daemonizePanel({ type: 'collapse', collapsed: panelState.collapsed })).catch(() => {});
  }

  // Record promises not settled yet: "Finish and save" waits for them
  const outstanding = new Set();
  function track(pending) {
    const settled = Promise.resolve(pending).catch(() => {});
    outstanding.add(settled);
    settled.then(() => {
      outstanding.delete(settled);
      refreshState();
    });
    return pending;
  }

  // With a Studio, the end of the recording is a sheet that says what the tool is and what happens next
  function finishPressed() {
    if (saving) return;
    if (panelState.studio) openSheet();
    else finishWith('save');
  }

  function renderSheetFacts(summary) {
    if (!ui.sheetFacts) return;
    const kind = lastMark ? lastMark.kind : panelState.zone ? panelState.zone.kind : '';
    ui.sheetFacts.textContent = '';
    const steps = summary && typeof summary.steps === 'number' ? summary.steps : panelState.steps;
    ui.sheetFacts.appendChild(uiPill(steps + (steps === 1 ? ' step' : ' steps')));
    const names = summary && Array.isArray(summary.variables) ? summary.variables : [];
    if (names.length > 0) ui.sheetFacts.appendChild(uiPill(names.length === 1 ? 'Variable: ' + names[0] : names.length + ' variables', 'violet'));
    if (kind) ui.sheetFacts.appendChild(uiPill('Result: ' + kind, 'green'));
    else ui.sheetFacts.appendChild(uiPill('Result: full page'));
  }

  async function refreshSheetSummary() {
    if (!sheetOpen || !ui.sheetFacts || !hasPanelBinding()) return;
    const seq = ++sheetSummarySeq;
    try {
      const summary = await window.__daemonizePanel({ type: 'summary' });
      if (seq === sheetSummarySeq && sheetOpen && ui.sheetFacts && summary) {
        renderSheetFacts(summary);
      }
    } catch (e) {
      // The page is going away
    }
  }

  async function openSheet() {
    const seq = ++sheetSummarySeq;
    let summary = null;
    try {
      summary = await window.__daemonizePanel({ type: 'summary' });
    } catch (e) {
      // The page is going away
    }
    if (seq !== sheetSummarySeq) return;
    const kind = lastMark ? lastMark.kind : panelState.zone ? panelState.zone.kind : '';
    ui.sheet.textContent = '';
    const head = uiEl('div', '', 'display:flex;align-items:center;gap:8px');
    const done = uiIcon('check', 16);
    done.style.color = K.green;
    head.append(done, uiEl('strong', 'Your tool is ready', 'font-weight:600;font-size:14px'));
    ui.sheetFacts = uiEl('div', '', 'display:flex;flex-wrap:wrap;gap:6px', 'sheet-facts');
    renderSheetFacts(summary);
    ui.sheet.append(head, ui.sheetFacts);
    if (summary && summary.secrets > 0) {
      ui.sheet.appendChild(uiEl('p', summary.secrets === 1 ? '1 secret is kept out of the tool.' : summary.secrets + ' secrets are kept out of the tool.', 'font-size:12px;color:' + K.muted));
    }
    if (summary && typeof summary.files === 'number' && summary.files >= 1) {
      const files = summary.files === 1 ? '1 file field was' : summary.files + ' file fields were';
      ui.sheet.appendChild(uiEl('p', files + ' not recorded: file upload is not supported yet.', 'font-size:12px;color:' + K.muted, 'file-count'));
    }
    if (!kind) {
      const note = uiEl('p', 'Captures the whole page text by default. ', 'font-size:12px;color:' + K.muted);
      note.appendChild(uiButton('Pick specific area', 'sheet-choose', () => { closeSheet(); startMarkResult(); }, 'quiet'));
      ui.sheet.appendChild(note);
    } else {
      const note = uiEl('p', 'Capturing ' + kind + ' zone. ', 'font-size:12px;color:' + K.muted + ';display:flex;align-items:center;gap:6px;flex-wrap:wrap');
      note.append(
        uiButton('Change', 'sheet-choose', () => { closeSheet(); startMarkResult(); }, 'quiet'),
        uiButton('Use full page', 'sheet-clear-result', () => clearMarkResult().then(() => { if (sheetOpen) openSheet(); }), 'quiet'),
      );
      ui.sheet.appendChild(note);
    }
    const row = uiEl('div', '', 'display:flex;gap:8px;flex-wrap:wrap');
    row.append(
      uiButton('Test first', 'finish-test', () => finishWith('test'), 'quiet'),
      uiButton('Save only', 'finish-save', () => finishWith('save'), 'quiet'),
      uiButton('Review fields', 'review-fields', openDrawer, 'quiet'),
      uiButton('Back', 'sheet-back', closeSheet, 'quiet'),
    );
    ui.sheet.append(scopeChoice(), uiButton('Save and add to Kiro', 'finish-kiro', () => finishWith('kiro'), 'primary', 'check'), row);
    sheetOpen = true;
    setStatus('');
    renderPanel();
    const first = ui.sheet.querySelector('[data-daemonize-action=finish-kiro]');
    if (first) first.focus();
  }

  // Where the tool is added to Kiro: a choice when the Kiro folder exists, otherwise only this project
  function scopeChoice() {
    if (!panelState.kiroHomeExists) {
      return uiEl('p', 'Only this project', 'color:' + K.muted, 'scope-static');
    }
    const group = uiEl('div', '', 'display:flex;flex-direction:column;gap:6px', 'scope');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Where to add the tool');
    const name = 'daemonize-scope-' + Math.random().toString(36).slice(2, 8);
    [['global', 'All my projects'], ['project', 'Only this project']].forEach((choice, index) => {
      const label = uiEl('label', '', 'display:flex;align-items:center;gap:8px;cursor:pointer');
      const radio = uiEl('input', '', CHECK_STYLE, 'scope-' + choice[0]);
      radio.type = 'radio';
      radio.name = name;
      radio.value = choice[0];
      radio.checked = index === 0;
      ring(radio);
      label.append(radio, document.createTextNode(choice[1]));
      group.appendChild(label);
    });
    return group;
  }

  function chosenScope() {
    if (!panelState.kiroHomeExists) return 'project';
    const picked = ui.sheet.querySelector('[data-daemonize-action^=scope-]:checked');
    return picked && picked.value === 'global' ? 'global' : 'project';
  }

  function closeSheet() {
    sheetOpen = false;
    drawerOpen = false;
    editOpen = false;
    ++sheetSummarySeq;
    ui.sheetFacts = null;
    ui.sheet.textContent = '';
    renderPanel();
    ui.finish.focus();
  }

  async function finishWith(intent) {
    if (saving) return;
    if (blockedByEdit()) return;
    saving = true;
    ui.finish.disabled = true;
    setStatus('Saving\u2026', true);
    renderPanel();
    try {
      flushLive();
      await Promise.all(Array.from(outstanding));
      // The scope goes only with "add to Kiro"
      const result = await window.__daemonizeFinish(intent === 'kiro' ? { intent, scope: chosenScope() } : { intent });
      if (!result || !result.ok) throw new Error((result && result.error) || 'Could not finish the recording');
      renderPanel();
    } catch (e) {
      saving = false;
      ui.finish.disabled = false;
      setStatus((e && e.message) || 'Could not finish the recording', false);
      renderPanel();
    }
  }

  // ---------------------------------------------------------------- the offer ("Make variable")

  const MAX_EARLIER = 100;

  // The offer is the last typed or selected field of the current route; the offers before it stay in the earlier list
  // (at most 100, one per field, newest last) so the field list can still reach them. Pure: it is also exposed for tests.
  function createOfferModel(initialRoute) {
    let offer = null;
    let route = initialRoute;
    let earlier = [];
    const forget = (fieldId) => { earlier = earlier.filter((o) => o.fieldId !== fieldId); };
    const remember = (previous) => {
      // A text selected in a row is not a field of a step
      if (previous === null || previous.rowText !== undefined) return;
      forget(previous.fieldId);
      earlier.push(previous);
      if (earlier.length > MAX_EARLIER) earlier.shift();
    };
    return {
      apply(e) {
        if (e.t === 'typed' || e.t === 'row') {
          if (e.route === route) {
            if (offer !== null && offer.fieldId !== e.fieldId) remember(offer);
            offer = { fieldId: e.fieldId, stepIndex: e.stepIndex, suggestion: e.suggestion, label: e.label, route: e.route, rowText: e.rowText, kind: e.kind };
            forget(offer.fieldId);
          }
        } else if (e.t === 'input') {
          // Typing in another field: the offer of the previous one is kept for the field list, and stays offered
          if (offer !== null && offer.fieldId !== e.fieldId) remember(offer);
        } else if (e.t === 'route') {
          offer = null;
          route = e.route;
        } else if (e.t === 'clear') {
          offer = null;
          if (typeof e.stepIndex === 'number') earlier = earlier.filter((o) => o.stepIndex !== e.stepIndex);
        }
        return offer;
      },
      get offer() { return offer; },
      get earlier() { return earlier.slice(); },
      get route() { return route; },
    };
  }

  const model = createOfferModel(location.pathname);
  const fieldIds = new WeakMap();
  let fieldCount = 0;
  function fieldIdOf(el) {
    if (!fieldIds.has(el)) fieldIds.set(el, 'f' + ++fieldCount);
    return fieldIds.get(el);
  }

  function offerKeyOf(offer) {
    return offer ? [offer.fieldId, offer.stepIndex, offer.rowText === undefined ? '' : offer.rowText].join('|') : null;
  }

  function renderOffer() {
    if (!root) return;
    const offer = model.offer;
    const key = offerKeyOf(offer);
    if (key === offerKey && (offerMode !== 'none' || key === null)) return;
    offerKey = key;
    ui.offer.textContent = '';
    if (!offer) {
      offerMode = 'none';
      ui.offer.style.display = 'none';
      showOrHideFrameRoot();
      return;
    }
    offerMode = 'offer';
    ui.offer.style.display = 'flex';
    const label = offer.rowText !== undefined ? 'Selected: ' + offer.rowText : 'Field: ' + offer.label;
    const text = uiEl('span', label, 'color:' + K.muted + ';max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
    text.title = label;
    ui.offer.append(uiButton('Make variable', 'make-variable', () => askName(offer), 'quiet'), text);
    showOrHideFrameRoot();
  }

  function setOffer(event) {
    ensureFrameRoot();
    model.apply(event);
    renderOffer();
  }

  // ---- the settings of a variable: what the form sends

  const TYPE_CHOICES = [['string', 'text'], ['number', 'number'], ['boolean', 'true or false']];
  const OMITTED_CHOICES = [['skip', 'If left empty: skip this field'], ['useRecorded', 'If left empty: use the recorded value']];
  const FIELD_STYLE = 'all:initial;box-sizing:border-box;font:13px/1.3 ' + FONT + ';color:' + K.text + ';background:' + K.neutral + ';border:1px solid ' + K.line + ';border-radius:10px;padding:6px 10px;margin:0;color-scheme:dark;';
  const CHECK_STYLE = 'appearance:auto;box-sizing:border-box;width:16px;height:16px;flex:none;cursor:pointer;accent-color:' + K.violet + ';';

  // "Make variable" request: type always, optional and whenOmitted only for an optional variable. Pure.
  function variableRequest(offer, values) {
    const request = { stepIndex: offer.stepIndex, name: values.name };
    if (offer.rowText !== undefined) request.rowText = offer.rowText;
    request.type = values.type;
    if (values.optional) {
      request.optional = true;
      request.whenOmitted = values.whenOmitted;
    }
    return request;
  }

  // Edit request: only the settings the person changed, or null when nothing changed. Pure.
  function editRequest(current, values) {
    const request = { name: current.name };
    if (values.name !== current.name) request.newName = values.name;
    if (values.type !== undefined && values.type !== current.type) request.type = values.type;
    if (values.optional !== current.optional) request.optional = values.optional;
    if (values.optional && (!current.optional || values.whenOmitted !== (current.whenOmitted || 'useRecorded'))) {
      request.whenOmitted = values.whenOmitted;
    }
    return Object.keys(request).length > 1 ? request : null;
  }

  // Every control of the panel draws its own focus ring, for the keyboard only (the page may remove every outline)
  function ring(el) {
    el.addEventListener('focus', () => {
      if (el.matches(':focus-visible')) {
        el.style.outline = '2px solid ' + K.violetSoft;
        el.style.outlineOffset = '2px';
      }
    });
    el.addEventListener('blur', () => { el.style.outline = 'none'; });
    return el;
  }

  function uiChoice(action, label, choices, selected) {
    const select = uiEl('select', '', FIELD_STYLE + 'cursor:pointer', action);
    select.setAttribute('aria-label', label);
    choices.forEach((choice) => {
      const option = document.createElement('option');
      option.value = choice[0];
      option.textContent = choice[1];
      select.appendChild(option);
    });
    select.value = selected;
    return ring(select);
  }

  // The form of "Make variable" (current is null) and of an edit (current is { name, type, optional, whenOmitted }).
  // handlers.send(values) answers { ok, error }, handlers.done(values) and handlers.cancel() end the form.
  function variableForm(offer, current, handlers) {
    const kind = offer.kind || 'text';
    const form = uiEl('div', '', 'display:flex;flex-direction:column;gap:8px;align-items:flex-start', 'variable-form');
    form.setAttribute('role', 'group');
    form.setAttribute('aria-label', current ? 'Edit variable' : 'Make variable');

    const input = uiEl('input', '', 'all:initial;font:13px/1.3 ' + FONT + ';color:' + K.text + ';background:' + K.neutral + ';border:1px solid ' + K.line + ';border-radius:10px;padding:6px 10px;margin:0;box-sizing:border-box;width:max(220px,' + (offer.suggestion.length + 4) + 'ch);max-width:min(360px,60vw)', 'variable-name');
    input.type = 'text';
    input.value = current ? current.name : offer.suggestion;
    input.title = input.value;
    input.setAttribute('aria-label', 'Variable name');
    ring(input);
    const message = uiEl('span', '', 'flex-basis:100%;color:' + K.red);
    message.setAttribute('role', 'alert');
    const nameRow = uiEl('div', '', 'display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;max-width:100%');
    nameRow.append(input, message);

    // A checkbox is always true or false, a radio group is always text, a text selected in a row is always text
    let typeBox = null;
    if (kind !== 'radio') {
      const choices = kind === 'check' ? TYPE_CHOICES.slice(2) : offer.rowText !== undefined ? TYPE_CHOICES.slice(0, 1) : TYPE_CHOICES;
      typeBox = uiChoice('variable-type', 'Type', choices, current ? current.type : kind === 'check' ? 'boolean' : 'string');
    }

    const optionalLabel = uiEl('label', '', 'display:flex;align-items:center;gap:6px;cursor:pointer');
    const optional = uiEl('input', '', CHECK_STYLE, 'variable-optional');
    optional.type = 'checkbox';
    optional.checked = !!(current && current.optional);
    optional.setAttribute('aria-label', 'Optional');
    ring(optional);
    optionalLabel.append(optional, document.createTextNode('Optional'));

    const omitted = uiChoice('variable-omitted', 'If left empty', OMITTED_CHOICES, current ? current.whenOmitted || 'useRecorded' : 'skip');
    const showOmitted = () => { omitted.style.display = optional.checked ? 'block' : 'none'; };
    optional.addEventListener('change', showOmitted);
    showOmitted();

    const buttons = uiEl('div', '', 'display:flex;gap:8px;align-items:center');
    const ok = uiButton('OK', 'confirm-variable', confirm, 'primary');
    ok.style.width = 'auto';
    buttons.append(ok, uiButton('Cancel', 'cancel-variable', () => handlers.cancel(), 'quiet'));
    form.append(nameRow);
    if (typeBox) form.appendChild(typeBox);
    form.append(optionalLabel, omitted, buttons);

    let busy = false;
    function values() {
      return {
        name: input.value.trim(),
        type: kind === 'radio' ? 'string' : typeBox.value,
        optional: optional.checked,
        whenOmitted: omitted.value,
      };
    }

    async function confirm() {
      if (busy) return;
      busy = true;
      try {
        const answer = await handlers.send(values());
        if (answer && answer.ok) {
          handlers.done(values());
        } else {
          message.textContent = (answer && answer.error) || 'Could not save the variable';
          input.setAttribute('aria-invalid', 'true');
        }
      } catch (e) {
        message.textContent = 'Could not save the variable';
      } finally {
        busy = false;
      }
    }

    // Enter confirms from any field; on a button it keeps its usual meaning
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        confirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handlers.cancel();
      }
    });
    return { el: form, input };
  }

  function askName(offer) {
    offerMode = 'naming';
    ui.offer.textContent = '';
    const form = variableForm(offer, null, {
      send: (values) => window.__daemonizeMarkVariable(variableRequest(offer, values)),
      done: (values) => {
        setOffer({ t: 'clear', stepIndex: offer.stepIndex });
        setStatus('Variable "' + values.name + '" saved', false);
      },
      cancel: () => {
        offerMode = 'none';
        offerKey = null;
        renderOffer();
      },
    });
    ui.offer.appendChild(form.el);
    form.input.focus();
    form.input.select();
  }

  // ---------------------------------------------------------------- the field list (Review fields)

  function suggestionFor(field) {
    const known = model.earlier.concat(model.offer ? [model.offer] : []).find((o) => o.stepIndex === field.stepIndex);
    if (known) return known.suggestion;
    const words = String(field.label || '').split(' ');
    return toSnake(words.length > 1 ? words.slice(1).join(' ') : words[0]);
  }

  function closeFieldForm() {
    editOpen = false;
    ui.drawerForm.textContent = '';
  }

  function showFieldForm(field) {
    closeFieldForm();
    editOpen = true;
    const offer = { stepIndex: field.stepIndex, suggestion: field.variable ? field.variable.name : suggestionFor(field), label: field.label, kind: field.kind };
    const form = variableForm(offer, field.variable || null, {
      send: (values) => {
        if (!field.variable) return window.__daemonizeMarkVariable(variableRequest(offer, values));
        const request = editRequest(field.variable, values);
        return request === null ? { ok: true } : window.__daemonizeEditVariable(request);
      },
      done: (values) => {
        if (!field.variable) setOffer({ t: 'clear', stepIndex: field.stepIndex });
        closeFieldForm();
        setStatus('Variable "' + values.name + '" saved', false);
        refreshDrawer();
        refreshSheetSummary();
      },
      cancel: () => {
        closeFieldForm();
        const first = ui.drawerList.querySelector('button');
        if (first) first.focus();
      },
    });
    ui.drawerForm.appendChild(form.el);
    form.input.focus();
    form.input.select();
  }

  async function refreshDrawer() {
    let answer = null;
    try {
      answer = await window.__daemonizePanel({ type: 'fields' });
    } catch (e) {
      // The page is going away
    }
    const fields = answer && Array.isArray(answer.fields) ? answer.fields : [];
    ui.drawerList.textContent = '';
    if (fields.length === 0) {
      ui.drawerList.appendChild(uiEl('p', 'No field to review yet.', 'color:' + K.muted));
      return;
    }
    fields.forEach((field) => {
      const row = uiEl('li', '', 'display:flex;align-items:center;gap:8px;min-width:0');
      const button = uiButton(String(field.label || field.kind), 'review-field', () => showFieldForm(field), 'quiet');
      button.style.maxWidth = '240px';
      button.style.overflow = 'hidden';
      button.style.textOverflow = 'ellipsis';
      button.style.whiteSpace = 'nowrap';
      button.setAttribute('aria-label', (field.variable ? 'Edit variable ' + field.variable.name + ': ' : 'Make variable: ') + String(field.label || field.kind));
      row.appendChild(button);
      row.appendChild(field.variable ? uiPill(field.variable.name + (field.variable.optional ? ' (optional)' : ''), 'violet') : uiPill('no variable'));
      ui.drawerList.appendChild(row);
    });
  }

  async function openDrawer() {
    drawerOpen = true;
    closeFieldForm();
    await refreshDrawer();
    renderPanel();
    const first = ui.drawerList.querySelector('button') || ui.drawer.querySelector('[data-daemonize-action=close-drawer]');
    if (first) first.focus();
  }

  function closeDrawer() {
    drawerOpen = false;
    closeFieldForm();
    renderPanel();
    refreshSheetSummary();
    const again = ui.sheet.querySelector('[data-daemonize-action=review-fields]');
    if (again) again.focus();
  }

  // A variable edit that is open and not confirmed holds the end of the recording back
  function blockedByEdit() {
    if (!drawerOpen || !editOpen) return false;
    setStatus('Confirm or cancel the open variable edit first.', false);
    const open = ui.drawerForm.querySelector('input');
    if (open) open.focus();
    return true;
  }

  // ---------------------------------------------------------------- result zone (panel part)

  function miniButton(text, action, onClick) {
    const btn = uiButton(text, action, onClick, 'quiet');
    btn.style.padding = '2px 8px';
    btn.style.fontSize = '11px';
    btn.style.borderRadius = '8px';
    return btn;
  }

  function syncBannerControls() {
    if (!IS_TOP || !ui.bannerWider) return;
    const hasEl = !!(markEl && markEl.isConnected);
    const canWider = hasEl && markCursor < markTrail.length - 1;
    const canNarrower = hasEl && markCursor > 0;
    [ui.bannerWider, ui.pickWider].forEach((b) => { if (b) { b.disabled = !canWider; b.style.opacity = b.disabled ? '.45' : '1'; } });
    [ui.bannerNarrower, ui.pickNarrower].forEach((b) => { if (b) { b.disabled = !canNarrower; b.style.opacity = b.disabled ? '.45' : '1'; } });
    [ui.bannerPick, ui.pickConfirm].forEach((b) => { if (b) { b.disabled = !hasEl; b.style.opacity = b.disabled ? '.45' : '1'; } });
    if (!hasEl && ui.pickInfo) {
      ui.pickInfo.textContent = 'Hover any block on the page';
    }
  }

  let panelInspectHover = false;

  function renderResult() {
    if (!root || !IS_TOP) return;
    const kind = lastMark ? lastMark.kind : panelState.zone ? panelState.zone.kind : '';
    const connected = lastMark && lastMark.el && lastMark.el.isConnected ? 1 : 0;
    const key = [markingResult, kind, lastMark !== null, lastMark ? lastMark.cursor : -1, connected, lastMark && lastMark.fragile ? 1 : 0].join('|');
    if (key === resultKey) return;
    resultKey = key;
    const activeAction = ui.result.contains(document.activeElement) && document.activeElement
      ? document.activeElement.getAttribute('data-daemonize-action')
      : null;
    ui.result.textContent = '';
    ui.banner.style.display = markingResult ? 'flex' : 'none';
    if (markingResult) {
      const pickBox = uiEl('div', '', 'display:flex;flex-direction:column;gap:6px;max-width:300px', 'mark-panel-box');
      ui.pickInfo = uiEl('span', 'Hover any block on the page', 'font:500 12px/1.4 ' + FONT + ';color:' + K.text + ';background:' + K.raised + ';border:1px solid ' + K.line + ';border-radius:8px;padding:5px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', 'mark-info');
      const controls = uiEl('div', '', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap');
      ui.pickWider = miniButton('\u2191 Wider', 'panel-mark-wider', () => stepMarkDepth(1));
      ui.pickNarrower = miniButton('\u2193 Narrower', 'panel-mark-narrower', () => stepMarkDepth(-1));
      ui.pickConfirm = miniButton('Pick this', 'panel-mark-confirm', confirmHoveredMark);
      controls.append(ui.pickWider, ui.pickNarrower, ui.pickConfirm);
      pickBox.append(ui.pickInfo, controls, uiEl('span', 'Click a block on the page, or press \u2191\u2193 / Enter / Esc.', 'font-size:11px;color:' + K.muted));
      ui.result.appendChild(pickBox);
      syncBannerControls();
      return;
    }
    if (lastMark) {
      const card = uiEl('div', '', 'display:flex;flex-direction:column;gap:8px;max-width:320px', 'result-card');
      const liveEl = lastMark.el && lastMark.el.isConnected ? lastMark.el : null;
      const head = uiEl('div', '', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap');
      const title = uiEl('span', 'Result zone' + (liveEl ? ' \u00b7 ' + elLabel(liveEl) : ''), 'font-size:12px;color:' + K.muted + ';flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
      head.appendChild(title);
      if (liveEl) {
        const wider = miniButton('\u2191 Wider', 'result-wider', () => adjustLastMark(1));
        wider.disabled = lastMark.cursor >= lastMark.trail.length - 1;
        wider.style.opacity = wider.disabled ? '.45' : '1';
        const narrower = miniButton('\u2193 Narrower', 'result-narrower', () => adjustLastMark(-1));
        narrower.disabled = lastMark.cursor <= 0;
        narrower.style.opacity = narrower.disabled ? '.45' : '1';
        head.append(wider, narrower);
      }
      head.appendChild(miniButton('Clear', 'clear-result', clearMarkResult));
      card.appendChild(head);

      const tabs = uiEl('div', '', 'display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:' + K.tray + ';padding:4px;border-radius:12px', 'result-kind');
      tabs.setAttribute('role', 'group');
      tabs.setAttribute('aria-label', 'Result zone');
      RESULT_KINDS.forEach((k) => {
        const tab = uiButton(k, 'result-kind-' + k, async () => {
          lastMark.kind = k;
          resultKey = null;
          zoneTarget = lastMark.el;
          const tabResult = await window.__daemonizeMarkResult({ info: lastMark.info, kind: lastMark.kind, zone: lastMark.el && lastMark.el.isConnected ? zoneFactsOf(lastMark.el) : undefined });
          if (lastMark && tabResult && tabResult.ok) lastMark.fragile = tabResult.fragile === true;
          if (lastMark && lastMark.el && lastMark.el.isConnected) flashHighlight(lastMark.el, lastMark.kind);
          refreshState();
          renderPanel();
        }, 'tab', k);
        const pressed = lastMark.kind === k;
        tab.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        if (pressed) {
          tab.style.background = K.neutral;
          tab.style.color = K.text;
        }
        tabs.appendChild(tab);
      });
      card.appendChild(tabs);

      if (liveEl) {
        const analysis = analyzeZone(liveEl, lastMark.kind);
        const box = uiEl('div', '', 'background:' + K.raised + ';border:1px solid ' + (analysis.ok ? K.line : K.red) + ';border-radius:10px;padding:7px 9px;display:flex;flex-direction:column;gap:4px', 'result-preview');
        const badgeRow = uiEl('div', '', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap');
        badgeRow.appendChild(uiPill(analysis.badge, analysis.ok ? 'green' : 'plain'));
        badgeRow.appendChild(uiEl('span', analysis.ok ? 'Live preview' : 'Mismatch', 'font-size:11px;color:' + (analysis.ok ? K.muted : K.text)));
        box.appendChild(badgeRow);
        if (lastMark.fragile === true) {
          box.appendChild(uiEl('div', '${ZONE_COPY.fragile}', 'font-size:11px;line-height:1.4;color:' + K.muted + ';white-space:normal', 'result-fragile'));
        }
        if (analysis.lines.length > 0) {
          const linesEl = uiEl('div', analysis.lines.join('\\n'), 'font-size:11px;line-height:1.4;color:' + K.text + ';white-space:pre-wrap;word-break:break-word;max-height:76px;overflow:auto');
          box.appendChild(linesEl);
        }
        card.appendChild(box);
      }

      card.addEventListener('mouseenter', () => {
        panelInspectHover = true;
        clearTimeout(inspectTimer);
        if (!markingResult && lastMark && lastMark.el && lastMark.el.isConnected) {
          inspectHighlight = true;
          paintHighlight(lastMark.el, lastMark.kind, false);
        }
      });
      card.addEventListener('mouseleave', () => {
        panelInspectHover = false;
        if (!markingResult) {
          inspectHighlight = false;
          hideHover();
        }
      });
      ui.result.appendChild(card);
    } else if (kind) {
      const row = uiEl('div', '', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap');
      row.append(uiEl('span', 'Result zone: ' + kind, 'color:' + K.muted), miniButton('Clear', 'clear-result', clearMarkResult));
      ui.result.appendChild(row);
    }
    ui.result.appendChild(uiButton(kind ? 'Choose another result' : 'Choose the result to capture', 'mark-result', startMarkResult, 'quiet', 'target'));
    if (!kind) {
      ui.result.appendChild(uiEl('span', 'Optional \u2014 captures the whole page if skipped.', 'font-size:11px;color:' + K.muted));
    }
    if (activeAction !== null) {
      const again = ui.result.querySelector('[data-daemonize-action="' + activeAction + '"]') || ui.result.querySelector('[aria-pressed=true]') || ui.result.querySelector('button');
      if (again) again.focus();
    }
  }

  function startMarkResult() {
    markingResult = true;
    inspectHighlight = false;
    panelInspectHover = false;
    clearTimeout(inspectTimer);
    markTrail = [];
    markCursor = 0;
    markAdjusted = false;
    markEl = null;
    sheetOpen = false;
    resultKey = null;
    ensureFrameRoot();
    hideHover();
    renderPanel();
    syncBannerControls();
    setStatus('Click the element that holds the result (Esc to cancel)', true);
  }

  function hideHover() {
    if (!IS_TOP || !ui.hl) return;
    ui.hl.style.display = 'none';
    if (ui.hlItems) {
      ui.hlItems.style.display = 'none';
      ui.hlItems.textContent = '';
    }
    ui.tip.style.display = 'none';
  }

  function cancelMarkResult() {
    markingResult = false;
    inspectHighlight = false;
    markEl = null;
    markAdjusted = false;
    hideHover();
    resultKey = null;
    renderPanel();
    setStatus('');
  }

  function paintHighlight(el, kind, showTip) {
    if (!IS_TOP || !ui.hl || !(el instanceof Element) || !el.isConnected) return;
    const rect = el.getBoundingClientRect();
    ui.hl.style.left = rect.left + 'px';
    ui.hl.style.top = rect.top + 'px';
    ui.hl.style.width = rect.width + 'px';
    ui.hl.style.height = rect.height + 'px';
    ui.hl.style.display = 'block';

    const analysis = analyzeZone(el, kind);
    if (ui.hlItems) {
      ui.hlItems.textContent = '';
      if (analysis.rects.length > 0) {
        analysis.rects.forEach((r) => {
          if (r.width <= 0 || r.height <= 0) return;
          const itemBox = uiEl('div', '', 'position:fixed;box-sizing:border-box;pointer-events:none;border:1px dashed ' + K.violetSoft + ';border-radius:3px;background:rgba(197,158,255,.07)');
          itemBox.style.left = r.left + 'px';
          itemBox.style.top = r.top + 'px';
          itemBox.style.width = r.width + 'px';
          itemBox.style.height = r.height + 'px';
          ui.hlItems.appendChild(itemBox);
        });
        ui.hlItems.style.display = 'block';
      } else {
        ui.hlItems.style.display = 'none';
      }
    }

    if (ui.pickInfo && markingResult) {
      ui.pickInfo.textContent = elLabel(el) + ' \u00b7 ' + kind + ' \u00b7 ' + analysis.badge;
    }

    if (showTip) {
      ui.tipHead.textContent = elLabel(el) + ' \u00b7 ' + kind + ' \u00b7 ' + analysis.badge;
      ui.tipBody.textContent = analysis.lines[0] || '';
      ui.tipBody.style.display = ui.tipBody.textContent ? 'block' : 'none';
      ui.tip.style.display = 'block';
      const tipW = Math.min(340, ui.tip.offsetWidth || 240);
      const tipH = ui.tip.offsetHeight || 56;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - tipW - 8));
      let top = rect.top > tipH + 12 ? rect.top - tipH - 6 : rect.bottom + 8;
      if (top + tipH > window.innerHeight - 8) top = Math.max(64, Math.min(rect.top + 8, window.innerHeight - tipH - 8));
      ui.tip.style.left = left + 'px';
      ui.tip.style.top = top + 'px';
    } else {
      ui.tip.style.display = 'none';
    }
  }

  function flashHighlight(el, kind) {
    if (markingResult || !el || !el.isConnected) return;
    clearTimeout(inspectTimer);
    inspectHighlight = true;
    paintHighlight(el, kind, false);
    inspectTimer = setTimeout(() => {
      if (!markingResult && !panelInspectHover) {
        inspectHighlight = false;
        hideHover();
      }
    }, 1100);
  }

  function stepMarkDepth(delta) {
    if (!markingResult || markTrail.length === 0) return;
    const next = Math.max(0, Math.min(markTrail.length - 1, markCursor + delta));
    if (next === markCursor) return;
    markCursor = next;
    markAdjusted = true;
    markEl = markTrail[markCursor];
    paintHighlight(markEl, suggestResultKind(markEl), true);
    syncBannerControls();
  }

  function confirmHoveredMark() {
    if (!markingResult || !markEl || !markEl.isConnected) return;
    finishMarkResult(markEl, true);
  }

  async function adjustLastMark(delta) {
    if (!lastMark || !lastMark.trail || lastMark.trail.length === 0) return;
    const next = Math.max(0, Math.min(lastMark.trail.length - 1, lastMark.cursor + delta));
    if (next === lastMark.cursor) return;
    const el = lastMark.trail[next];
    if (!el || !el.isConnected) return;
    const info = resultInfoOf(el);
    const kind = suggestResultKind(el);
    zoneTarget = el;
    const result = await window.__daemonizeMarkResult({ info, kind, zone: zoneFactsOf(el) });
    if (!result || !result.ok) {
      setStatus((result && result.error) || 'Could not update the result zone', false);
      return;
    }
    lastMark = { el, info, kind, trail: lastMark.trail, cursor: next, fragile: result.fragile === true };
    resultKey = null;
    renderPanel();
    flashHighlight(el, kind);
    setStatus('Result zone: ' + elLabel(el) + ' (' + kind + ')', false);
    refreshState();
  }

  async function clearMarkResult() {
    clearTimeout(inspectTimer);
    inspectHighlight = false;
    panelInspectHover = false;
    hideHover();
    if (hasPanelBinding()) {
      try { await window.__daemonizePanel({ type: 'clearZone' }); } catch (e) {}
    }
    lastMark = null;
    if (panelState) panelState.zone = undefined;
    resultKey = null;
    renderPanel();
    setStatus('Result set to full page', false);
    refreshState();
  }

  function syncActiveHighlight() {
    if (markingResult && markEl && markEl.isConnected) {
      paintHighlight(markEl, suggestResultKind(markEl), true);
    } else if (!markingResult && inspectHighlight && lastMark && lastMark.el && lastMark.el.isConnected) {
      paintHighlight(lastMark.el, lastMark.kind, false);
    }
  }

  window.addEventListener('scroll', syncActiveHighlight, true);
  window.addEventListener('resize', syncActiveHighlight);

  // The element that would be chosen under the pointer, outlined, with the kind the tool would return
  function showHover(target) {
    if (!IS_TOP || !ui.hl) return;
    const built = buildMarkTrail(target);
    markTrail = built.trail;
    markCursor = built.cursor;
    markAdjusted = false;
    markEl = markTrail[markCursor];
    paintHighlight(markEl, suggestResultKind(markEl), true);
    syncBannerControls();
  }

  document.addEventListener('mousemove', (e) => {
    if (!markingResult || !e.isTrusted || inUi(e.target)) return;
    if (markAdjusted && markEl && markEl.isConnected && markEl.contains(e.target)) return;
    showHover(e.target);
  }, true);

  async function finishMarkResult(target, exactElement) {
    markingResult = false;
    inspectHighlight = false;
    panelInspectHover = false;
    hideHover();
    const built = buildMarkTrail(target);
    let cursor = built.cursor;
    if (exactElement) {
      const idx = built.trail.indexOf(target);
      if (idx >= 0) cursor = idx;
    }
    const el = built.trail[cursor] || resultZoneElement(target);
    const info = resultInfoOf(el);
    const kind = suggestResultKind(el);
    zoneTarget = el;
    const result = await window.__daemonizeMarkResult({ info, kind, zone: zoneFactsOf(el) });
    markTrail = [];
    markEl = null;
    markAdjusted = false;
    resultKey = null;
    if (!result || !result.ok) {
      renderPanel();
      setStatus((result && result.error) || 'Could not set the result zone', false);
      return;
    }
    lastMark = { el, info, kind, trail: built.trail, cursor, fragile: result.fragile === true };
    renderPanel();
    flashHighlight(el, kind);
    setStatus('Result zone set (' + kind + ')', false);
    refreshState();
  }

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (markingResult) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelMarkResult();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        stepMarkDepth(1);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        stepMarkDepth(-1);
        return;
      }
      if (e.key === 'Enter' && markEl && markEl.isConnected && !inUi(e.target)) {
        e.preventDefault();
        confirmHoveredMark();
        return;
      }
    }
    if (e.altKey && e.shiftKey && e.code === 'KeyR') {
      startMarkResult();
    }
  }, true);

  // Position of the element in the viewport of the top page, when every frame up to it can be walked
  function viewportBox(el) {
    try {
      const r = el.getBoundingClientRect();
      let x = r.x;
      let y = r.y;
      let win = window;
      while (win !== win.top) {
        const holder = win.frameElement;
        if (!holder) return undefined;
        const h = holder.getBoundingClientRect();
        x += h.x + holder.clientLeft;
        y += h.y + holder.clientTop;
        win = win.parent;
      }
      return { x, y, width: r.width, height: r.height };
    } catch (e) {
      return undefined;
    }
  }
  // The last event sent to the recorder: a field typed again with nothing in between updates its step
  let lastEmit = null;
  let lastInputEl = null;
  let typedSeq = 0;

  function emit(actionType, el, value, extra) {
    // Text typed and not recorded yet comes before whatever the user does next
    if (actionType !== 'type') flushLive();
    const context = parentContext(el);
    const info = infoOf(el, context);
    const { anchor, frameComplete } = anchorOf(el, info, context);
    const name = info.name || info.nameAttr || info.id || el.tagName.toLowerCase();
    const event = { actionType, info, anchor, frameComplete, label: actionType + ' ' + name };
    const box = viewportBox(el);
    if (box) event.box = box;
    if (context && context.rowBinding) {
      event.rowBinding = context.rowBinding;
      event.rowTexts = context.rowTexts;
    }

    const secret = secretKind(el);
    if (secret && (actionType === 'type' || actionType === 'select')) {
      // The value of a secret field is never captured
      event.secretRef = secret;
    } else if (value !== undefined) {
      event.value = value;
    }
    if (extra) Object.assign(event, extra);
    if (actionType === 'type' && lastEmit && lastEmit.el === el && lastEmit.type === 'type') {
      // Same field, nothing sent in between: the recorder updates that step (by index when this page already knows it)
      if (typeof lastEmit.index === 'number') event.replaces = lastEmit.index;
      else event.continues = true;
    }

    const pending = track(window.__daemonizeRecord(event));
    const entry = { el, type: actionType, index: undefined };
    lastEmit = entry;
    Promise.resolve(pending).then((index) => { if (typeof index === 'number') entry.index = index; }).catch(() => {});
    hoverTrail = [];
    baselineScroll = { x: window.scrollX, y: window.scrollY };
    refreshBaseline();
    scheduleBaseline();
    // A typed or selected field, a checkbox or a switch, and a radio of a group can become a variable
    const offerKind =
      actionType === 'type' ? 'text' : actionType === 'select' ? 'choice' : actionType === 'check' ? 'check' : extra && extra.radio ? 'radio' : '';
    if (offerKind && !event.secretRef) {
      // Only the latest field is offered: a result that comes back after the user moved on is ignored
      const route = location.pathname;
      const seq = ++typedSeq;
      if (offerKind === 'text' || offerKind === 'choice') lastInputEl = el;
      const label = (extra && extra.radioGroup) || info.name || info.nameAttr || info.id || 'value';
      Promise.resolve(pending)
        .then((index) => {
          if (typeof index !== 'number' || seq !== typedSeq) return;
          setOffer({ t: 'typed', fieldId: fieldIdOf(el), stepIndex: index, suggestion: toSnake(label), label, route, kind: offerKind });
        })
        .catch(() => {});
    }
  }

  const CANVAS_CLICK_HALF = 12;
  function emitCanvasClick(canvas, e) {
    const full = viewportBox(canvas);
    if (!full) return;
    const r = canvas.getBoundingClientRect();
    const box = {
      x: full.x + (e.clientX - r.x) - CANVAS_CLICK_HALF,
      y: full.y + (e.clientY - r.y) - CANVAS_CLICK_HALF,
      width: CANVAS_CLICK_HALF * 2,
      height: CANVAS_CLICK_HALF * 2,
    };
    emit('click', canvas, undefined, { box, canvas: true });
  }

  // The value a select box has when the page is loaded
  function defaultSelectValue(el) {
    const chosen = Array.from(el.options).find((o) => o.defaultSelected);
    return chosen ? chosen.value : el.options.length > 0 ? el.options[0].value : '';
  }

  function isTextField(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image'].includes(typeOf(el));
  }

  function valueToRecord(el) {
    return secretKind(el) ? '' : el.value;
  }

  // The text field being typed in, flushed LIVE_FLUSH_MS after its last input event
  let liveField = null;
  let liveTimer = null;

  function flushLive() {
    clearTimeout(liveTimer);
    const el = liveField;
    liveField = null;
    if (el && el.isConnected) flush(el);
  }

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!e.isTrusted || !(el instanceof Element) || inUi(el) || !isTextField(el)) return;
    if (el !== lastInputEl) {
      // Another field: the previous one is recorded now, and its offer no longer applies
      flushLive();
      lastInputEl = el;
      typedSeq++;
    }
    if (model.offer !== null) setOffer({ t: 'input', fieldId: fieldIdOf(el) });
    liveField = el;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(flushLive, LIVE_FLUSH_MS);
  }, true);

  window.addEventListener('pagehide', flushLive, true);

  // Record the typed value when the field is quiet for a moment, left, or Enter is pressed.
  function flush(el) {
    if (!isTextField(el)) return;
    if (liveField === el) {
      clearTimeout(liveTimer);
      liveField = null;
    }
    if (lastValues.get(el) === el.value) return;
    lastValues.set(el, el.value);
    emit('type', el, valueToRecord(el));
  }

  function editableText(el) {
    return (el.innerText !== undefined ? el.innerText : el.textContent) || '';
  }

  function flushEditable(el) {
    if (lastValues.get(el) === editableText(el)) return;
    lastValues.set(el, editableText(el));
    emit('type', el, editableText(el));
  }

  // ---------------------------------------------------------------- preparatory hover and scroll

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  const HOVER_CANDIDATES = 'a[href], button, [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=tab], summary';
  const MAX_TRAIL = 8;
  const MAX_HOVER_CLIMB = 5;
  const BASELINE_DELAY_MS = 120;

  // Hovering reveals a menu before any script of the page can observe the
  // hidden state, so the hidden candidates are remembered at each recorded
  // event (and after the page loaded): what was hidden then and is visible when
  // the next click happens was revealed by something in between, typically a hover.
  let baselineHidden = new WeakSet();
  let baselineTimer = null;
  let hoverTrail = [];

  function refreshBaseline() {
    const hidden = new WeakSet();
    let count = 0;
    for (const candidate of document.querySelectorAll(HOVER_CANDIDATES)) {
      if (++count > MAX_HOVER_CANDIDATES) break;
      if (!isVisible(candidate)) hidden.add(candidate);
    }
    baselineHidden = hidden;
  }

  function scheduleBaseline() {
    clearTimeout(baselineTimer);
    // A hover since then may have revealed content: keep the state seen before it
    baselineTimer = setTimeout(() => { if (hoverTrail.length === 0) refreshBaseline(); }, BASELINE_DELAY_MS);
  }

  function hoverTrigger(start) {
    if (!(start instanceof Element)) return null;
    return start.closest('[aria-haspopup], [aria-expanded], a, button, [role]');
  }

  document.addEventListener('mouseover', (e) => {
    if (!e.isTrusted || inUi(e.target)) return;
    const trigger = hoverTrigger(e.target);
    if (!trigger || (hoverTrail.length > 0 && hoverTrail[hoverTrail.length - 1].trigger === trigger)) return;
    hoverTrail.push({ trigger, at: performance.now() });
    if (hoverTrail.length > MAX_TRAIL) hoverTrail.shift();
  }, true);

  document.addEventListener('DOMContentLoaded', scheduleBaseline);
  window.addEventListener('load', scheduleBaseline);
  scheduleBaseline();

  // The element hovered to reveal the target: the earliest recent hover near it
  function hoverFor(target) {
    if (!baselineHidden.has(target) || !isVisible(target)) return null;
    const now = performance.now();
    let ancestor = target.parentElement;
    for (let i = 0; i < MAX_HOVER_CLIMB && ancestor && ancestor !== document.body && ancestor !== document.documentElement; i++) {
      const scope = ancestor;
      const entry = hoverTrail.find((en) =>
        now - en.at < HOVER_WINDOW_MS && en.trigger.isConnected && en.trigger !== target &&
        !target.contains(en.trigger) && scope.contains(en.trigger) && !baselineHidden.has(en.trigger));
      if (entry) return entry.trigger;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  // Scrolling happens just before the click and its scroll event only fires
  // after it, so the position is compared with the one at the previous event.
  let baselineScroll = { x: window.scrollX, y: window.scrollY };

  // Hover and scroll steps are recorded only when the click needed them
  function prepareClick(target) {
    const trigger = hoverFor(target);
    let scrollTarget = false;
    const dx = window.scrollX - baselineScroll.x;
    const dy = window.scrollY - baselineScroll.y;
    if (dx !== 0 || dy !== 0) {
      const rect = target.getBoundingClientRect();
      const wasOutside =
        rect.bottom + dy < 0 || rect.top + dy > window.innerHeight ||
        rect.right + dx < 0 || rect.left + dx > window.innerWidth;
      scrollTarget = wasOutside;
    }
    if (trigger) emit('hover', trigger);
    if (scrollTarget) emit('scrollIntoView', target);
  }
  // ---------------------------------------------------------------- checkboxes, switches, radios and file fields

  function explicitRole(el) {
    return (el.getAttribute('role') || '').trim().split(/\\s+/)[0].toLowerCase();
  }

  function isCheckControl(el) {
    if (el.tagName === 'INPUT') return typeOf(el) === 'checkbox';
    const role = explicitRole(el);
    return role === 'checkbox' || role === 'switch';
  }

  // "true" or "false" from the state after the click; aria-checked false, mixed or absent is "false"
  function checkValueOf(el) {
    if (el.tagName === 'INPUT') return el.checked ? 'true' : 'false';
    return el.getAttribute('aria-checked') === 'true' ? 'true' : 'false';
  }

  function isRadioControl(el) {
    return el.tagName === 'INPUT' ? typeOf(el) === 'radio' : explicitRole(el) === 'radio';
  }

  function isDisabledControl(el) {
    return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  }

  // A group: radios with the same name in the same form (or the same document), or the radios of a radiogroup
  function radioGroupOf(el) {
    if (el.tagName === 'INPUT') {
      const name = el.getAttribute('name') || '';
      if (!name) return [el];
      const scope = el.getRootNode().querySelectorAll ? el.getRootNode() : document;
      return Array.from(scope.querySelectorAll('input[type=radio]')).filter((r) => r.form === el.form && (r.getAttribute('name') || '') === name);
    }
    const group = el.closest('[role=radiogroup]');
    return group ? Array.from(group.querySelectorAll('[role=radio]')) : [el];
  }

  // Names are the accessible names, cut at 201 characters so that the recorder can tell one that is too long
  function radioName(el) {
    return collapse(computeName(el, { recursion: false })).slice(0, 201);
  }

  function radioInfoOf(el) {
    const group = radioGroupOf(el);
    const names = group.filter((r) => !isDisabledControl(r)).map(radioName);
    return { names: names.slice(0, 52), total: group.length, clicked: radioName(el), clickedDisabled: isDisabledControl(el) };
  }

  function radioGroupLabel(el) {
    const group = el.closest('[role=radiogroup], fieldset');
    if (group) {
      const name = accessibleNameOf(group) || headingOf(group);
      if (name) return name;
    }
    return clean(el.getAttribute('name'));
  }

  const fileFieldIds = new WeakMap();
  let fileFieldCount = 0;

  // Only a counter signal leaves the page: no name, path, size, type or content of the file
  function noteFileField(el) {
    if (!fileFieldIds.has(el)) fileFieldIds.set(el, 'file-' + Math.random().toString(36).slice(2, 8) + '-' + ++fileFieldCount);
    fileNoticeUntil = performance.now() + 5000;
    setStatus(FILE_NOTICE, false, true);
    if (hasPanelBinding()) Promise.resolve(window.__daemonizePanel({ type: 'file', fieldId: fileFieldIds.get(el) })).catch(() => {});
  }

  // ---------------------------------------------------------------- events

  // Pressing Enter in a field makes the browser click the form's submit button
  // itself; that click is already covered by the recorded Enter press.
  let enterPressedAt = 0;

  document.addEventListener('click', (e) => {
    if (!e.isTrusted || inUi(e.target)) return;
    if (markingResult) {
      // The click chooses the result zone; the page must not act on it and no step is recorded
      e.preventDefault();
      e.stopPropagation();
      const kept = markAdjusted && markEl && markEl.isConnected && markEl.contains(e.target) ? markEl : null;
      finishMarkResult(kept || e.target, kept !== null);
      return;
    }
    if (e.detail === 0 && performance.now() - enterPressedAt < 100) return;
    // A canvas draws its own controls: nothing inside it can be found again by role or selector, so only
    // the point that was clicked is recorded (a small box around it, which becomes the Visual_Anchor rectangle)
    if (e.target instanceof HTMLCanvasElement && !e.target.closest(CLICKABLE)) {
      emitCanvasClick(e.target, e);
      return;
    }
    const target = clickTarget(e.target);
    if (!target) return;
    prepareClick(target);
    // A checkbox or a switch is recorded with the state it has after the click
    if (isCheckControl(target)) {
      if (target.tagName === 'INPUT') emit('check', target, checkValueOf(target));
      // A custom control updates aria-checked in its own handler: read it once that handler has run
      else setTimeout(() => emit('check', target, checkValueOf(target)), 0);
      return;
    }
    const submits =
      ((target.tagName === 'BUTTON' && target.type === 'submit') ||
        (target.tagName === 'INPUT' && ['submit', 'image'].includes(typeOf(target)))) && !!target.form;
    let extra = submits ? { submit: true } : undefined;
    if (isRadioControl(target)) {
      // A radio inside a row, a card or a list item keeps its row binding and is not offered as a choice
      const context = parentContext(target);
      if (!context || !context.rowBinding) {
        const radioGroup = radioGroupLabel(target);
        extra = Object.assign({}, extra, { radio: radioInfoOf(target) }, radioGroup ? { radioGroup } : undefined);
      }
    }
    emit('click', target, undefined, extra);
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof Element) || inUi(el)) return;
    // A file field cannot be turned into a variable: say so, and tell the recorder only that one was chosen
    if (el.tagName === 'INPUT' && typeOf(el) === 'file') {
      noteFileField(el);
    }
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof Element) || inUi(el)) return;
    // A script of the page firing its own change event while the document is still being parsed (Adminer does it on
    // its login form) is not something the user did; one fired later (a driven browser) still is
    if (!e.isTrusted && document.readyState === 'loading') return;
    if (el.tagName === 'SELECT') {
      // A change event fired by a script without any change of the value (Adminer re-fires them on its filter rows) is no choice
      const shown = lastValues.has(el) ? lastValues.get(el) : defaultSelectValue(el);
      lastValues.set(el, el.value);
      if (!e.isTrusted && el.value === shown) return;
      emit('select', el, el.value);
    } else {
      flush(el);
    }
  }, true);

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el instanceof Element && el.isContentEditable && isEditableHost(el) && !lastValues.has(el)) {
      lastValues.set(el, editableText(el));
    }
  }, true);

  document.addEventListener('focusout', (e) => {
    const el = e.target;
    if (!e.isTrusted || !(el instanceof Element) || inUi(el)) return;
    if (el.isContentEditable && isEditableHost(el)) flushEditable(el);
  }, true);

  // Selecting a text of a table row, card or list item offers to make it a variable: the row is then replayed by that value
  let selectionTimer = null;
  let lastSelected = '';
  document.addEventListener('selectionchange', () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(offerRowVariable, SELECTION_SETTLE_MS);
  });

  function offerRowVariable() {
    const selection = window.getSelection();
    const selected = collapse(String(selection || ''));
    if (!selected || selected === lastSelected || selected.length > MAX_KEY_LENGTH || !selection.anchorNode) return;
    const start = selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
    if (!(start instanceof Element) || inUi(start) || start.closest(CLICKABLE)) return;
    const row = start.closest(ROW_SELECTOR);
    if (!row || !rowInfo(row)) return;
    lastSelected = selected;
    const owner = start.closest(CELL_SELECTOR);
    const pos = owner && owner.parentElement ? Array.from(owner.parentElement.children).indexOf(owner) : -1;
    const header = pos >= 0 ? row.closest('table, [role=table], [role=grid]') : null;
    const headRow = header ? header.querySelector('tr:has(th), [role=row]:has([role=columnheader])') : null;
    const headCell = headRow ? Array.from(headRow.children)[pos] : null;
    const suggestion = toSnake(headCell ? collapse(headCell.textContent) : 'row_key');
    setOffer({ t: 'row', fieldId: 'row:' + selected, stepIndex: -1, suggestion, label: suggestion, route: location.pathname, rowText: selected });
  }

  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!e.isTrusted || e.key !== 'Enter' || !(el instanceof Element) || inUi(el)) return;
    if (el.tagName !== 'INPUT' || !isTextField(el)) return;
    flush(el);
    emit('keypress', el, 'Enter', el.form ? { inForm: true } : undefined);
    enterPressedAt = performance.now();
  }, true);

  // ---------------------------------------------------------------- route changes and mounting

  // A route is the pathname: a live search that only changes ?q= keeps the offer
  function onRouteMaybeChanged() {
    const route = location.pathname;
    if (route !== model.route) setOffer({ t: 'route', route });
    ensurePanel();
    refreshState();
  }

  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    // Sees pushState, replaceState, back and forward without patching anything of the page
    window.navigation.addEventListener('currententrychange', onRouteMaybeChanged);
  } else {
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      history[name] = function () {
        const result = original.apply(this, arguments);
        onRouteMaybeChanged();
        return result;
      };
    }
  }
  window.addEventListener('popstate', onRouteMaybeChanged);
  window.addEventListener('hashchange', onRouteMaybeChanged);

  document.addEventListener('DOMContentLoaded', ensurePanel);
  window.addEventListener('load', ensurePanel);
  document.addEventListener('visibilitychange', () => { ensurePanel(); refreshState(); });
  // The document element is replaced by page.setContent and document.write; the panel is mounted again
  new MutationObserver(ensurePanel).observe(document, { childList: true });
  if (IS_TOP) setInterval(() => { ensurePanel(); refreshState(); }, STATE_POLL_MS);
  ensurePanel();

  window.__daemonizeHelpers = {
    offerModel: { create: createOfferModel },
    variableRequest,
    editRequest,
    checkValueOf,
    radioInfoOf,
    FILE_NOTICE,
    LIVE_FLUSH_MS,
    roleOf,
    accessibleName: accessibleNameOf,
    parentContext,
    framePath,
    secretKind,
    infoOf,
    startMarkResult,
    suggestResultKind,
    analyzeZone,
    zoneFactsOf,
    isZoneTarget: (el) => el === zoneTarget,
    buildMarkTrail,
    anchorOf: (el) => {
      const context = parentContext(el);
      return anchorOf(el, infoOf(el, context), context).anchor;
    },
  };
})();
`;
