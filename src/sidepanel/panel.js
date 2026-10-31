import { BLOCK_TYPES, LIMITS, isShown, newBlock, newId, newPlan, sanitizeBlock } from '../shared/schema.js';
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
  rec: null,
  run: { status: 'idle', blockId: null, errors: {} },
};

const plan = () => state.plans.find((p) => p.id === state.currentId);
const save = () => saveState(state);
const busy = () => runner.busy || Boolean(state.rec);

// ---------- Toasts & modal ----------

function toast(message, kind = 'info', ms = 3200) {
  const box = $('toasts');
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(el);
  while (box.childElementCount > 3) box.firstElementChild.remove();
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

// ---------- Tabs ----------

const TABS = ['steps', 'data', 'settings'];

function showTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`tab-${t}`).tabIndex = t === name ? 0 : -1;
    $(`panel-${t}`).hidden = t !== name;
  }
  closeMenus();
}

function bindTabs() {
  for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => showTab(t));
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = TABS.findIndex((t) => $(`tab-${t}`).getAttribute('aria-selected') === 'true');
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    showTab(next);
    $(`tab-${next}`).focus();
  });
}

// ---------- Plans ----------

function renderPlanSelect() {
  const sel = $('planSelect');
  sel.replaceChildren(...state.plans.map((p) => h('option', { value: p.id }, p.name)));
  sel.value = state.currentId;
}

function switchPlan(id) {
  if (busy()) return;
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

// ---------- Steps ----------

let dragId = null;
let dropTarget = null;

function renderBlocks() {
  const p = plan();
  const empty = p.blocks.length === 0;
  $('blockList').replaceChildren(...p.blocks.map((b, i) => blockCard(b, i, p.blocks.length)));
  if (empty && state.rec) {
    $('blockList').append(h('li', { class: 'rec-hint' },
      h('span', { class: 'rec-dot' }),
      h('div', {}, h('strong', {}, 'Listening for your actions…'),
        h('span', { class: 'muted' }, 'Click, type, and choose options on the page. Each action appears here as a step.'))));
  }
  $('emptyState').hidden = !empty || Boolean(state.rec);
  $('addWrap').hidden = empty && !state.rec;
  $('stepCount').textContent = p.blocks.length || '';
  $('runBtn').disabled = empty;
}

function cardFor(id) {
  return $('blockList').querySelector(`[data-id="${CSS.escape(id)}"]`);
}

function rerenderBlock(id) {
  const p = plan();
  const i = p.blocks.findIndex((b) => b.id === id);
  const old = cardFor(id);
  if (i < 0 || !old) return;
  old.replaceWith(blockCard(p.blocks[i], i, p.blocks.length));
}

function blockCard(b, index, total) {
  const def = BLOCK_TYPES[b.type];
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
  }, icon('grip', 14));

  const del = h('button', { class: 'icon-btn danger', title: 'Delete step', 'aria-label': 'Delete step' }, icon('trash', 15));
  let confirmTimer;
  const resetDel = () => { clearTimeout(confirmTimer); del.classList.remove('confirm-delete'); del.replaceChildren(icon('trash', 15)); };
  del.addEventListener('click', () => {
    if (del.classList.contains('confirm-delete')) return removeBlock(b.id);
    del.classList.add('confirm-delete');
    del.replaceChildren('Delete?');
    confirmTimer = setTimeout(resetDel, 2500);
  });
  del.addEventListener('blur', resetDel);

  const head = h('div', { class: 'block-head', draggable: true },
    grip,
    h('span', { class: 'type-icon' }, icon(BLOCK_UI[b.type].icon)),
    h('button', {
      class: 'block-title',
      'aria-expanded': String(!b.collapsed),
      title: b.collapsed ? 'Edit step' : 'Collapse',
      onclick: () => { b.collapsed = !b.collapsed; save(); rerenderBlock(b.id); },
    }, h('strong', {}, def.label), h('span', { class: 'summary' }, summarize(b))),
    h('label', { class: 'switch', title: b.enabled ? 'Enabled' : 'Disabled' },
      h('input', {
        type: 'checkbox',
        checked: b.enabled,
        'aria-label': 'Enable step',
        onchange: (e) => { b.enabled = e.target.checked; save(); rerenderBlock(b.id); },
      }),
      h('span')),
    h('div', { class: 'block-actions' },
      h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', disabled: index === 0, onclick: () => moveBy(b.id, -1) }, icon('up', 15)),
      h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', disabled: index === total - 1, onclick: () => moveBy(b.id, 1) }, icon('down', 15)),
      h('button', { class: 'icon-btn', title: 'Duplicate', 'aria-label': 'Duplicate step', onclick: () => duplicateBlock(b.id) }, icon('copy', 15)),
      del));

  const card = h('div', { class: 'step-card' }, head);
  if (b.note) card.append(h('div', { class: 'step-note' }, icon('shield', 14), h('span', {}, b.note)));
  if (error) card.append(h('div', { class: 'block-error', role: 'alert' }, icon('alert', 14), h('span', {}, error)));
  if (!b.collapsed) {
    card.append(h('div', { class: 'block-body' }, def.fields.filter((f) => isShown(f, b)).map((f) => fieldControl(b, f, li))));
  }
  li.append(h('div', { class: 'rail' }, h('span', { class: 'step-no' }, index + 1)), card);

  head.addEventListener('dragstart', (e) => {
    if (busy()) return e.preventDefault();
    dragId = b.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', b.id);
    e.dataTransfer.setDragImage(card, 24, 20);
    requestAnimationFrame(() => li.classList.add('dragging'));
  });
  head.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    dragId = null;
    clearDropMarks();
  });
  return li;
}

function fieldControl(b, f, li) {
  const id = `f-${b.id}-${f.key}`;
  const update = (value) => {
    b[f.key] = value;
    if (state.run.errors[b.id]) {
      delete state.run.errors[b.id];
      li.classList.remove('is-error');
      li.querySelector('.block-error')?.remove();
    }
    li.querySelector('.summary').textContent = summarize(b);
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
      const picking = state.pick?.blockId === b.id && state.pick?.key === f.key;
      control = h('div', { class: 'input-group' },
        h('input', {
          id, type: 'text', class: 'mono', value: b[f.key], maxLength: f.maxLen,
          placeholder: 'CSS selector, e.g. #submit', spellcheck: 'false', autocomplete: 'off',
          oninput: (e) => update(e.target.value),
        }),
        h('button', {
          type: 'button',
          class: `chip-btn pick-btn${picking ? ' active' : ''}`,
          title: 'Click an element on the page to fill this in',
          onclick: () => togglePick(b, f),
        }, icon('target', 14), picking ? 'Picking…' : 'Pick'));
      break;
    }
    case 'text':
    case 'textarea': {
      const input = f.kind === 'text'
        ? h('input', { id, type: 'text', value: b[f.key], maxLength: f.maxLen, oninput: (e) => update(e.target.value) })
        : h('textarea', { id, rows: 2, value: b[f.key], maxLength: f.maxLen, oninput: (e) => update(e.target.value) });
      control = f.variable && b[f.key] !== '{{value}}'
        ? h('div', { class: 'input-group' }, input, h('button', {
          type: 'button',
          class: 'chip-btn var-btn',
          title: 'Use the data list here: replaces this text with {{value}} and moves it into the data list',
          'aria-label': 'Use data list value',
          onclick: () => makeVariable(b, f),
        }, '{{ }}'))
        : input;
      break;
    }
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

// Turns a recorded literal into {{value}}, seeding the data list with it.
function makeVariable(b, f) {
  const p = plan();
  const old = b[f.key].trim();
  b[f.key] = '{{value}}';
  if (old && !p.data.trim()) {
    p.data = old;
    toast(`“${old}” moved to the Data tab. Add more items there.`, 'ok', 4000);
  } else {
    toast('This step now uses the data list.', 'ok');
  }
  save();
  rerenderBlock(b.id);
  renderData();
}

function addBlock(type) {
  const p = plan();
  if (p.blocks.length >= LIMITS.blocks) return toast(`A plan can have up to ${LIMITS.blocks} steps.`, 'error');
  const b = newBlock(type);
  p.blocks.push(b);
  save();
  renderBlocks();
  const card = cardFor(b.id);
  card.classList.add('just-added');
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
  const copy = { ...structuredClone(p.blocks[i]), id: newId() };
  p.blocks.splice(i + 1, 0, copy);
  save();
  renderBlocks();
  cardFor(copy.id).classList.add('just-added');
}

function moveBy(id, delta) {
  const blocks = plan().blocks;
  const from = blocks.findIndex((b) => b.id === id);
  const to = from + delta;
  if (to < 0 || to >= blocks.length) return;
  blocks.splice(to, 0, blocks.splice(from, 1)[0]);
  save();
  renderBlocks();
  cardFor(id)?.querySelector('.grip')?.focus();
}

function moveTo(id, targetId, after) {
  const blocks = plan().blocks;
  const [moved] = blocks.splice(blocks.findIndex((b) => b.id === id), 1);
  blocks.splice(blocks.findIndex((b) => b.id === targetId) + (after ? 1 : 0), 0, moved);
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
    const li = e.target.closest('.block');
    if (!li || li.dataset.id === dragId) return;
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (dropTarget?.id === li.dataset.id && dropTarget.after === after) return;
    clearDropMarks();
    li.classList.add(after ? 'drop-after' : 'drop-before');
    dropTarget = { id: li.dataset.id, after };
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragId && dropTarget) moveTo(dragId, dropTarget.id, dropTarget.after);
    clearDropMarks();
  });
}

function buildAddMenu() {
  $('addMenu').replaceChildren(...Object.entries(BLOCK_TYPES).map(([type, def]) =>
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
  if ($('dataInput').value !== p.data) $('dataInput').value = p.data;
  for (const btn of $('splitMode').children) btn.setAttribute('aria-checked', String(btn.dataset.value === p.splitMode));
  updateRunCount();
}

function updateRunCount() {
  const p = plan();
  const rows = parseDataList(p.data, p.splitMode);
  $('runCount').textContent = rows.length || '';
  $('runSummary').textContent = rows.length
    ? `${rows.length} run${rows.length === 1 ? '' : 's'}`
    : `No data · runs ${p.repeat}×`;
  const shown = rows.slice(0, 12).map((r, i) => h('span', { class: 'chip', title: r }, h('b', {}, i + 1), r));
  if (rows.length > 12) shown.push(h('span', { class: 'chip more' }, `+${rows.length - 12} more`));
  $('dataPreview').replaceChildren(...shown);
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
  chip.textContent = a.kind === 'granted' ? a.host : '';

  const content = {
    needs: () => [h('p', {}, 'Allow ClickFlow on ', h('strong', {}, a.host), '? It only acts when you press Record, Run or Pick.'),
      h('button', { class: 'btn btn-primary btn-small', onclick: requestSiteAccess }, 'Allow')],
    unknown: () => [h('p', {}, "ClickFlow can't see this tab yet. Click the ClickFlow toolbar icon while on the page."),
      h('button', { class: 'btn btn-ghost btn-small', onclick: requestAllSites, title: 'Grant access to every site' }, 'All sites')],
    restricted: () => [h('p', {}, "Chrome doesn't allow extensions on this page. Switch to a regular website.")],
    'file-blocked': () => [h('p', {}, 'To use ClickFlow on local files, turn on "Allow access to file URLs" in the extension\'s details.')],
  }[a.kind];

  banner.hidden = !content || Boolean(state.rec);
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
    if (tabId === state.rec?.tabId && info.status === 'complete') injectRecorder();
    if (tabId === state.tab?.id && (info.url || info.status === 'complete')) refreshTab();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === state.rec?.tabId) finishRecording();
  });
  chrome.windows.onFocusChanged.addListener((id) => { if (id !== chrome.windows.WINDOW_ID_NONE) refreshTab(); });
  chrome.permissions.onAdded.addListener(refreshTab);
  chrome.permissions.onRemoved.addListener(refreshTab);
}

// ---------- Element picker ----------

function togglePick(b, f) {
  if (state.pick?.blockId === b.id && state.pick?.key === f.key) return cancelPick();
  if (busy()) return;
  const tab = state.tab;
  requestSiteAccess().then(async (ok) => {
    if (!ok || !tab) return;
    await cancelPick();
    const requestId = newId();
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/selector.js', 'src/content/picker.js'] });
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

async function cancelPick() {
  const pick = state.pick;
  if (!pick) return;
  state.pick = null;
  rerenderBlock(pick.blockId);
  await chrome.scripting.executeScript({
    target: { tabId: pick.tabId },
    func: () => window.__clickflowPicker?.stop(),
  }).catch(() => {});
}

function onPicked(msg) {
  const pick = state.pick;
  if (!pick || msg.requestId !== pick.requestId) return;
  state.pick = null;
  const b = plan().blocks.find((x) => x.id === pick.blockId);
  if (!b) return;
  if (msg.type === 'cf-picked' && typeof msg.selector === 'string') {
    b[pick.key] = msg.selector.slice(0, LIMITS.selector);
    delete state.run.errors[b.id];
    save();
    rerenderBlock(b.id);
    $(`f-${b.id}-${pick.key}`)?.classList.add('picked');
    toast('Element selected.', 'ok', 1800);
  } else {
    rerenderBlock(b.id);
  }
}

// ---------- Recording ----------

function startRecording() {
  if (busy()) return;
  const tab = state.tab;
  requestSiteAccess().then(async (ok) => {
    if (!ok || !tab) return;
    await cancelPick();
    state.rec = { id: newId(), tabId: tab.id, added: 0 };
    if (!(await injectRecorder())) return;
    showTab('steps');
    renderAll();
    toast('Recording. Use the page as usual, then press Stop.', 'info', 4000);
  });
}

async function injectRecorder() {
  const rec = state.rec;
  if (!rec) return false;
  try {
    const target = { tabId: rec.tabId };
    await chrome.scripting.executeScript({ target, files: ['src/content/selector.js', 'src/content/recorder.js'] });
    await chrome.scripting.executeScript({ target, func: (id) => window.__clickflowRecorder.start(id), args: [rec.id] });
    return true;
  } catch (e) {
    toast(`Recording stopped: ${friendlyError(e.message)}`, 'error', 5000);
    finishRecording();
    return false;
  }
}

async function stopRecording() {
  const rec = state.rec;
  if (!rec) return;
  // The page flushes any half-typed text on stop, so keep listening briefly.
  await chrome.scripting.executeScript({
    target: { tabId: rec.tabId },
    func: () => window.__clickflowRecorder?.stop(),
  }).catch(() => {});
  setTimeout(finishRecording, 300);
}

function finishRecording() {
  const rec = state.rec;
  if (!rec) return;
  state.rec = null;
  renderAll();
  refreshTab();
  if (rec.added) {
    toast(`Recorded ${rec.added} step${rec.added === 1 ? '' : 's'}. Press {{ }} on a field to use your data list.`, 'ok', 4500);
  }
}

const RECORDABLE = new Set(['click', 'type', 'select']);

function onRecorded(msg, sender) {
  const rec = state.rec;
  if (!rec || msg.sessionId !== rec.id || sender.tab?.id !== rec.tabId) return;
  const raw = msg.step;
  if (!raw || typeof raw !== 'object' || !RECORDABLE.has(raw.type)) return;

  const base = newBlock(raw.type);
  const b = sanitizeBlock({ ...base, ...raw, id: base.id, enabled: true, collapsed: true, note: '' });
  if (!b) return;
  if (raw.secret === true) b.note = 'Sensitive field: its value was not recorded. Type it in this step or use {{value}}.';

  const p = plan();
  const last = p.blocks.at(-1);
  // Consecutive typing into the same field is one step.
  if (b.type === 'type' && last?.type === 'type' && last.selector === b.selector) {
    last.text = b.text;
    last.enter = last.enter || b.enter;
    last.note = b.note;
    save();
    rerenderBlock(last.id);
    cardFor(last.id)?.classList.add('just-added');
    return;
  }
  if (p.blocks.length >= LIMITS.blocks) {
    toast(`A plan can have up to ${LIMITS.blocks} steps. Recording stopped.`, 'error');
    stopRecording();
    return;
  }
  p.blocks.push(b);
  rec.added++;
  save();
  renderBlocks();
  const card = cardFor(b.id);
  card.classList.add('just-added');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('runStatus').textContent = `Recording · ${rec.added} step${rec.added === 1 ? '' : 's'} added`;
}

// ---------- Running ----------

const runner = new Runner({
  onStatus(status) {
    state.run.status = status;
    if (status === 'idle') state.run.blockId = null;
    renderDock();
    renderBlocks();
  },
  onProgress({ run, runs, step, steps, blockId }) {
    state.run.blockId = blockId;
    for (const el of $('blockList').querySelectorAll('.is-running')) el.classList.remove('is-running');
    const card = cardFor(blockId);
    card?.classList.add('is-running');
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

function renderDock() {
  const s = state.run.status;
  const running = s !== 'idle';
  const recording = Boolean(state.rec);
  $('main').classList.toggle('locked', running);
  document.querySelector('.dock').classList.toggle('is-recording', recording);
  $('planSelect').disabled = running || recording;
  $('planMenuBtn').disabled = running || recording;
  $('runBtn').hidden = running || recording;
  $('recordBtn').hidden = running;
  $('pauseBtn').hidden = !running;
  $('stopBtn').hidden = !running;
  $('recordBtn').classList.toggle('recording', recording);
  $('recordBtn').replaceChildren(...(recording ? [icon('stop', 13), 'Stop'] : [icon('record', 14), 'Record']));
  $('recordBtn').title = recording ? 'Stop recording' : 'Record your actions on the page as steps';
  $('pauseBtn').replaceChildren(icon(s === 'paused' ? 'play' : 'pause', 14), s === 'paused' ? 'Resume' : 'Pause');
  if (s === 'paused') $('runStatus').textContent = 'Paused';
  else if (recording) $('runStatus').textContent = `Recording · ${state.rec.added} step${state.rec.added === 1 ? '' : 's'} added`;
  else if (!running && /^Recording/.test($('runStatus').textContent)) $('runStatus').textContent = 'Ready';
}

function startRun() {
  if (busy()) return;
  const tab = state.tab;
  requestSiteAccess().then((ok) => {
    if (!ok || !tab) return;
    cancelPick();
    state.run.errors = {};
    showTab('steps');
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
  renderDock();
  renderBanner();
}

async function init() {
  Object.assign(state, await loadState());

  $('planMenuBtn').append(icon('more'));
  $('addBtn').append(icon('plus', 14), 'Add step');
  $('runBtn').append(icon('play', 13), 'Run');
  $('stopBtn').append(icon('stop', 13), 'Stop');
  $('emptyRecordBtn').append(icon('record', 14), 'Start recording');
  $('privacyIcon').replaceWith(icon('shield'));
  buildAddMenu();
  bindTabs();

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
  $('emptyAddBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('emptyState').hidden = true;
    $('addWrap').hidden = false;
    toggleMenu($('addBtn'), $('addMenu'));
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  $('runBtn').addEventListener('click', startRun);
  $('recordBtn').addEventListener('click', () => (state.rec ? stopRecording() : startRecording()));
  $('emptyRecordBtn').addEventListener('click', startRecording);
  $('stopBtn').addEventListener('click', () => runner.stop());
  $('pauseBtn').addEventListener('click', () => (state.run.status === 'paused' ? runner.resume() : runner.pause()));

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return;
    if (msg.type === 'cf-picked' || msg.type === 'cf-pick-cancel') onPicked(msg);
    else if (msg.type === 'cf-rec') onRecorded(msg, sender);
    else if (msg.type === 'cf-stop' && sender.tab?.id === runner.tabId) runner.stop();
  });

  bindSettings();
  setupDragAndDrop();
  watchTabs();
  window.addEventListener('pagehide', () => { stopRecording(); flushState(); });

  renderAll();
  await refreshTab();
}

init();
