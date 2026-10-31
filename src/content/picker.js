// Injected on demand when the user clicks "Pick". Highlights the element under
// the cursor and, on click, reports a unique CSS selector back to the panel.
(() => {
  if (window.__clickflowPicker) return;

  let session = null;

  const unique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };
  const quote = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const stableId = (id) => id.length < 60 && !/\d{4,}|[0-9a-f]{8,}|^[\d:_-]|:/i.test(id);
  const stableClass = (c) => c.length < 40 && !/\d{3,}/.test(c)
    && !/^(css|sc|jsx|emotion|svelte)-/.test(c)
    && !/(^|[-_])(active|hover|focus|focused|selected|open|show|visible|disabled)$/i.test(c);

  const ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder', 'title', 'alt'];

  function buildSelector(el) {
    if (el.id && stableId(el.id) && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    const tag = el.localName;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length < 80) {
        const sel = `${tag}[${a}="${quote(v)}"]`;
        if (unique(sel)) return sel;
      }
    }
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
      let seg;
      if (cur.id && stableId(cur.id)) {
        seg = `#${CSS.escape(cur.id)}`;
      } else {
        seg = cur.localName + [...cur.classList].filter(stableClass).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
        const parent = cur.parentElement;
        if (parent) {
          const same = [...parent.children].filter((c) => c.localName === cur.localName);
          if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(seg);
      const sel = parts.join(' > ');
      if (unique(sel)) return sel;
    }
    return parts.join(' > ');
  }

  function buildUi() {
    const host = document.createElement('clickflow-picker');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .box{position:fixed;border:2px solid #6366f1;background:rgba(99,102,241,.15);border-radius:4px;
        box-sizing:border-box}
      .tip{position:fixed;max-width:420px;padding:4px 8px;border-radius:6px;background:#1b1d29;color:#fff;
        font:12px/1.4 ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:999px;
        background:#6366f1;color:#fff;font:600 13px/1.2 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)}`;
    const box = document.createElement('div');
    box.className = 'box';
    const tip = document.createElement('div');
    tip.className = 'tip';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.textContent = 'ClickFlow: click an element to select it · Esc to cancel';
    root.append(style, box, tip, bar);
    document.documentElement.append(host);
    return { host, box, tip };
  }

  function onMove(e) {
    const el = e.target;
    if (!(el instanceof Element) || el === session.ui.host) return;
    session.target = el;
    const r = el.getBoundingClientRect();
    Object.assign(session.ui.box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    session.ui.tip.textContent = buildSelector(el);
    const tipTop = r.top > 30 ? r.top - 26 : r.bottom + 6;
    Object.assign(session.ui.tip.style, { left: `${Math.max(4, r.left)}px`, top: `${tipTop}px` });
  }

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    swallow(e);
    const el = session.target || e.target;
    const { requestId } = session;
    const selector = buildSelector(el);
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    stop();
    chrome.runtime.sendMessage({ type: 'cf-picked', requestId, selector, text }).catch(() => {});
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    swallow(e);
    const { requestId } = session;
    stop();
    chrome.runtime.sendMessage({ type: 'cf-pick-cancel', requestId }).catch(() => {});
  }

  const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'];

  function start(requestId) {
    stop();
    session = { requestId, target: null, ui: buildUi() };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    for (const t of BLOCKED) document.addEventListener(t, swallow, true);
  }

  function stop() {
    if (!session) return;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    for (const t of BLOCKED) document.removeEventListener(t, swallow, true);
    session.ui.host.remove();
    session = null;
  }

  window.__clickflowPicker = { start, stop };
})();
