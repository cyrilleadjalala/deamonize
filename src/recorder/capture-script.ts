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
export const CAPTURE_SCRIPT = `
(() => {
  if (window.__daemonizeInstalled) return;
  window.__daemonizeInstalled = true;

  const UI_ATTR = 'data-daemonize-ui';
  const MAX_POINTER_CLIMB = 6;
  const MAX_TEXT_SELECTOR_LENGTH = 60;
  const MAX_NAME_LENGTH = 80;
  const MAX_SUMMARY_LENGTH = 60;
  const CHIP_LIFETIME_MS = 15000;
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
      if (legend) return clean(legend.textContent);
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

    let section = up.closest('section, fieldset, [role=region], [role=group]');
    while (section) {
      const name = hasLabelAttribute(section) ? accessibleNameOf(section) : '';
      if (name) return { kind: 'region', name };
      const heading = headingOf(section);
      if (heading) return { kind: 'heading', name: heading };
      section = section.parentElement ? section.parentElement.closest('section, fieldset, [role=region], [role=group]') : null;
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

  let chip = null;

  function removeChip() {
    if (chip) {
      chip.remove();
      chip = null;
    }
  }

  // "Make variable" box shown after a typed or selected value is recorded.
  function showChip(stepIndex, suggestion, rowText) {
    removeChip();
    const box = document.createElement('div');
    box.setAttribute(UI_ATTR, '');
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#1f2937;color:#fff;font:13px system-ui,sans-serif;padding:8px 10px;border-radius:8px;display:flex;gap:8px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    chip = box;

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Make variable';
    button.setAttribute('data-daemonize-action', 'make-variable');
    button.addEventListener('click', () => askName(box, stepIndex, suggestion, rowText));
    box.appendChild(button);

    // The same box offers to mark the element that holds the result of the workflow
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.textContent = 'Mark result';
    mark.setAttribute('data-daemonize-action', 'mark-result');
    mark.addEventListener('click', () => startMarkResult());
    box.appendChild(mark);

    document.documentElement.appendChild(box);
    setTimeout(() => {
      if (chip === box && !box.contains(document.activeElement) && !markingResult) removeChip();
    }, CHIP_LIFETIME_MS);
  }

  // ---------------------------------------------------------------- result zone

  const RESULT_KINDS = ['text', 'table', 'list', 'fields', 'json', 'attribute'];
  const RESULT_CONTAINERS = 'table, [role=table], [role=grid], ul, ol, [role=list], dl, pre, code, input, select, textarea';
  let markingResult = false;

  // The element holding a result: the table, list, definition list, pre or field around the click
  function resultZoneElement(target) {
    if (!(target instanceof Element)) return document.body;
    return target.closest(RESULT_CONTAINERS) || target;
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
    // A position in the parent (:nth-of-type) breaks when a sibling appears: a class that is unique in the page is steadier
    if (info.css && info.css.indexOf(':nth-of-type') >= 0) {
      const cls = Array.from(el.classList).find((c) => /^[a-z][a-z-]{2,30}$/.test(c));
      const candidate = cls ? el.tagName.toLowerCase() + '.' + cls : '';
      if (candidate && document.querySelectorAll(candidate).length === 1) info.css = candidate;
    }
    return info;
  }

  function showNotice(text, keep) {
    removeChip();
    const box = document.createElement('div');
    box.setAttribute(UI_ATTR, '');
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#1f2937;color:#fff;font:13px system-ui,sans-serif;padding:8px 10px;border-radius:8px;display:flex;gap:8px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    box.appendChild(document.createTextNode(text));
    chip = box;
    document.documentElement.appendChild(box);
    if (!keep) setTimeout(() => { if (chip === box) removeChip(); }, CHIP_LIFETIME_MS);
    return box;
  }

  function startMarkResult() {
    markingResult = true;
    showNotice('Click the element that holds the result (Esc to cancel)', true);
  }

  function cancelMarkResult() {
    markingResult = false;
    removeChip();
  }

  async function finishMarkResult(target) {
    markingResult = false;
    const el = resultZoneElement(target);
    const info = resultInfoOf(el);
    let kind = suggestResultKind(el);
    const send = async () => window.__daemonizeMarkResult({ info, kind });
    const result = await send();
    if (!result || !result.ok) {
      showNotice((result && result.error) || 'Could not set the result zone', false);
      return;
    }
    const box = showNotice('Result zone set as', true);
    const select = document.createElement('select');
    select.setAttribute('data-daemonize-action', 'result-kind');
    RESULT_KINDS.forEach((k) => {
      const option = document.createElement('option');
      option.value = k;
      option.textContent = k;
      select.appendChild(option);
    });
    select.value = kind;
    select.addEventListener('change', async () => {
      kind = select.value;
      await send();
    });
    box.appendChild(select);
    setTimeout(() => { if (chip === box && !box.contains(document.activeElement)) removeChip(); }, CHIP_LIFETIME_MS);
  }

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (markingResult && e.key === 'Escape') {
      cancelMarkResult();
    } else if (e.altKey && e.shiftKey && e.code === 'KeyR') {
      startMarkResult();
    }
  }, true);

  function askName(box, stepIndex, suggestion, rowText) {
    box.textContent = '';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = suggestion;
    input.setAttribute('data-daemonize-action', 'variable-name');
    input.style.cssText = 'width:140px';

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = 'OK';
    ok.setAttribute('data-daemonize-action', 'confirm-variable');

    const message = document.createElement('span');

    async function confirm() {
      const request = { stepIndex, name: input.value.trim() };
      if (rowText !== undefined) request.rowText = rowText;
      const result = await window.__daemonizeMarkVariable(request);
      if (result && result.ok) {
        box.textContent = 'Variable "' + input.value.trim() + '" saved';
        setTimeout(() => { if (chip === box) removeChip(); }, 1500);
      } else {
        message.textContent = (result && result.error) || 'Could not save the variable';
      }
    }

    ok.addEventListener('click', confirm);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirm();
      }
    });

    box.append(input, ok, message);
    input.focus();
    input.select();
  }

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
  function emit(actionType, el, value, extra) {
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

    const pending = window.__daemonizeRecord(event);
    hoverTrail = [];
    baselineScroll = { x: window.scrollX, y: window.scrollY };
    refreshBaseline();
    scheduleBaseline();
    if ((actionType === 'type' || actionType === 'select') && !event.secretRef) {
      Promise.resolve(pending)
        .then((index) => {
          if (typeof index === 'number') showChip(index, toSnake(info.name || info.nameAttr || info.id || 'value'));
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

  // Record the typed value once, when the field is left or Enter is pressed.
  function flush(el) {
    if (!isTextField(el)) return;
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
      finishMarkResult(e.target);
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
    const submits =
      ((target.tagName === 'BUTTON' && target.type === 'submit') ||
        (target.tagName === 'INPUT' && ['submit', 'image'].includes(typeOf(target)))) && !!target.form;
    emit('click', target, undefined, submits ? { submit: true } : undefined);
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
    showChip(-1, toSnake(headCell ? collapse(headCell.textContent) : 'row_key'), selected);
  }

  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!e.isTrusted || e.key !== 'Enter' || !(el instanceof Element) || inUi(el)) return;
    if (el.tagName !== 'INPUT' || !isTextField(el)) return;
    flush(el);
    emit('keypress', el, 'Enter', el.form ? { inForm: true } : undefined);
    enterPressedAt = performance.now();
  }, true);

  window.__daemonizeHelpers = {
    roleOf,
    accessibleName: accessibleNameOf,
    parentContext,
    framePath,
    secretKind,
    infoOf,
    startMarkResult,
    suggestResultKind,
    anchorOf: (el) => {
      const context = parentContext(el);
      return anchorOf(el, infoOf(el, context), context).anchor;
    },
  };
})();
`;
