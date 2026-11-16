/**
 * Script injected in every page of a recording session. It turns the user's
 * clicks, typing, selections and Enter presses into events sent to
 * `window.__daemonizeRecord`, together with the information needed to build
 * robust selectors (role, accessible name, id, test id, name attribute, text,
 * CSS path).
 *
 * After a typed or selected value is recorded, a small "Make variable" box
 * appears in the page; the user names the variable there and the choice is
 * sent to `window.__daemonizeMarkVariable`.
 *
 * Plain JavaScript in a string on purpose: it is serialized into the page, and
 * a function compiled by a bundler could reference helpers that do not exist there.
 * Values of password fields are never captured.
 */
export const CAPTURE_SCRIPT = `
(() => {
  if (window.__daemonizeInstalled) return;
  window.__daemonizeInstalled = true;

  const UI_ATTR = 'data-daemonize-ui';
  const MAX_POINTER_CLIMB = 6;
  const MAX_TEXT_SELECTOR_LENGTH = 60;
  const CHIP_LIFETIME_MS = 15000;

  const lastValues = new WeakMap();
  const CLICKABLE = 'button, a[href], summary, input[type=button], input[type=submit], input[type=reset], input[type=checkbox], input[type=radio], [role=button], [role=link], [role=tab], [role=menuitem]';

  function inUi(target) {
    return target instanceof Element && target.closest('[' + UI_ATTR + ']') !== null;
  }

  function typeOf(el) {
    return (el.getAttribute('type') || 'text').toLowerCase();
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : undefined;
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = typeOf(el);
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'password' || t === 'hidden' || t === 'file') return undefined;
      return 'textbox';
    }
    return undefined;
  }

  function clean(text) {
    const value = (text || '').replace(/\\s+/g, ' ').trim();
    return value.length > 80 ? value.slice(0, 80) : value;
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy.split(' ')[0]);
      if (ref) return clean(ref.textContent);
    }
    if (el.labels && el.labels.length > 0) return clean(el.labels[0].textContent);
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(typeOf(el))) {
      return clean(el.value);
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return clean(el.getAttribute('placeholder') || el.getAttribute('title'));
    }
    return clean(el.textContent) || clean(el.getAttribute('title'));
  }

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

  function infoOf(el) {
    const role = roleOf(el);
    const name = nameOf(el);
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
    return info;
  }

  // The element the user meant to click: a standard control, or the outermost
  // element that behaves like one (onclick handler or pointer cursor).
  function clickTarget(start) {
    if (!(start instanceof Element)) return null;
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
  function showChip(stepIndex, suggestion) {
    removeChip();
    const box = document.createElement('div');
    box.setAttribute(UI_ATTR, '');
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#1f2937;color:#fff;font:13px system-ui,sans-serif;padding:8px 10px;border-radius:8px;display:flex;gap:8px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    chip = box;

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Make variable';
    button.setAttribute('data-daemonize-action', 'make-variable');
    button.addEventListener('click', () => askName(box, stepIndex, suggestion));
    box.appendChild(button);

    document.documentElement.appendChild(box);
    setTimeout(() => {
      if (chip === box && !box.contains(document.activeElement)) removeChip();
    }, CHIP_LIFETIME_MS);
  }

  function askName(box, stepIndex, suggestion) {
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
      const result = await window.__daemonizeMarkVariable({ stepIndex, name: input.value.trim() });
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

  function emit(actionType, el, value) {
    const info = infoOf(el);
    const name = info.name || info.nameAttr || info.id || el.tagName.toLowerCase();
    const event = { actionType, info, label: actionType + ' ' + name };
    if (value !== undefined) event.value = value;

    const pending = window.__daemonizeRecord(event);
    if (actionType === 'type' || actionType === 'select') {
      Promise.resolve(pending)
        .then((index) => {
          if (typeof index === 'number') showChip(index, toSnake(info.name || info.nameAttr || info.id || 'value'));
        })
        .catch(() => {});
    }
  }

  function isTextField(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image'].includes(typeOf(el));
  }

  function valueToRecord(el) {
    return typeOf(el) === 'password' ? '' : el.value;
  }

  // Record the typed value once, when the field is left or Enter is pressed.
  function flush(el) {
    if (!isTextField(el)) return;
    if (lastValues.get(el) === el.value) return;
    lastValues.set(el, el.value);
    emit('type', el, valueToRecord(el));
  }

  // Pressing Enter in a field makes the browser click the form's submit button
  // itself; that click is already covered by the recorded Enter press.
  let enterPressedAt = 0;

  document.addEventListener('click', (e) => {
    if (!e.isTrusted || inUi(e.target)) return;
    if (e.detail === 0 && performance.now() - enterPressedAt < 100) return;
    const target = clickTarget(e.target);
    if (target) emit('click', target);
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof Element) || inUi(el)) return;
    if (el.tagName === 'SELECT') {
      emit('select', el, el.value);
    } else {
      flush(el);
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!e.isTrusted || e.key !== 'Enter' || !(el instanceof Element) || inUi(el)) return;
    if (el.tagName !== 'INPUT' || !isTextField(el)) return;
    flush(el);
    emit('keypress', el, 'Enter');
    enterPressedAt = performance.now();
  }, true);
})();
`;
