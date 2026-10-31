// Injected on demand into the tab a plan runs on. Exposes window.__clickflow,
// which executes one step (passed as plain data, never code) and returns
// { ok: true } or { ok: false, error }.
(() => {
  if (window.__clickflow) return;

  class StepError extends Error {}

  let aborted = false;
  let ui = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

  function query(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      throw new StepError(`"${selector}" is not a valid CSS selector.`);
    }
  }

  const isVisible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  function checkAbort() {
    if (aborted) throw new StepError('Stopped.');
  }

  const CLICKABLE = 'a,button,summary,label,li,[role=button],[role=link],[role=option],[role=menuitem],[role=tab],input[type=submit],input[type=button]';

  // Backup for Click steps whose selector no longer matches (sites that
  // regenerate ids/classes): the visible clickable element with this text.
  function findByText(text) {
    const target = norm(text);
    if (!target) return null;
    for (const el of document.querySelectorAll(CLICKABLE)) {
      if (norm(el.textContent || el.value) === target && isVisible(el)) return el;
    }
    return null;
  }

  // Resolves as soon as the element shows up (MutationObserver), with a slow
  // poll as a safety net for visibility changes that aren't DOM mutations.
  function waitFor(selector, timeout, { visible = false, gone = false, fallbackText = '' } = {}) {
    const check = () => {
      checkAbort();
      const el = query(selector) || (!gone && fallbackText ? findByText(fallbackText) : null);
      const present = Boolean(el) && (!visible || isVisible(el));
      if (gone) return present ? null : true;
      return present ? el : null;
    };
    const first = check();
    if (first) return Promise.resolve(first);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
        fn(value);
      };
      const retry = () => {
        try {
          const found = check();
          if (found) finish(resolve, found);
        } catch (e) {
          finish(reject, e);
        }
      };
      const observer = new MutationObserver(retry);
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'],
      });
      const poll = setInterval(retry, 250);
      const timer = setTimeout(() => {
        let message;
        if (gone) message = `"${selector}" was still on the page after ${timeout} ms.`;
        else if (visible && query(selector)) message = `"${selector}" is on the page but stayed hidden for ${timeout} ms.`;
        else message = `Couldn't find "${selector}"${fallbackText ? ` or an element with the text “${fallbackText}”` : ''} within ${timeout} ms.`;
        finish(reject, new StepError(message));
      }, timeout);
    });
  }

  // For the panel's "Find" button: flash every match and count them.
  function highlight(selector) {
    let matches;
    try {
      matches = [...document.querySelectorAll(selector)];
    } catch {
      return { ok: false, error: `"${selector}" is not a valid CSS selector.` };
    }
    const visible = matches.filter(isVisible);
    if (visible[0]) visible[0].scrollIntoView({ block: 'center' });
    setTimeout(() => visible.slice(0, 20).forEach(flash), 60);
    return { ok: true, count: matches.length, visible: visible.length };
  }

  // ---- On-page UI (closed shadow root so page CSS can't touch it) ----

  function getUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('clickflow-overlay');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      [hidden]{display:none!important}
      .badge{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;gap:8px;padding:8px 14px;
        border-radius:999px;background:#1b1d29;color:#fff;font:600 12px/1.2 system-ui,sans-serif;
        box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:min(460px,calc(100vw - 32px))}
      .badge span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dot{width:8px;height:8px;border-radius:50%;background:#7c7cff;animation:p 1s infinite alternate}
      @keyframes p{to{opacity:.3}}
      .flash{position:fixed;border:2px solid #6366f1;border-radius:6px;background:rgba(99,102,241,.12);
        transition:opacity .5s;box-sizing:border-box}`;
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.hidden = true;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = 'ClickFlow is running · press Esc to stop';
    badge.append(dot, label);
    root.append(style, badge);
    document.documentElement.append(host);
    ui = { host, root, badge, label };
    return ui;
  }

  function flash(el) {
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'flash';
    Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    getUi().root.append(box);
    setTimeout(() => { box.style.opacity = '0'; }, 250);
    setTimeout(() => box.remove(), 800);
  }

  // `text` names the current step, e.g. "Run 1/3 · Step 2/5 · Type text".
  function setBadge(on, text) {
    if (on) {
      const u = getUi();
      u.badge.hidden = false;
      u.label.textContent = text ? `ClickFlow · ${text} · Esc to stop` : 'ClickFlow is running · press Esc to stop';
    } else if (ui) {
      ui.badge.hidden = true;
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui && !ui.badge.hidden) {
      aborted = true;
      chrome.runtime.sendMessage({ type: 'cf-stop' }).catch(() => {});
    }
  }, true);

  // ---- Primitive actions ----

  // button: "left" (default), "right" (fires contextmenu, as pages with
  // custom context menus expect), or "double" (two clicks, then dblclick).
  function clickElement(el, button = 'left') {
    if (el.disabled) throw new StepError('That element is disabled.');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    flash(el);
    const r = el.getBoundingClientRect();
    const right = button === 'right';
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      button: right ? 2 : 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    const press = (detail) => {
      const init = { ...base, detail };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: right ? 2 : 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: right ? 2 : 1 }));
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', init));
    };
    if (right) {
      press(1);
      el.dispatchEvent(new MouseEvent('contextmenu', { ...base, detail: 1, buttons: 0 }));
      return;
    }
    press(1);
    el.click();
    if (button === 'double') {
      press(2);
      el.dispatchEvent(new MouseEvent('click', { ...base, detail: 2 }));
      el.dispatchEvent(new MouseEvent('dblclick', { ...base, detail: 2 }));
    }
  }

  // For element screenshots: scroll it into view and report its box.
  async function measure(b) {
    try {
      const el = await waitFor(b.selector, b.timeout);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      await sleep(120);
      const r = el.getBoundingClientRect();
      return { ok: true, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, dpr: window.devicePixelRatio };
    } catch (e) {
      return { ok: false, error: e instanceof StepError ? e.message : `Unexpected error: ${e.message}` };
    }
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  // Enter is pressed afterwards by the runner from the page's own JS world
  // (see pressEnterInPage in runner.js), so page handlers see keyCode 13.
  function typeInto(el, text, clear) {
    el.scrollIntoView({ block: 'center' });
    flash(el);
    el.focus({ preventScroll: true });
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.readOnly || el.disabled) throw new StepError('That field is read-only or disabled.');
      setNativeValue(el, clear ? text : el.value + text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      if (clear) el.textContent = '';
      el.append(document.createTextNode(text));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else if (el instanceof HTMLSelectElement) {
      throw new StepError('That is a dropdown — use a "Select / find in list" step instead.');
    } else {
      throw new StepError('That element is not a text field.');
    }
  }

  const matches = (textValue, target, mode) => (mode === 'contains' ? textValue.includes(target) : textValue === target);

  function findItem(container, target, mode, itemSelector) {
    let candidates;
    try {
      candidates = [...container.querySelectorAll(itemSelector || '*')];
    } catch {
      throw new StepError(`"${itemSelector}" is not a valid CSS selector.`);
    }
    const hits = candidates.filter((el) => isVisible(el) && matches(norm(el.textContent), target, mode));
    if (itemSelector) return hits[0] || null;
    // Without an item selector, prefer the innermost matching element.
    return hits.find((el) => !hits.some((o) => o !== el && el.contains(o))) || null;
  }

  function scrollableIn(el) {
    const canScroll = (n) => n.scrollHeight > n.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(n).overflowY);
    if (canScroll(el)) return el;
    for (const d of el.querySelectorAll('*')) if (canScroll(d)) return d;
    for (let p = el.parentElement; p; p = p.parentElement) if (canScroll(p)) return p;
    return document.scrollingElement;
  }

  async function selectValue(b) {
    const raw = b.match.trim();
    const target = norm(raw);
    if (b.opener) clickElement(await waitFor(b.opener, b.timeout));
    const el = await waitFor(b.selector, b.timeout);

    if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find((o) => matches(norm(o.textContent), target, b.matchMode) || o.value === raw);
      if (!option) throw new StepError(`The dropdown has no option "${raw}".`);
      flash(el);
      el.value = option.value;
      option.selected = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const scroller = scrollableIn(el);
    let stuck = 0;
    for (let i = 0; i <= b.maxScrolls; i++) {
      checkAbort();
      const item = findItem(el, target, b.matchMode, b.item);
      if (item) {
        item.scrollIntoView({ block: 'nearest' });
        await sleep(80);
        clickElement(item);
        return;
      }
      const before = scroller.scrollTop;
      scroller.scrollTop += Math.max(40, scroller.clientHeight * 0.9);
      await sleep(100);
      if (scroller.scrollTop === before) {
        // At the bottom: give lazy-loading lists a moment to append more items.
        await sleep(500);
        if (++stuck >= 2) break;
      } else {
        stuck = 0;
      }
    }
    throw new StepError(`Couldn't find "${raw}" in the list.`);
  }

  async function scrollStep(b) {
    if (b.mode === 'into-view') {
      const el = await waitFor(b.selector, b.timeout);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flash(el);
    } else if (b.selector) {
      const el = await waitFor(b.selector, b.timeout);
      el.scrollBy({ top: b.amount, behavior: 'smooth' });
    } else {
      window.scrollBy({ top: b.amount, behavior: 'smooth' });
    }
    await sleep(300);
  }

  async function run(b, label) {
    aborted = false;
    setBadge(true, label);
    try {
      switch (b.type) {
        case 'click':
          // Like a person, wait until the element is actually visible.
          clickElement(await waitFor(b.selector, b.timeout, { visible: true, fallbackText: b.fallbackText }), b.button);
          break;
        case 'type':
          typeInto(await waitFor(b.selector, b.timeout, { visible: true }), b.text, b.clear);
          break;
        case 'select':
          await selectValue(b);
          break;
        case 'wait':
          await waitFor(b.selector, b.timeout, { visible: true, gone: b.mode === 'disappear' });
          break;
        case 'scroll':
          await scrollStep(b);
          break;
        default:
          throw new StepError('Unknown step type.');
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof StepError ? e.message : `Unexpected error: ${e.message}` };
    }
  }

  window.__clickflow = {
    run,
    measure,
    highlight,
    abort() { aborted = true; },
    setBadge,
  };
})();
