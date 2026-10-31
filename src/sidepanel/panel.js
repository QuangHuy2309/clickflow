import { BLOCK_TYPES, LIMITS, isShown, newBlock, newId, newPlan, validateBlock } from '../shared/schema.js';
import { parseDataList } from '../shared/data.js';
import { BLOCK_UI, summarize } from './blocks.js';
import { h, icon } from './dom.js';
import { exportPlan, flushState, loadState, readImportFile, saveState } from './storage.js';
import { getAccess, friendlyError } from './site.js';
import { Runner } from './runner.js';

const $ = (id) => document.getElementById(id);

const state = {
  plans: [],
  currentId: null,
  tab: null,
  access: { kind: 'none' },
  pick: null,
  run: { status: 'idle', blockId: null, errors: {} },
};

const plan = () => state.plans.find((p) => p.id === state.currentId);
const save = () => saveState(state);

// ---------- Toasts & modal ----------

function toast(message, kind = 'info', ms = 3200) {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  $('toasts').append(el);
  while ($('toasts').childElementCount > 3) $('toasts').firstElementChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
}

function modal({ title, message, list, input, confirm = 'OK', danger = false }) {
  const dlg = $('modal');
  return new Promise((resolve) => {
    const field = input != null ? h('input', { type: 'text', value: input, maxLength: LIMITS.name, 'aria-label': title }) : null;
    const finish = (ok) => {
      dlg.close();
      resolve(ok ? (field ? field.value.trim() : true) : null);
    };
    const form = h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); finish(true); } },
      h('h3', {}, title),
      message && h('p', {}, message),
      list && h('ul', { class: 'modal-list' }, list.map((t) => h('li', {}, t))),
      field,
      h('div', { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => finish(false) }, 'Cancel'),
        h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}` }, confirm)));
    dlg.replaceChildren(form);
    dlg.oncancel = (e) => { e.preventDefault(); finish(false); };
    dlg.showModal();
    (field || form.querySelector('[type=submit]')).focus();
    field?.select();
  });
}

// ---------- Plans ----------

function renderPlanSelect() {
  const sel = $('planSelect');
  sel.replaceChildren(...state.plans.map((p) => h('option', { value: p.id }, p.name)));
  sel.value = state.currentId;
}

function switchPlan(id) {
  if (runner.busy) return;
  state.currentId = id;
  state.run.errors = {};
  save();
  renderAll();
}

function uniqueName(base) {
  const names = new Set(state.plans.map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} (${i})`)) return `${base} (${i})`;
}

function addPlan(p) {
  if (state.plans.length >= LIMITS.plans) {
    toast(`You can keep up to ${LIMITS.plans} plans.`, 'error');
    return false;
  }
  p.name = uniqueName(p.name);
  state.plans.push(p);
  switchPlan(p.id);
  return true;
}

async function planAction(action) {
  const p = plan();
  switch (action) {
    case 'new': {
      const name = await modal({ title: 'New plan', input: 'Untitled plan', confirm: 'Create' });
      if (name) addPlan(newPlan(name));
      break;
    }
    case 'rename': {
      const name = await modal({ title: 'Rename plan', input: p.name, confirm: 'Rename' });
      if (name) { p.name = name; save(); renderPlanSelect(); }
      break;
    }
    case 'duplicate': {
      const copy = structuredClone(p);
      copy.id = newId();
      copy.name = `${p.name} copy`;
      copy.blocks.forEach((b) => { b.id = newId(); });
      if (addPlan(copy)) toast('Plan duplicated.', 'ok');
      break;
    }
    case 'export':
      exportPlan(p);
      break;
    case 'import':
      $('importFile').click();
      break;
    case 'delete': {
      const ok = await modal({
        title: `Delete “${p.name}”?`,
        message: 'This removes the plan and all its steps. This cannot be undone.',
        confirm: 'Delete',
        danger: true,
      });
      if (!ok) break;
      state.plans = state.plans.filter((x) => x.id !== p.id);
      if (!state.plans.length) state.plans.push(newPlan('My first plan'));
      switchPlan(state.plans[0].id);
      toast('Plan deleted.');
      break;
    }
  }
}

async function onImportFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { plan: imported, dropped } = await readImportFile(file);
    const counts = Object.entries(imported.blocks.reduce((acc, b) => {
      acc[BLOCK_TYPES[b.type].label] = (acc[BLOCK_TYPES[b.type].label] || 0) + 1;
      return acc;
    }, {})).map(([label, n]) => `${n} × ${label}`);
    const ok = await modal({
      title: `Import “${imported.name}”?`,
      message: `${imported.blocks.length} step(s). Review the steps before running, and only import plans from people you trust.`
        + (dropped ? ` ${dropped} unsupported step(s) were removed.` : ''),
      list: counts,
      confirm: 'Import',
    });
    if (ok && addPlan(imported)) toast('Plan imported.', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- Blocks ----------

let dragId = null;
let dropTarget = null;

function renderBlocks() {
  const p = plan();
  const list = $('blockList');
  list.replaceChildren(...p.blocks.map((b, i) => blockCard(b, i, p.blocks.length)));
  $('emptyState').hidden = p.blocks.length > 0;
  const enabled = p.blocks.filter((b) => b.enabled).length;
  $('stepCount').textContent = p.blocks.length ? `${enabled}/${p.blocks.length} on` : '';
  $('stepCount').hidden = !p.blocks.length;
}

function rerenderBlock(id) {
  const p = plan();
  const i = p.blocks.findIndex((b) => b.id === id);
  const old = $('blockList').querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (i < 0 || !old) return;
  old.replaceWith(blockCard(p.blocks[i], i, p.blocks.length));
}

function blockCard(b, index, total) {
  const def = BLOCK_TYPES[b.type];
  const ui = BLOCK_UI[b.type];
  const error = state.run.errors[b.id];
  const classes = ['block', `t-${b.type}`];
  if (!b.enabled) classes.push('disabled');
  if (error) classes.push('is-error');
  if (state.run.blockId === b.id) classes.push('is-running');

  const li = h('li', { class: classes.join(' '), dataset: { id: b.id } });

  const grip = h('button', {
    class: 'icon-btn grip',
    title: 'Drag to reorder (or focus and press ↑ / ↓)',
    'aria-label': `Reorder step ${index + 1} with the arrow keys`,
    onkeydown: (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveBy(b.id, e.key === 'ArrowUp' ? -1 : 1);
      }
    },
  }, icon('grip'));

  const del = h('button', { class: 'icon-btn danger', title: 'Delete step', 'aria-label': 'Delete step' }, icon('trash'));
  let confirmTimer;
  del.addEventListener('click', () => {
    if (del.classList.contains('confirm-delete')) return removeBlock(b.id);
    del.classList.add('confirm-delete');
    del.replaceChildren('Delete?');
    confirmTimer = setTimeout(() => { del.classList.remove('confirm-delete'); del.replaceChildren(icon('trash')); }, 2500);
  });
  del.addEventListener('blur', () => {
    clearTimeout(confirmTimer);
    del.classList.remove('confirm-delete');
    del.replaceChildren(icon('trash'));
  });

  const head = h('div', { class: 'block-head' },
    grip,
    h('span', { class: 'step-no' }, index + 1),
    h('span', { class: 'type-icon' }, icon(ui.icon)),
    h('button', {
      class: 'block-title',
      'aria-expanded': String(!b.collapsed),
      title: b.collapsed ? 'Show details' : 'Hide details',
      onclick: () => { b.collapsed = !b.collapsed; save(); rerenderBlock(b.id); },
    }, h('strong', {}, def.label), h('span', { class: 'summary' }, summarize(b))),
    h('label', { class: 'switch', title: b.enabled ? 'Enabled' : 'Disabled' },
      h('input', {
        type: 'checkbox',
        checked: b.enabled,
        'aria-label': 'Enable step',
        onchange: (e) => { b.enabled = e.target.checked; save(); renderBlocks(); },
      }),
      h('span')),
    h('div', { class: 'block-actions' },
      h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', disabled: index === 0, onclick: () => moveBy(b.id, -1) }, icon('up')),
      h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', disabled: index === total - 1, onclick: () => moveBy(b.id, 1) }, icon('down')),
      h('button', { class: 'icon-btn', title: 'Duplicate', 'aria-label': 'Duplicate step', onclick: () => duplicateBlock(b.id) }, icon('copy')),
      del));

  li.append(head);
  if (error) li.append(h('div', { class: 'block-error', role: 'alert' }, icon('alert', 14), h('span', {}, error)));
  if (!b.collapsed) {
    li.append(h('div', { class: 'block-body' },
      def.fields.filter((f) => isShown(f, b)).map((f) => fieldControl(b, f, li))));
  }

  // Only the header drags, so text in the fields below stays selectable.
  head.draggable = true;
  head.addEventListener('dragstart', (e) => {
    dragId = b.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', b.id);
    e.dataTransfer.setDragImage(li, 24, 20);
    requestAnimationFrame(() => li.classList.add('dragging'));
  });
  head.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    dragId = null;
    clearDropMarks();
  });
  return li;
}

function fieldControl(b, f, card) {
  const id = `f-${b.id}-${f.key}`;
  const update = (value) => {
    b[f.key] = value;
    delete state.run.errors[b.id];
    card.classList.remove('is-error');
    card.querySelector('.block-error')?.remove();
    card.querySelector('.summary').textContent = summarize(b);
    save();
  };

  if (f.kind === 'bool') {
    return h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: b[f.key], onchange: (e) => update(e.target.checked) }),
      f.label);
  }

  let control;
  switch (f.kind) {
    case 'selector': {
      const input = h('input', {
        id, type: 'text', class: 'mono', value: b[f.key], maxLength: f.maxLen,
        placeholder: 'CSS selector, e.g. #submit or button.primary', spellcheck: 'false', autocomplete: 'off',
        oninput: (e) => update(e.target.value),
      });
      const picking = state.pick?.blockId === b.id && state.pick?.key === f.key;
      const pick = h('button', {
        type: 'button',
        class: `pick-btn${picking ? ' active' : ''}`,
        title: 'Click an element on the page to fill this in',
        onclick: () => togglePick(b, f),
      }, icon('target', 14), picking ? 'Picking…' : 'Pick');
      control = h('div', { class: 'input-group' }, input, pick);
      break;
    }
    case 'text':
      control = h('input', { id, type: 'text', value: b[f.key], maxLength: f.maxLen, oninput: (e) => update(e.target.value) });
      break;
    case 'textarea':
      control = h('textarea', { id, rows: 2, value: b[f.key], maxLength: f.maxLen, oninput: (e) => update(e.target.value) });
      break;
    case 'number':
      control = h('input', {
        id, type: 'number', value: String(b[f.key]), min: f.min, max: f.max,
        onchange: (e) => {
          const n = Number(e.target.value);
          const v = Number.isFinite(n) && e.target.value !== '' ? Math.min(f.max, Math.max(f.min, Math.round(n))) : f.default;
          e.target.value = String(v);
          update(v);
        },
      });
      break;
    case 'enum':
      control = h('select', {
        id,
        onchange: (e) => { update(e.target.value); rerenderBlock(b.id); },
      }, f.options.map((o) => h('option', { value: o.value, selected: o.value === b[f.key] }, o.label)));
      break;
  }
  return h('div', { class: 'field' }, h('label', { for: id }, f.label), control, f.hint && h('small', {}, f.hint));
}

function addBlock(type) {
  const p = plan();
  if (p.blocks.length >= LIMITS.blocks) return toast(`A plan can have up to ${LIMITS.blocks} steps.`, 'error');
  const b = newBlock(type);
  p.blocks.push(b);
  save();
  renderBlocks();
  const card = $('blockList').lastElementChild;
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card.querySelector('.block-body input, .block-body select')?.focus({ preventScroll: true });
}

function removeBlock(id) {
  const p = plan();
  p.blocks = p.blocks.filter((b) => b.id !== id);
  delete state.run.errors[id];
  save();
  renderBlocks();
}

function duplicateBlock(id) {
  const p = plan();
  if (p.blocks.length >= LIMITS.blocks) return toast(`A plan can have up to ${LIMITS.blocks} steps.`, 'error');
  const i = p.blocks.findIndex((b) => b.id === id);
  p.blocks.splice(i + 1, 0, { ...structuredClone(p.blocks[i]), id: newId() });
  save();
  renderBlocks();
}

function focusGrip(id) {
  $('blockList').querySelector(`[data-id="${CSS.escape(id)}"] .grip`)?.focus();
}

function moveBy(id, delta) {
  const blocks = plan().blocks;
  const from = blocks.findIndex((b) => b.id === id);
  const to = from + delta;
  if (to < 0 || to >= blocks.length) return;
  blocks.splice(to, 0, blocks.splice(from, 1)[0]);
  save();
  renderBlocks();
  focusGrip(id);
}

function moveTo(id, targetId, after) {
  const blocks = plan().blocks;
  const [moved] = blocks.splice(blocks.findIndex((b) => b.id === id), 1);
  const at = blocks.findIndex((b) => b.id === targetId) + (after ? 1 : 0);
  blocks.splice(at, 0, moved);
  save();
  renderBlocks();
}

function clearDropMarks() {
  for (const el of $('blockList').querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  dropTarget = null;
}

function setupDragAndDrop() {
  const list = $('blockList');
  list.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const card = e.target.closest('.block');
    if (!card || card.dataset.id === dragId) return;
    const r = card.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (dropTarget?.id === card.dataset.id && dropTarget.after === after) return;
    clearDropMarks();
    card.classList.add(after ? 'drop-after' : 'drop-before');
    dropTarget = { id: card.dataset.id, after };
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragId && dropTarget) moveTo(dragId, dropTarget.id, dropTarget.after);
    clearDropMarks();
  });
}

function buildAddMenu() {
  const menu = $('addMenu');
  menu.replaceChildren(...Object.entries(BLOCK_TYPES).map(([type, def]) =>
    h('button', { role: 'menuitem', class: `t-${type}`, onclick: () => { closeMenus(); addBlock(type); } },
      h('span', { class: 'type-icon' }, icon(BLOCK_UI[type].icon)),
      h('span', { class: 'add-label' }, h('strong', {}, def.label), h('small', {}, BLOCK_UI[type].desc)))));
}

// ---------- Menus ----------

function toggleMenu(btn, menu) {
  const open = menu.hidden;
  closeMenus();
  if (!open) return;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  menu.scrollIntoView({ block: 'nearest' });
  menu.querySelector('button')?.focus({ preventScroll: true });
}

function closeMenus() {
  for (const [btn, menu] of [['planMenuBtn', 'planMenu'], ['addBtn', 'addMenu']]) {
    $(menu).hidden = true;
    $(btn).setAttribute('aria-expanded', 'false');
  }
}

// ---------- Data & settings ----------

function renderData() {
  const p = plan();
  $('dataInput').value = p.data;
  for (const btn of $('splitMode').children) btn.setAttribute('aria-checked', String(btn.dataset.value === p.splitMode));
  updateRunCount();
}

function updateRunCount() {
  const p = plan();
  const rows = parseDataList(p.data, p.splitMode).length;
  $('runCount').textContent = rows ? `${rows} run${rows === 1 ? '' : 's'}` : `${p.repeat} run${p.repeat === 1 ? '' : 's'} · no data`;
}

function renderSettings() {
  const p = plan();
  $('stepDelay').value = p.stepDelay;
  $('runDelay').value = p.runDelay;
  $('repeat').value = p.repeat;
  $('onError').value = p.onError;
}

function bindSettings() {
  const nums = { stepDelay: [0, 60000], runDelay: [0, 600000], repeat: [1, LIMITS.runs] };
  for (const [key, [min, max]] of Object.entries(nums)) {
    $(key).addEventListener('change', (e) => {
      const n = Math.round(Number(e.target.value));
      const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : plan()[key];
      e.target.value = v;
      plan()[key] = v;
      save();
      updateRunCount();
    });
  }
  $('onError').addEventListener('change', (e) => { plan().onError = e.target.value; save(); });
  $('dataInput').maxLength = LIMITS.data;
  $('dataInput').addEventListener('input', (e) => { plan().data = e.target.value; save(); updateRunCount(); });
  $('splitMode').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.value;
    if (!v) return;
    plan().splitMode = v;
    save();
    renderData();
  });
}

// ---------- Site access ----------

async function refreshTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  state.tab = tab || null;
  state.access = await getAccess(state.tab);
  renderBanner();
}

function renderBanner() {
  const banner = $('siteBanner');
  const chip = $('siteChip');
  const a = state.access;
  chip.hidden = a.kind !== 'granted';
  chip.textContent = a.kind === 'granted' ? `Active on ${a.host}` : '';

  const content = {
    needs: () => [h('p', {}, 'Allow ClickFlow to run on ', h('strong', {}, a.host), '? It only acts when you press Run or Pick.'),
      h('button', { class: 'btn btn-primary btn-small', onclick: requestSiteAccess }, 'Allow')],
    unknown: () => [h('p', {}, "ClickFlow can't see this tab yet. Click the ClickFlow toolbar icon while on the page to grant access."),
      h('button', { class: 'btn btn-ghost btn-small', onclick: requestAllSites, title: 'Grant access to every site' }, 'Allow all sites')],
    restricted: () => [h('p', {}, "Chrome doesn't allow extensions to run on this page. Switch to a regular website.")],
    'file-blocked': () => [h('p', {}, 'To use ClickFlow on local files, turn on "Allow access to file URLs" in the extension\'s details page.')],
  }[a.kind];

  banner.hidden = !content;
  if (content) banner.replaceChildren(icon(a.kind === 'needs' ? 'shield' : 'alert', 18), ...content());
}

// Must be called directly from a click handler so Chrome sees the user gesture.
function requestSiteAccess() {
  const a = state.access;
  if (a.kind === 'granted') return Promise.resolve(true);
  if (a.kind !== 'needs') {
    toast(a.kind === 'unknown' ? 'Grant access to this page first (see the banner above).' : "ClickFlow can't run on this page.", 'error');
    return Promise.resolve(false);
  }
  return chrome.permissions.request({ origins: [a.pattern] }).then(async (ok) => {
    await refreshTab();
    if (!ok) toast('Access not granted.', 'error');
    return ok;
  });
}

function requestAllSites() {
  chrome.permissions.request({ origins: ['<all_urls>'] }).then(refreshTab);
}

function watchTabs() {
  chrome.tabs.onActivated.addListener(refreshTab);
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === state.tab?.id && (info.url || info.status === 'complete')) refreshTab();
  });
  chrome.windows.onFocusChanged.addListener((id) => { if (id !== chrome.windows.WINDOW_ID_NONE) refreshTab(); });
  chrome.permissions.onAdded.addListener(refreshTab);
  chrome.permissions.onRemoved.addListener(refreshTab);
}

// ---------- Element picker ----------

function togglePick(b, f) {
  if (state.pick?.blockId === b.id && state.pick?.key === f.key) return cancelPick(true);
  if (runner.busy) return;
  const tab = state.tab;
  requestSiteAccess().then(async (ok) => {
    if (!ok || !tab) return;
    await cancelPick(true);
    const requestId = newId();
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/picker.js'] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (id) => window.__clickflowPicker.start(id),
        args: [requestId],
      });
      state.pick = { requestId, tabId: tab.id, blockId: b.id, key: f.key };
      rerenderBlock(b.id);
      toast('Click an element on the page. Esc cancels.');
    } catch (e) {
      toast(friendlyError(e.message), 'error');
    }
  });
}

async function cancelPick(notifyPage) {
  const pick = state.pick;
  if (!pick) return;
  state.pick = null;
  rerenderBlock(pick.blockId);
  if (notifyPage) {
    await chrome.scripting.executeScript({
      target: { tabId: pick.tabId },
      func: () => window.__clickflowPicker?.stop(),
    }).catch(() => {});
  }
}

function onPicked(msg) {
  const pick = state.pick;
  if (!pick || msg.requestId !== pick.requestId) return;
  state.pick = null;
  const p = plan();
  const b = p.blocks.find((x) => x.id === pick.blockId);
  if (!b) return;
  if (msg.type === 'cf-picked' && typeof msg.selector === 'string') {
    b[pick.key] = msg.selector.slice(0, LIMITS.selector);
    delete state.run.errors[b.id];
    save();
    rerenderBlock(b.id);
    const input = $(`f-${b.id}-${pick.key}`);
    input?.classList.add('picked');
    toast('Element selected.', 'ok', 1800);
  } else {
    rerenderBlock(b.id);
  }
}

// ---------- Running ----------

const runner = new Runner({
  onStatus(status) {
    state.run.status = status;
    if (status === 'idle') state.run.blockId = null;
    renderRunbar();
    renderBlocks();
  },
  onProgress({ run, runs, step, steps, blockId }) {
    state.run.blockId = blockId;
    for (const el of $('blockList').querySelectorAll('.is-running')) el.classList.remove('is-running');
    $('blockList').querySelector(`[data-id="${CSS.escape(blockId)}"]`)?.classList.add('is-running');
    $('runStatus').textContent = `Run ${run + 1}/${runs} · Step ${step + 1}/${steps}`;
    $('progressFill').style.width = `${((run * steps + step) / (runs * steps)) * 100}%`;
  },
  onStepError(blockId, message, run) {
    state.run.errors[blockId] = run != null ? `Run ${run + 1}: ${message}` : message;
    rerenderBlock(blockId);
  },
  onDone({ runs, ok, failed, stopped }) {
    $('progressFill').style.width = stopped ? '0%' : '100%';
    const text = stopped ? `Stopped after ${ok} of ${runs} run(s)`
      : failed ? `Finished: ${ok} ok, ${failed} failed`
        : `Done: ${ok} run${ok === 1 ? '' : 's'} completed`;
    $('runStatus').textContent = text;
    toast(text, failed ? 'error' : stopped ? 'info' : 'ok');
  },
});

function renderRunbar() {
  const s = state.run.status;
  const busy = s !== 'idle';
  $('main').classList.toggle('locked', busy);
  $('planSelect').disabled = busy;
  $('planMenuBtn').disabled = busy;
  $('runBtn').hidden = busy;
  $('pauseBtn').hidden = !busy;
  $('stopBtn').hidden = !busy;
  $('pauseBtn').replaceChildren(icon(s === 'paused' ? 'play' : 'pause', 14), s === 'paused' ? 'Resume' : 'Pause');
  if (s === 'paused') $('runStatus').textContent = 'Paused';
  if (!busy && !$('runStatus').textContent) $('runStatus').textContent = 'Ready';
}

function startRun() {
  if (runner.busy) return;
  const tab = state.tab;
  requestSiteAccess().then((ok) => {
    if (!ok || !tab) return;
    cancelPick(true);
    state.run.errors = {};
    $('progressFill').style.width = '0%';
    $('runStatus').textContent = 'Starting…';
    runner.start(structuredClone(plan()), tab.id).catch((e) => {
      $('runStatus').textContent = 'Ready';
      toast(e.message, 'error', 4500);
    });
  });
}

// ---------- Init ----------

function renderAll() {
  renderPlanSelect();
  renderBlocks();
  renderData();
  renderSettings();
  renderRunbar();
}

async function init() {
  Object.assign(state, await loadState());

  $('planMenuBtn').append(icon('more'));
  $('addBtn').append(icon('plus', 14), 'Add step');
  $('runBtn').append(icon('play', 14), 'Run');
  $('stopBtn').append(icon('stop', 14), 'Stop');
  $('privacyIcon').replaceWith(icon('shield'));
  buildAddMenu();

  $('planSelect').addEventListener('change', (e) => switchPlan(e.target.value));
  $('planMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('planMenuBtn'), $('planMenu')); });
  $('planMenu').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    closeMenus();
    planAction(action);
  });
  $('importFile').addEventListener('change', onImportFile);
  $('addBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('addBtn'), $('addMenu')); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  $('runBtn').addEventListener('click', startRun);
  $('stopBtn').addEventListener('click', () => runner.stop());
  $('pauseBtn').addEventListener('click', () => (state.run.status === 'paused' ? runner.resume() : runner.pause()));

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return;
    if (msg.type === 'cf-picked' || msg.type === 'cf-pick-cancel') onPicked(msg);
    else if (msg.type === 'cf-stop' && sender.tab?.id === runner.tabId) runner.stop();
  });

  bindSettings();
  setupDragAndDrop();
  watchTabs();
  window.addEventListener('pagehide', flushState);

  renderAll();
  await refreshTab();
}

init();
