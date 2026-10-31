// Runs a plan: for each run, each enabled block in order.
// Steps are sent to the page as structured data via chrome.scripting.

import { planRuns, templateBlock, unknownPlaceholders } from '../shared/data.js';
import { t } from '../shared/i18n.js';
import { BLOCK_TYPES, LIMITS, validateBlock, waitAfterMs } from '../shared/schema.js';
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
// Most a new page may take to show its content before the next step starts
// anyway (that step still waits for its own element).
const PAGE_LOAD_MAX_MS = 15000;
// Extra time a page call gets beyond the step's own timeout before it counts
// as hung (a frozen or crashed page never answers).
const CALL_SLACK_MS = 5000;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

class Stopped extends Error {}
class Hung extends Error {}

export class Runner {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.status = 'idle';
    this.tabId = null;
    this._wake = null;
    this._lastCapture = 0;
    this._navigating = false;
    this._pausedMs = 0;
    this._pausedAt = 0;
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
    if (!blocks.length) throw new Error(t('Add at least one enabled step first.'));
    const timeout = plan.timeout || 5000;
    for (const b of blocks) {
      const n = plan.blocks.indexOf(b) + 1;
      for (const [x, no] of [[b, n], ...(b.steps || []).map((x, i) => [x, `${n}.${i + 1}`]).filter(([x]) => x.enabled)]) {
        const problem = validateBlock(x);
        if (problem) {
          this.hooks.onStepError?.(x.id, problem);
          throw new Error(t('Step {n} ({type}): {problem}', { n: no, type: t(BLOCK_TYPES[x.type].label), problem }));
        }
      }
    }
    this._plan = plan;
    this._opened = 0;
    const missing = unknownPlaceholders(plan);
    if (missing.length) throw new Error(t('No data set named {names}. Add it in the Data tab.', { names: missing.map((m) => `“${m}”`).join(', ') }));
    const values = planRuns(plan);
    if (!values.length) throw new Error(t('A data set used by your steps is empty. Add values in the Data tab.'));
    if (values.length > LIMITS.runs) throw new Error(t('Too many runs (max {n}).', { n: LIMITS.runs }));

    this.tabId = tabId;
    this.status = 'running';
    this._stopped = false;
    this._pausedMs = 0;
    this._stopSignal = new Promise((resolve) => { this._onStop = resolve; });
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
          const step = { ...templateBlock(block, values[r], r), timeout };
          // Steps inside a row loop get this run's values too.
          if (block.steps) step.steps = block.steps.filter((x) => x.enabled).map((x) => ({ ...templateBlock(x, values[r], r), timeout }));
          const info = { run: r, runs: values.length, step: s, steps: blocks.length, blockId: block.id };
          const res = await this._runStep(step, info);
          if (this._stopped) break outer;
          if (!res.ok) {
            failed = true;
            summary.failed++;
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
      this._page('setBadge', false); // no need to wait on a busy page
      this.status = 'idle';
      this.tabId = null;
      this._emitStatus();
      this.hooks.onDone?.(summary);
    }
  }

  // One step: run it (retrying with a longer wait), log it, then its "Then
  // wait". `info.row` / `info.sub` mark a step inside a row loop.
  async _runStep(step, info) {
    this.hooks.onProgress?.(info);
    const t0 = performance.now();
    const paused0 = this._pausedMs;
    const where = t('Run {run}/{runs} · Step {step}/{steps}', { run: info.run + 1, runs: info.runs, step: info.step + 1, steps: info.steps });
    const row = info.row ? ` · ${t('Row {n}', { n: info.row })}` : '';
    const label = t('ClickFlow · {step} · Esc to stop', { step: `${where}${row} · ${t(BLOCK_TYPES[step.type].label)}` });
    let res = await this._execute(step, label, info);
    // A retry changes something: it waits twice as long for the element.
    for (let attempt = 1; !res.ok && !res.noRetry && !this._stopped && attempt <= (this._plan.retries || 0); attempt++) {
      this.hooks.onRetry?.({ ...info, block: step, attempt, error: res.error });
      res = await this._execute({ ...step, timeout: Math.min(step.timeout * 2 ** attempt, 240000) }, label, info);
    }
    if (this._stopped) return res;
    // Time spent paused isn't the step's fault, so it isn't counted.
    const ms = Math.round(performance.now() - t0 - (this._pausedMs - paused0));
    if (!res.inner) this.hooks.onStepDone?.({ ...info, block: step, ok: res.ok, error: res.error, ms, loadMs: res.loadMs, rows: res.rows, opened: res.opened });
    if (!res.ok) {
      this.hooks.onStepError?.(info.blockId, res.error, info.run);
      return res;
    }
    const wait = waitAfterMs(step);
    if (wait) await this._countdown(wait, info);
    return res;
  }

  // Pause takes effect at once: the current step's element wait freezes
  // (its clock too) and the plan holds before the next step.
  pause() {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this._pausedAt = performance.now();
    this._page('pause', true);
    this._emitStatus();
  }

  resume() {
    if (this.status !== 'paused') return;
    this.status = 'running';
    this._pausedMs += performance.now() - this._pausedAt;
    this._page('pause', false);
    this._emitStatus();
    this._wake?.();
  }

  // Stop takes effect at once: whatever the runner is waiting on is
  // abandoned, and the page's current step is told to give up.
  stop() {
    if (!this.busy || this._stopped) return;
    this._stopped = true;
    if (this.status === 'paused') this._pausedMs += performance.now() - this._pausedAt;
    this._onStop();
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

  // A step's "Then wait": counts down, holds while paused, ends at once on Stop.
  async _countdown(ms, info) {
    let left = ms;
    while (left > 0 && (await this._checkpoint())) {
      this.hooks.onWait?.({ ...info, left });
      const t0 = performance.now();
      await this._sleep(Math.min(left, 1000));
      if (this.status !== 'paused') left -= performance.now() - t0;
    }
    this.hooks.onWait?.({ ...info, left: 0 });
  }

  _sleep(ms) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this._wake = done;
    });
  }

  // Resolves with the promise's value, but rejects with Stopped as soon as
  // Stop is pressed, or with Hung after `limit` ms (paused time not counted).
  async _guard(promise, limit = 0) {
    let timer;
    const started = performance.now();
    const paused0 = this._pausedMs;
    const hung = new Promise((_, reject) => {
      const check = () => {
        const left = limit - (performance.now() - started - (this._pausedMs - paused0));
        if (this.status === 'paused') timer = setTimeout(check, 250);
        else if (left > 0) timer = setTimeout(check, left);
        else reject(new Hung());
      };
      if (limit) timer = setTimeout(check, limit);
    });
    const stopped = this._stopSignal.then(() => { throw new Stopped(); });
    stopped.catch(() => {}); // may reject after the race is already settled
    try {
      return await Promise.race([promise, stopped, hung]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Calls window.__clickflow[method] in the page, injecting actions.js only
  // when this page doesn't have it yet (once per page load, not per step).
  // injectImmediately: steps wait for their own elements, so there's no
  // reason to wait for Chrome's "document idle" (after images and ads).
  // Each call also carries the pause state, in case Pause was pressed while
  // actions.js was still being injected.
  async _callPage(method, args, limit) {
    const target = { tabId: this.tabId };
    const call = () => this._guard(chrome.scripting.executeScript({
      target,
      injectImmediately: true,
      func: (m, a, paused) => {
        const cf = window.__clickflow;
        if (!cf) return { missing: true };
        cf.pause(paused);
        return cf[m](...a);
      },
      args: [method, args, this.status === 'paused'],
    }), limit);
    let [res] = await call();
    if (res?.result?.missing) {
      await this._guard(chrome.scripting.executeScript({ target, injectImmediately: true, files: [ACTIONS_FILE] }), limit);
      [res] = await call();
    }
    const result = res?.result ?? { ok: false, error: t('The page did not respond.') };
    // Page-side errors come back as { key, vars } so they can be translated here.
    if (result.error && typeof result.error === 'object') result.error = t(result.error.key, result.error.vars);
    return result;
  }

  async _execute(block, label, info) {
    if (block.type === 'wait' && block.mode === 'time') {
      await this._sleep(block.ms);
      return { ok: true };
    }
    if (block.type === 'screenshot') return this._screenshot(block, label, info);
    if (block.type === 'rows') return this._rows(block, label, info);
    this._navigating = false;
    // Select steps can wait for the opener, then the list, then scroll.
    const limit = block.timeout * (block.type === 'select' ? 3 : 1) + CALL_SLACK_MS;
    try {
      let result;
      try {
        result = await this._callPage('run', [block, label], limit);
      } catch (e) {
        // The previous step's navigation can still be tearing the old page
        // down, or the page froze; wait for a ready page and try once more.
        if (e instanceof Stopped || !(e instanceof Hung || /frame|navigat|document|closed|context/i.test(e.message))) throw e;
        await this._settle(null);
        result = await this._callPage('run', [block, label], limit);
      }
      if (result.ok && block.type === 'type' && block.enter) {
        // A navigation triggered by Enter can tear the frame down mid-call; that's success.
        await this._guard(chrome.scripting.executeScript({
          target: { tabId: this.tabId }, world: 'MAIN', injectImmediately: true, func: pressEnterInPage, args: [block.selector],
        }), CALL_SLACK_MS).catch((e) => { if (e instanceof Stopped) throw e; });
      }
      if (result.ok && result.href) {
        await this._openTab(result.href);
        return { ...result, opened: true };
      }
      // Only steps that can trigger a navigation pay for the navigation check.
      const canNavigate = block.type === 'click' || block.type === 'select' || (block.type === 'type' && block.enter);
      if (canNavigate) result.loadMs = await this._settle(result.doc);
      return result;
    } catch (e) {
      if (e instanceof Stopped) return { ok: false, error: t('Stopped.') };
      if (e instanceof Hung) return { ok: false, error: t('The page stopped responding. Try reloading it.') };
      return { ok: false, error: friendlyError(e.message) };
    }
  }

  // If the step started a navigation (seen as a "loading" tab update), wait
  // until the new page's content is ready, and return the ms spent waiting.
  // This doesn't wait for every image, ad and tracker to finish (the tab's
  // "complete" status), which can take 30 s or more on busy sites.
  // `doc` is the id of the page the step ran in; null means any page will do.
  async _settle(doc) {
    const t0 = performance.now();
    const probe = () => this._guard(chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      injectImmediately: true,
      func: () => ({ doc: window.__clickflow?.doc ?? null, state: document.readyState }),
    }), 1000).then(([r]) => r?.result, (e) => { if (e instanceof Stopped) throw e; return null; });
    for (let waited = 0; doc && !this._navigating && waited < NAV_GRACE_MS; waited += 10) await sleepMs(10);
    if (doc && !this._navigating) {
      if ((await chrome.tabs.get(this.tabId)).status !== 'loading') return 0;
      // The tab can say "loading" only because the page is still fetching
      // images; if the step's own page is still there, carry on.
      const page = await probe();
      if (page?.doc === doc && page.state !== 'loading') return 0;
    }
    let waited = 0;
    while (waited < PAGE_LOAD_MAX_MS) {
      const t = performance.now();
      if (this.status !== 'paused') {
        if ((await chrome.tabs.get(this.tabId)).status === 'complete') break;
        // A different page whose HTML has been read is ready for the next step.
        const page = await probe();
        if (page && page.state !== 'loading' && (!doc || page.doc !== doc)) break;
      }
      await this._guard(sleepMs(100));
      if (this.status !== 'paused') waited += performance.now() - t;
    }
    this._navigating = false;
    return Math.round(performance.now() - t0);
  }

  async _screenshot(block, label, info) {
    try {
      const tab = await chrome.tabs.get(this.tabId);
      if (!tab.active) return { ok: false, error: t('Switch to the tab being automated: screenshots capture the visible tab.') };
      let crop = null;
      if (block.selector) {
        const m = await this._callPage('measure', [block], block.timeout + CALL_SLACK_MS);
        if (!m.ok) return m;
        crop = m;
      }
      await this._page('setBadge', false); // keep the badge out of the picture
      const wait = this._lastCapture + CAPTURE_GAP_MS - Date.now();
      if (wait > 0) await this._guard(sleepMs(wait));
      let dataUrl;
      try {
        dataUrl = await this._guard(chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }));
      } finally {
        this._lastCapture = Date.now();
        if (!this._stopped) this._page('setBadge', true, label);
      }
      let blob = await (await fetch(dataUrl)).blob();
      if (crop) blob = await cropImage(blob, crop);
      this.hooks.onScreenshot?.({ ...info, name: block.name || `screenshot-${info.run + 1}`, blob });
      return { ok: true };
    } catch (e) {
      if (e instanceof Stopped) return { ok: false, error: t('Stopped.') };
      if (e instanceof Hung) return { ok: false, error: t('The page stopped responding. Try reloading it.') };
      return { ok: false, error: /permission|activeTab|all_urls/i.test(e.message)
        ? t("ClickFlow isn't allowed to capture this page. Allow it on this site and try again.")
        : friendlyError(e.message) };
    }
  }

  // "For each row": the page makes the next row that passes the rule the
  // current row, then the steps inside the loop run in that row.
  async _rows(block, label, info) {
    const token = Math.random().toString(36).slice(2);
    let count = 0;
    try {
      while (count < block.max) {
        if (!(await this._checkpoint())) throw new Stopped();
        const res = await this._callPage('nextRow', [block, label, token, count === 0], block.timeout * 3 + CALL_SLACK_MS);
        // Rows already handled must not be handled again by a retry.
        if (!res.ok) return count ? { ...res, noRetry: true, error: t('Row {n}: {error}', { n: count + 1, error: res.error }) } : res;
        if (res.done) break;
        count++;
        this.hooks.onRow?.({ ...info, n: count, label: res.label });
        for (let i = 0; i < block.steps.length; i++) {
          if (!(await this._checkpoint())) throw new Stopped();
          const inner = { ...block.steps[i], rowJob: token };
          const r = await this._runStep(inner, { ...info, blockId: inner.id, row: count, sub: i, subs: block.steps.length });
          if (this._stopped) throw new Stopped();
          // The inner step is already logged and marked; this ends the loop.
          if (!r.ok) return { ok: false, noRetry: true, inner: true, error: t('Row {n}: {error}', { n: count, error: r.error }) };
          if (i < block.steps.length - 1) await this._sleep(this._plan.stepDelay);
        }
      }
      return { ok: true, rows: count };
    } catch (e) {
      if (e instanceof Stopped) return { ok: false, error: t('Stopped.') };
      if (e instanceof Hung) return { ok: false, error: t('The page stopped responding. Try reloading it.') };
      return { ok: false, error: friendlyError(e.message) };
    }
  }

  // A web link from a row: a background tab next to the list's tab.
  async _openTab(url) {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error(t('ClickFlow only opens web links.'));
    const tab = await chrome.tabs.get(this.tabId);
    await this._guard(chrome.tabs.create({ url, active: false, windowId: tab.windowId, openerTabId: this.tabId, index: tab.index + 1 + this._opened++ }));
  }

  // Fire-and-forget page calls (badge, pause, abort). Bounded so a frozen
  // page can't hold anything up.
  async _page(method, ...args) {
    if (this.tabId == null) return;
    try {
      await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: this.tabId },
          injectImmediately: true,
          func: (m, a) => window.__clickflow?.[m]?.(...a),
          args: [method, args],
        }),
        sleepMs(2000),
      ]);
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
