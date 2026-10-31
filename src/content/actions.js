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

  async function waitFor(selector, timeout, { visible = false, gone = false } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      checkAbort();
      const el = query(selector);
      const present = el && (!visible || isVisible(el));
      if (gone ? !present : present) return el;
      if (Date.now() >= end) {
        throw new StepError(gone
          ? `"${selector}" was still on the page after ${timeout} ms.`
          : `Couldn't find "${selector}" within ${timeout} ms.`);
      }
      await sleep(100);
    }
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
        box-shadow:0 6px 24px rgba(0,0,0,.25)}
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
    ui = { host, root, badge };
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

  function setBadge(on) {
    if (on) getUi().badge.hidden = false;
    else if (ui) ui.badge.hidden = true;
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui && !ui.badge.hidden) {
      aborted = true;
      chrome.runtime.sendMessage({ type: 'cf-stop' }).catch(() => {});
    }
  }, true);

  // ---- Primitive actions ----

  function clickElement(el) {
    if (el.disabled) throw new StepError('That element is disabled.');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    flash(el);
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.click();
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  function typeInto(el, text, clear, enter) {
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
    if (enter) pressEnter(el);
  }

  function pressEnter(el) {
    const init = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true };
    const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    // Synthetic key events don't submit forms on their own.
    if (proceed && el instanceof HTMLInputElement && el.form) {
      try { el.form.requestSubmit(); } catch { /* form has no submit path */ }
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

  async function run(b) {
    aborted = false;
    setBadge(true);
    try {
      switch (b.type) {
        case 'click':
          clickElement(await waitFor(b.selector, b.timeout));
          break;
        case 'type':
          typeInto(await waitFor(b.selector, b.timeout), b.text, b.clear, b.enter);
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
    abort() { aborted = true; },
    setBadge,
  };
})();
