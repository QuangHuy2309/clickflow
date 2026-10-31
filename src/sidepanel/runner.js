// Runs a plan: for each run, each enabled block in order.
// Steps are sent to the page as structured data via chrome.scripting.

import { planRuns, templateBlock, unknownPlaceholders } from '../shared/data.js';
import { BLOCK_TYPES, LIMITS, validateBlock } from '../shared/schema.js';
import { friendlyError } from './site.js';

const ACTIONS_FILE = 'src/content/actions.js';

// Runs in the page's own JS world (serialized by chrome.scripting; it can't
// use anything from this module). Events built in an extension's isolated
// world report keyCode/which as 0 to page scripts, and many sites check
// keyCode === 13, so Enter is dispatched from here instead. If no page script
// reacted (nothing cancelled the keydown, no navigation started), the field's
// form is submitted, which is what a real Enter does in a search box with no
// submit button.
async function pressEnterInPage(selector) {
  const el = document.querySelector(selector) || document.activeElement;
  if (!el) return false;
  const fire = (type) => {
    const ev = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(ev, 'keyCode', { get: () => 13 });
    Object.defineProperty(ev, 'which', { get: () => 13 });
    Object.defineProperty(ev, 'charCode', { get: () => (type === 'keypress' ? 13 : 0) });
    return el.dispatchEvent(ev);
  };
  const startUrl = location.href;
  let leaving = false;
  const onLeave = () => { leaving = true; };
  window.addEventListener('beforeunload', onLeave);
  const notCancelled = fire('keydown');
  fire('keypress');
  fire('keyup');
  await new Promise((r) => setTimeout(r, 250));
  window.removeEventListener('beforeunload', onLeave);
  const form = el.form || el.closest?.('form');
  if (notCancelled && !leaving && location.href === startUrl && form) {
    try { form.requestSubmit(); } catch { form.submit(); }
  }
  return true;
}

// Chrome allows about 2 captureVisibleTab calls per second.
const CAPTURE_GAP_MS = 550;
// How long to wait for a click/submit to start a navigation before moving on.
const NAV_GRACE_MS = 40;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export class Runner {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.status = 'idle';
    this.tabId = null;
    this._wake = null;
    this._lastCapture = 0;
    this._navigating = false;
    this._onTabUpdated = (tabId, info) => {
      if (tabId === this.tabId && info.status === 'loading') this._navigating = true;
    };
  }

  get busy() {
    return this.status !== 'idle';
  }

  async start(plan, tabId) {
    if (this.busy) return;
    const blocks = plan.blocks.filter((b) => b.enabled);
    if (!blocks.length) throw new Error('Add at least one enabled step first.');
    for (const b of blocks) {
      const problem = validateBlock(b);
      if (problem) {
        this.hooks.onStepError?.(b.id, problem);
        throw new Error(`Step ${plan.blocks.indexOf(b) + 1} (${BLOCK_TYPES[b.type].label}): ${problem}`);
      }
    }
    const missing = unknownPlaceholders(plan);
    if (missing.length) throw new Error(`No data set named ${missing.map((m) => `“${m}”`).join(', ')}. Add it in the Data tab.`);
    const values = planRuns(plan);
    if (!values.length) throw new Error('A data set used by your steps is empty. Add values in the Data tab.');
    if (values.length > LIMITS.runs) throw new Error(`Too many runs (max ${LIMITS.runs}).`);

    this.tabId = tabId;
    this.status = 'running';
    this._stopped = false;
    chrome.tabs.onUpdated.addListener(this._onTabUpdated);
    this._emitStatus();
    const summary = { runs: values.length, ok: 0, failed: 0, stopped: false, ms: 0 };
    const started = performance.now();

    try {
      outer: for (let r = 0; r < values.length; r++) {
        let failed = false;
        for (let s = 0; s < blocks.length; s++) {
          if (!(await this._checkpoint())) break outer;
          const block = blocks[s];
          const step = templateBlock(block, values[r], r);
          const info = { run: r, runs: values.length, step: s, steps: blocks.length, blockId: block.id };
          this.hooks.onProgress?.(info);
          const t0 = performance.now();
          const label = `Run ${r + 1}/${values.length} · Step ${s + 1}/${blocks.length} · ${BLOCK_TYPES[block.type].label}`;
          let res = await this._execute(step, label, info);
          // A retry changes something: it waits twice as long for the element.
          for (let attempt = 1; !res.ok && !this._stopped && attempt <= (plan.retries || 0); attempt++) {
            this.hooks.onRetry?.({ ...info, block: step, attempt, error: res.error });
            const longer = 'timeout' in step ? { ...step, timeout: Math.min(step.timeout * 2 ** attempt, 120000) } : step;
            res = await this._execute(longer, label, info);
          }
          if (this._stopped) break outer;
          this.hooks.onStepDone?.({ ...info, block: step, ok: res.ok, error: res.error, ms: Math.round(performance.now() - t0) });
          if (!res.ok) {
            failed = true;
            summary.failed++;
            this.hooks.onStepError?.(block.id, res.error, r);
            if (plan.onError === 'stop') break outer;
            break;
          }
          if (s < blocks.length - 1) await this._sleep(plan.stepDelay);
        }
        if (!failed) summary.ok++;
        if (r < values.length - 1) await this._sleep(plan.runDelay);
      }
    } finally {
      chrome.tabs.onUpdated.removeListener(this._onTabUpdated);
      summary.stopped = this._stopped;
      summary.ms = Math.round(performance.now() - started);
      await this._page('setBadge', false);
      this.status = 'idle';
      this.tabId = null;
      this._emitStatus();
      this.hooks.onDone?.(summary);
    }
  }

  pause() {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this._emitStatus();
  }

  resume() {
    if (this.status !== 'paused') return;
    this.status = 'running';
    this._emitStatus();
    this._wake?.();
  }

  stop() {
    if (!this.busy) return;
    this._stopped = true;
    this._wake?.();
    this._page('abort');
  }

  _emitStatus() {
    this.hooks.onStatus?.(this.status);
  }

  async _checkpoint() {
    while (this.status === 'paused' && !this._stopped) await this._sleep(60000);
    return !this._stopped;
  }

  _sleep(ms) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this._wake = done;
    });
  }

  // Calls window.__clickflow[method] in the page, injecting actions.js only
  // when this page doesn't have it yet (once per page load, not per step).
  async _callPage(method, args) {
    const target = { tabId: this.tabId };
    const call = () => chrome.scripting.executeScript({
      target,
      func: (m, a) => (window.__clickflow ? window.__clickflow[m](...a) : { missing: true }),
      args: [method, args],
    });
    let [res] = await call();
    if (res?.result?.missing) {
      await chrome.scripting.executeScript({ target, files: [ACTIONS_FILE] });
      [res] = await call();
    }
    return res?.result ?? { ok: false, error: 'The page did not respond.' };
  }

  async _execute(block, label, info) {
    if (block.type === 'wait' && block.mode === 'time') {
      await this._sleep(block.ms);
      return { ok: true };
    }
    if (block.type === 'screenshot') return this._screenshot(block, label, info);
    this._navigating = false;
    try {
      let result;
      try {
        result = await this._callPage('run', [block, label]);
      } catch (e) {
        // The previous step's navigation can still be tearing the old page
        // down; wait for the new page and try once more.
        if (!/frame|navigat|document|closed|context/i.test(e.message)) throw e;
        await this._waitForLoad(true);
        result = await this._callPage('run', [block, label]);
      }
      if (result.ok && block.type === 'type' && block.enter) {
        // A navigation triggered by Enter can tear the frame down mid-call; that's success.
        await chrome.scripting.executeScript({ target: { tabId: this.tabId }, world: 'MAIN', func: pressEnterInPage, args: [block.selector] })
          .catch(() => {});
      }
      // Only steps that can trigger a navigation pay for the navigation check.
      const canNavigate = block.type === 'click' || block.type === 'select' || (block.type === 'type' && block.enter);
      if (canNavigate) await this._waitForLoad();
      return result;
    } catch (e) {
      return { ok: false, error: friendlyError(e.message) };
    }
  }

  // If the step started a navigation (seen as a "loading" tab update), wait
  // until the new page has loaded. Otherwise return almost immediately.
  async _waitForLoad(force = false) {
    for (let waited = 0; !force && !this._navigating && waited < NAV_GRACE_MS; waited += 10) await sleepMs(10);
    if (!force && !this._navigating) {
      const tab = await chrome.tabs.get(this.tabId);
      if (tab.status !== 'loading') return;
    }
    const end = Date.now() + 30000;
    while (Date.now() < end && !this._stopped) {
      const tab = await chrome.tabs.get(this.tabId);
      if (tab.status === 'complete') break;
      await sleepMs(100);
    }
    this._navigating = false;
  }

  async _screenshot(block, label, info) {
    try {
      const tab = await chrome.tabs.get(this.tabId);
      if (!tab.active) return { ok: false, error: 'Switch to the tab being automated: screenshots capture the visible tab.' };
      let crop = null;
      if (block.selector) {
        const m = await this._callPage('measure', [block]);
        if (!m.ok) return m;
        crop = m;
      }
      await this._page('setBadge', false); // keep the badge out of the picture
      const wait = this._lastCapture + CAPTURE_GAP_MS - Date.now();
      if (wait > 0) await sleepMs(wait);
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } finally {
        this._lastCapture = Date.now();
        this._page('setBadge', true, label);
      }
      let blob = await (await fetch(dataUrl)).blob();
      if (crop) blob = await cropImage(blob, crop);
      this.hooks.onScreenshot?.({ ...info, name: block.name || `screenshot-${info.run + 1}`, blob });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: /permission|activeTab|all_urls/i.test(e.message)
        ? "ClickFlow isn't allowed to capture this page. Allow it on this site and try again."
        : friendlyError(e.message) };
    }
  }

  async _page(method, ...args) {
    if (this.tabId == null) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: (m, a) => window.__clickflow?.[m]?.(...a),
        args: [method, args],
      });
    } catch { /* tab gone or no access; nothing to clean up */ }
  }
}

// Crops a visible-tab capture to an element's box (CSS px × devicePixelRatio).
async function cropImage(blob, { rect, dpr }) {
  const bitmap = await createImageBitmap(blob);
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * dpr)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * dpr)));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}
