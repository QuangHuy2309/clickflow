// Injected on demand (after selector.js) when the user clicks "Pick".
// Highlights the element under the cursor and, on click, reports a unique CSS
// selector back to the panel.
(() => {
  if (window.__clickflowPicker) return;

  const buildSelector = (el) => window.__clickflowSelector.build(el);
  let session = null;

  function buildUi() {
    const host = document.createElement('clickflow-picker');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .box{position:fixed;border:2px solid #6366f1;background:rgba(99,102,241,.15);border-radius:6px;box-sizing:border-box}
      .tip{position:fixed;max-width:420px;padding:4px 8px;border-radius:6px;background:#1b1d29;color:#fff;
        font:12px/1.4 ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bar{position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:9px 18px;border-radius:999px;
        background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font:600 13px/1.2 system-ui,sans-serif;
        box-shadow:0 8px 28px rgba(79,70,229,.4)}`;
    const box = document.createElement('div');
    box.className = 'box';
    const tip = document.createElement('div');
    tip.className = 'tip';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.textContent = 'Click an element to select it · Esc to cancel';
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
