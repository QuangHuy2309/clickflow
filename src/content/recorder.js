// Injected on demand (after selector.js) when the user presses Record.
// Watches the user's own (trusted) clicks, typing, dropdown changes and scrolls, and
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
  const isGone = (el) => !el.isConnected || el.getClientRects().length === 0;

  function send(step, el) {
    if (!session) return;
    if (el?.isConnected) flash(el);
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
    const value = pending?.value ?? (el.isContentEditable ? el.innerText : el.value);
    send({ type: 'type', selector: pending?.selector ?? buildSelector(el), text: secret ? '' : value, clear: true, enter, secret }, el);
  }

  function flushAllTyping() {
    flushAllScrolls();
    for (const field of [...session.typing.keys()]) flushTyping(field);
  }

  function onInput(e) {
    const el = e.target;
    if (!e.isTrusted || !isTextField(el)) return;
    if (session.enterCandidate === el) session.enterCandidate = null;
    const pending = session.typing.get(el);
    clearTimeout(pending?.timer);
    // Keep what the user typed now: page scripts (autocomplete) may rewrite
    // the field or replace the element before we flush.
    session.typing.set(el, {
      selector: pending?.selector ?? buildSelector(el),
      value: el.isContentEditable ? el.innerText : el.value,
      timer: setTimeout(() => flushTyping(el), 700),
    });
  }

  function onKeydown(e) {
    if (!e.isTrusted || e.key !== 'Enter' || !isTextField(e.target)) return;
    const el = e.target;
    if (el instanceof HTMLTextAreaElement || el.isContentEditable) {
      // Enter in a multi-line field is usually a new line, but search boxes
      // (Google's is a <textarea>) use it to submit. Decide after the page's
      // own handlers have run; see onKeydownAfterPage.
      if (!e.shiftKey) session.enterCandidate = el;
      return;
    }
    flushTyping(el, true);
  }

  // Bubble phase on window: the page's handlers have run by now.
  function onKeydownAfterPage(e) {
    const el = session?.enterCandidate;
    if (!el || e.target !== el) return;
    session.enterCandidate = null;
    // The page cancelled the new line, so Enter meant "submit".
    if (e.defaultPrevented) flushTyping(el, true);
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

  // ---- Scrolling ----
  // "scroll" events don't say who scrolled (page scripts scroll too), so a
  // scroll counts only around the user's own wheel, touch, scroll key or
  // scrollbar drag. Each scroller (the page, or one section of it) is
  // tracked on its own; its movement is summed and sent once it rests.
  // Chrome scrolls on the compositor before input handlers run, so the
  // starting point is the last position seen, not one read at input time.

  const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' ']);
  const MIN_SCROLL_PX = 20;
  const USER_SCROLL_MS = 800;

  const pageScroller = () => document.scrollingElement || document.documentElement;
  const scrollTop = (el) => (el === pageScroller() ? window.scrollY : el.scrollTop);

  function onScrollInput(e) {
    if (!e.isTrusted) return;
    const t = e.target;
    if (e.type === 'keydown') {
      // Keys in fields and on buttons do their own thing, not scrolling.
      if (!SCROLL_KEYS.has(e.key) || isTextField(t) || (t instanceof Element && t.closest('button,input,select,textarea,[role=button],[role=listbox],[role=menu]'))) return;
    } else if (e.type === 'pointerdown') {
      // Only a press on a scrollbar; a click that makes the page scroll
      // itself (an anchor link, say) replays that scroll by itself.
      const onBar = (t instanceof Element && t.clientWidth > 0 && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight))
        || e.clientX >= document.documentElement.clientWidth;
      if (!onBar) return;
    }
    session.userScrollUntil = Date.now() + USER_SCROLL_MS;
    // A scroll that landed just before this input event belongs to it.
    const early = session.unclaimed;
    session.unclaimed = null;
    if (early && Date.now() - early.t < 150) claimScroll(early.el, early.from);
  }

  function claimScroll(el, from) {
    let s = session.scrolls.get(el);
    if (!s) {
      s = { from, timer: 0 };
      session.scrolls.set(el, s);
    }
    session.userScrollUntil = Date.now() + USER_SCROLL_MS; // momentum keeps scrolling
    clearTimeout(s.timer);
    s.timer = setTimeout(() => flushScroll(el), 600);
  }

  function onScroll(e) {
    if (!e.isTrusted) return;
    const el = e.target === document || e.target === document.documentElement || e.target === document.body ? pageScroller() : e.target;
    if (!(el instanceof Element)) return;
    // Sections are assumed to start at the top until seen scrolling.
    const from = session.positions.get(el) ?? 0;
    session.positions.set(el, scrollTop(el));
    if (Date.now() <= session.userScrollUntil) claimScroll(el, from);
    else if (!session.scrolls.has(el)) session.unclaimed = { el, from, t: Date.now() };
  }

  function flushScroll(el, { drop = false } = {}) {
    const s = session.scrolls.get(el);
    if (!s) return;
    clearTimeout(s.timer);
    session.scrolls.delete(el);
    const amount = Math.round(scrollTop(el) - s.from);
    if (drop || Math.abs(amount) < MIN_SCROLL_PX) return;
    const page = el === pageScroller() || el === document.body;
    send({ type: 'scroll', mode: 'by', selector: page ? '' : buildSelector(el), amount }, page ? null : el);
  }

  // Keep the order of actions: pending scrolls go before the next step.
  function flushAllScrolls() {
    for (const el of [...session.scrolls.keys()]) flushScroll(el);
  }

  // ---- Clicks ----

  function scrollableListFor(item) {
    for (let p = item.parentElement; p && p !== document.body; p = p.parentElement) {
      const scrolls = p.scrollHeight > p.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY);
      if (scrolls) return p.clientHeight < window.innerHeight * 0.6 ? p : null;
    }
    return null;
  }

  function clickTarget(e) {
    if (!(e.target instanceof Element)) return null;
    const el = e.target.closest(ACTIONABLE) || e.target;
    if (isTextField(el) || el instanceof HTMLSelectElement || el instanceof HTMLOptionElement) return null;
    if (el instanceof HTMLLabelElement && el.control && isTextField(el.control)) return null;
    return el;
  }

  // The step for clicking `el`. An item in a small scrollable list becomes a
  // "find in list" step, which keeps working when the item moves or the list
  // lazy-loads.
  function describeClick(el) {
    const text = textOf(el);
    const list = text && text.length <= 80 && (el.matches(LIST_ITEMS) || el.closest(LIST_ITEMS)) ? scrollableListFor(el) : null;
    if (list && list.matches(`${LIST_CONTAINERS},[class*=list],[class*=menu],[class*=dropdown]`)) {
      // The "find in list" step scrolls the list itself.
      flushScroll(list, { drop: true });
      return { type: 'select', selector: buildSelector(list), match: text, matchMode: 'exact' };
    }
    // The visible text is a backup way to find the element if the site
    // regenerates its ids/classes before the plan is replayed.
    return { type: 'click', selector: buildSelector(el), fallbackText: text && text.length <= 60 ? text : '' };
  }

  // Some widgets (autocomplete suggestions, menus) act on mousedown and
  // remove the element before "click" fires. Describe the target on
  // pointerdown so it can still be recorded if no click follows.
  function onPointerDown(e) {
    if (!e.isTrusted || e.button !== 0) return;
    onScrollInput(e); // may be a scrollbar drag
    const el = clickTarget(e);
    session.pressed = null;
    if (!el) return;
    flushAllTyping();
    session.pressed = { el, step: describeClick(el), done: false };
  }

  function onPointerUp() {
    const pressed = session.pressed;
    if (!pressed) return;
    setTimeout(() => {
      if (session && session.pressed === pressed && !pressed.done && isGone(pressed.el)) {
        pressed.done = true;
        send(pressed.step, null);
      }
    }, 400);
  }

  function onClick(e) {
    if (!e.isTrusted) return;
    const el = clickTarget(e);
    if (!el) return;

    // A label click also clicks its control; record only one of them.
    const now = Date.now();
    const last = session.lastClick;
    session.lastClick = { el, t: now };
    if (last && now - last.t < 150 && last.el instanceof HTMLLabelElement && last.el.control === el) return;

    const pressed = session.pressed;
    flushAllTyping();
    if (pressed && (pressed.el === el || pressed.el.contains(el) || el.contains(pressed.el))) {
      if (pressed.done) return;
      pressed.done = true;
      // If the pressed element vanished or moved on mousedown, the browser
      // sends "click" to a common ancestor (often <body>). The user meant
      // the element they pressed.
      if (el !== pressed.el && el.contains(pressed.el)) {
        send(pressed.step, pressed.el);
        return;
      }
    }
    send(describeClick(el), el);
  }

  function onContextMenu(e) {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const el = e.target.closest(ACTIONABLE) || e.target;
    flushAllTyping();
    send({ type: 'click', selector: buildSelector(el), button: 'right' }, el);
  }

  // The browser also reports the two single clicks; the panel folds them
  // into this one step.
  function onDblClick(e) {
    if (!e.isTrusted) return;
    const el = clickTarget(e);
    if (el) send({ type: 'click', selector: buildSelector(el), button: 'double' }, el);
  }

  // The page is navigating away: send anything still pending before the
  // recorder is torn down (it's re-attached on the next page).
  function onPageHide() {
    if (!session) return;
    if (session.enterCandidate) {
      flushTyping(session.enterCandidate, true);
      session.enterCandidate = null;
    }
    const pressed = session.pressed;
    if (pressed && !pressed.done) {
      pressed.done = true;
      send(pressed.step, null);
    }
    flushAllTyping();
  }

  // ---- Lifecycle ----

  const DOC_LISTENERS = [
    ['pointerdown', onPointerDown], ['pointerup', onPointerUp], ['click', onClick], ['input', onInput],
    ['contextmenu', onContextMenu], ['dblclick', onDblClick],
    ['change', onChange], ['keydown', onKeydown], ['focusout', onFocusOut],
    ['scroll', onScroll], ['wheel', onScrollInput], ['touchstart', onScrollInput], ['keydown', onScrollInput],
  ];
  const PASSIVE = new Set(['scroll', 'wheel', 'touchstart']);

  function start(id) {
    stop();
    session = {
      id, typing: new Map(), lastClick: null, pressed: null, enterCandidate: null, ui: buildUi(),
      scrolls: new Map(), positions: new Map(), userScrollUntil: 0, unclaimed: null,
    };
    session.positions.set(pageScroller(), window.scrollY);
    for (const [t, fn] of DOC_LISTENERS) document.addEventListener(t, fn, { capture: true, passive: PASSIVE.has(t) });
    window.addEventListener('keydown', onKeydownAfterPage);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
  }

  function stop() {
    if (!session) return;
    flushAllTyping();
    for (const [t, fn] of DOC_LISTENERS) document.removeEventListener(t, fn, { capture: true });
    window.removeEventListener('keydown', onKeydownAfterPage);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('beforeunload', onPageHide);
    session.ui.host.remove();
    session = null;
  }

  window.__clickflowRecorder = { start, stop };
})();
