// Runs a plan: for each data row (or repeat), each enabled block in order.
// Steps are sent to the page as structured data via chrome.scripting.

import { runRows, templateBlock, unknownPlaceholders } from '../shared/data.js';
import { BLOCK_TYPES, LIMITS, validateBlock } from '../shared/schema.js';
import { friendlyError } from './site.js';

const ACTIONS_FILE = 'src/content/actions.js';

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
    if (missing.length) throw new Error(`No data column named ${missing.map((m) => `“${m}”`).join(', ')}. Add it in the Data tab.`);
    const rows = runRows(plan);
    const values = rows.length ? rows : Array(plan.repeat).fill(Object.fromEntries(plan.columns.map((c) => [c, ''])));
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
          const res = await this._execute(templateBlock(block, values[r], r, plan.columns));
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
      await this._waitForLoad();
      return res?.result ?? { ok: false, error: 'The page did not respond.' };
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
