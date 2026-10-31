// Runs a plan: for each data row (or repeat), each enabled block in order.
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

export class Runner {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.status = 'idle';
    this.tabId = null;
    this._wake = null;
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
    this._emitStatus();
    const summary = { runs: values.length, ok: 0, failed: 0, stopped: false };

    try {
      outer: for (let r = 0; r < values.length; r++) {
        let failed = false;
        for (let s = 0; s < blocks.length; s++) {
          if (!(await this._checkpoint())) break outer;
          const block = blocks[s];
          this.hooks.onProgress?.({ run: r, runs: values.length, step: s, steps: blocks.length, blockId: block.id });
          const res = await this._execute(templateBlock(block, values[r], r));
          if (this._stopped) break outer;
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
      summary.stopped = this._stopped;
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
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this._wake = done;
    });
  }

  async _execute(block) {
    if (block.type === 'wait' && block.mode === 'time') {
      await this._sleep(block.ms);
      return { ok: true };
    }
    try {
      const target = { tabId: this.tabId };
      await chrome.scripting.executeScript({ target, files: [ACTIONS_FILE] });
      const [res] = await chrome.scripting.executeScript({
        target,
        func: (b) => window.__clickflow.run(b),
        args: [block],
      });
      const result = res?.result ?? { ok: false, error: 'The page did not respond.' };
      if (result.ok && block.type === 'type' && block.enter) {
        // A navigation triggered by Enter can tear the frame down mid-call; that's success.
        await chrome.scripting.executeScript({ target, world: 'MAIN', func: pressEnterInPage, args: [block.selector] })
          .catch(() => {});
      }
      await this._waitForLoad();
      return result;
    } catch (e) {
      return { ok: false, error: friendlyError(e.message) };
    }
  }

  // If a step triggered navigation, wait until the new page finishes loading.
  async _waitForLoad() {
    await new Promise((r) => setTimeout(r, 150));
    const end = Date.now() + 30000;
    while (Date.now() < end && !this._stopped) {
      const tab = await chrome.tabs.get(this.tabId);
      if (tab.status === 'complete') return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async _page(method, arg) {
    if (this.tabId == null) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: (m, a) => window.__clickflow?.[m]?.(a),
        args: [method, arg ?? null],
      });
    } catch { /* tab gone or no access; nothing to clean up */ }
  }
}
