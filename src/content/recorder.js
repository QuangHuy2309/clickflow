// Injected on demand (after selector.js) when the user presses Record.
// Watches the user's own (trusted) clicks, typing and dropdown changes and
// reports each one to the panel as a step. Never records password or payment
// field contents.
(() => {
  if (window.__clickflowRecorder) return;

  const buildSelector = (el) => window.__clickflowSelector.build(el);
  const NON_TEXT_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'color', 'range', 'hidden']);
  const ACTIONABLE = 'a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=option],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=switch],[onclick],[tabindex]';
  const LIST_CONTAINERS = '[role=listbox],[role=menu],[role=tree],[role=grid],ul,ol';
  const LIST_ITEMS = '[role=option],[role=menuitem],[role=treeitem],li';

  let session = null;

  const isTextField = (el) => (el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type))
    || el instanceof HTMLTextAreaElement
    || (el instanceof HTMLElement && el.isContentEditable);

  const isSecret = (el) => el instanceof HTMLInputElement
    && (el.type === 'password' || /cc-|one-time-code|new-password|current-password/.test(el.autocomplete || ''));

  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  function send(step, el) {
    if (!session) return;
    if (el) flash(el);
    chrome.runtime.sendMessage({ type: 'cf-rec', sessionId: session.id, step }).catch(() => {});
  }

  // ---- On-page UI ----

  function buildUi() {
    const host = document.createElement('clickflow-recorder');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .bar{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:9px;
        padding:9px 18px;border-radius:999px;background:#1b1d29;color:#fff;font:600 13px/1.2 system-ui,sans-serif;
        box-shadow:0 8px 28px rgba(0,0,0,.3)}
      .dot{width:9px;height:9px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 0 rgba(239,68,68,.6);animation:p 1.4s infinite}
      @keyframes p{70%{box-shadow:0 0 0 8px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
      .flash{position:fixed;border:2px solid #10b981;border-radius:6px;background:rgba(16,185,129,.12);
        box-sizing:border-box;transition:opacity .6s}`;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = 'ClickFlow is recording your actions';
    bar.append(dot, label);
    root.append(style, bar);
    document.documentElement.append(host);
    return { host, root };
  }

  function flash(el) {
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'flash';
    Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    session.ui.root.append(box);
    setTimeout(() => { box.style.opacity = '0'; }, 300);
    setTimeout(() => box.remove(), 1000);
  }

  // ---- Typing ----

  function flushTyping(el, enter = false) {
    const pending = session.typing.get(el);
    if (!pending && !enter) return;
    clearTimeout(pending?.timer);
    session.typing.delete(el);
    const secret = isSecret(el);
    const value = el.isContentEditable ? el.innerText : el.value;
    send({ type: 'type', selector: buildSelector(el), text: secret ? '' : value, clear: true, enter, secret }, el);
  }

  function onInput(e) {
    const el = e.target;
    if (!e.isTrusted || !isTextField(el)) return;
    const pending = session.typing.get(el);
    clearTimeout(pending?.timer);
    session.typing.set(el, { timer: setTimeout(() => flushTyping(el), 700) });
  }

  function onKeydown(e) {
    if (e.isTrusted && e.key === 'Enter' && isTextField(e.target) && !(e.target instanceof HTMLTextAreaElement)) {
      flushTyping(e.target, true);
    }
  }

  function onFocusOut(e) {
    if (isTextField(e.target)) flushTyping(e.target);
  }

  // ---- Dropdowns ----

  function onChange(e) {
    const el = e.target;
    if (!e.isTrusted) return;
    if (el instanceof HTMLSelectElement) {
      const option = el.selectedOptions[0];
      if (option) send({ type: 'select', selector: buildSelector(el), match: textOf(option), matchMode: 'exact' }, el);
    } else if (isTextField(el)) {
      flushTyping(el);
    }
  }

  // ---- Clicks ----

  function scrollableListFor(item) {
    for (let p = item.parentElement; p && p !== document.body; p = p.parentElement) {
      const scrolls = p.scrollHeight > p.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY);
      if (scrolls) return p.clientHeight < window.innerHeight * 0.6 ? p : null;
    }
    return null;
  }

  function onClick(e) {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const el = e.target.closest(ACTIONABLE) || e.target;
    if (isTextField(el) || el instanceof HTMLSelectElement || el instanceof HTMLOptionElement) return;

    // A label click also clicks its control; record only one of them.
    const now = Date.now();
    const last = session.lastClick;
    session.lastClick = { el, t: now };
    if (last && now - last.t < 150 && last.el instanceof HTMLLabelElement && last.el.control === el) return;
    if (el instanceof HTMLLabelElement && el.control && isTextField(el.control)) return;

    // Typing that's still pending should come before this click.
    for (const field of [...session.typing.keys()]) flushTyping(field);

    // An item in a small scrollable list becomes a "find in list" step, which
    // keeps working when the item's position changes or the list lazy-loads.
    const text = textOf(el);
    const list = text && text.length <= 80 && (el.matches(LIST_ITEMS) || el.closest(LIST_ITEMS)) ? scrollableListFor(el) : null;
    if (list && list.matches(`${LIST_CONTAINERS},[class*=list],[class*=menu],[class*=dropdown]`)) {
      send({ type: 'select', selector: buildSelector(list), match: text, matchMode: 'exact' }, el);
      return;
    }
    send({ type: 'click', selector: buildSelector(el) }, el);
  }

  // ---- Lifecycle ----

  const LISTENERS = [['click', onClick], ['input', onInput], ['change', onChange], ['keydown', onKeydown], ['focusout', onFocusOut]];

  function start(id) {
    stop();
    session = { id, typing: new Map(), lastClick: null, ui: buildUi() };
    for (const [t, fn] of LISTENERS) document.addEventListener(t, fn, true);
  }

  function stop() {
    if (!session) return;
    for (const field of [...session.typing.keys()]) flushTyping(field);
    for (const [t, fn] of LISTENERS) document.removeEventListener(t, fn, true);
    session.ui.host.remove();
    session = null;
  }

  window.__clickflowRecorder = { start, stop };
})();
