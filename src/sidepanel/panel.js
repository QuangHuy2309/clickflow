import {
  BLOCK_TYPES, INNER_TYPES, LIMITS, LIMITS_INNER, allSteps, cleanDataName, isShown, newBlock, newDataset, newId, newPlan,
  sanitizeBlock, uniqueDataName, waitMax,
} from '../shared/schema.js';
import { LANGS, captureStatic, getLang, setLang, t, translateStatic } from '../shared/i18n.js';
import { dataRef, datasetValues, nameFromSelector, renameReferences, runCount, usedDatasets } from '../shared/data.js';
import { BLOCK_UI, duration, summarize, typeLabel } from './blocks.js';
import { h, icon } from './dom.js';
import { exportPlan, flushState, loadState, readImportFile, saveLang, saveState } from './storage.js';
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

function toast(message, kind = 'info', ms = 3200, action = null) {
  const box = $('toasts');
  const el = h('div', { class: `toast ${kind}${action ? ' has-action' : ''}`, role: kind === 'error' ? 'alert' : 'status' }, message,
    action && h('button', { class: 'toast-action', onclick: () => { el.remove(); action.run(); } }, action.label));
  box.append(el);
  while (box.childElementCount > 3) box.firstElementChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
}

function modal({ title, message, list, input, confirm = t('OK'), danger = false }) {
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
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => finish(false) }, t('Cancel')),
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
    toast(t('You can keep up to {n} plans.', { n: LIMITS.plans }), 'error');
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
      const name = await modal({ title: t('New plan'), input: t('Untitled plan'), confirm: t('Create') });
      if (name) addPlan(newPlan(name));
      break;
    }
    case 'rename': {
      const name = await modal({ title: t('Rename plan'), input: p.name, confirm: t('Rename') });
      if (name) { p.name = name; save(); renderPlanSelect(); }
      break;
    }
    case 'duplicate': {
      const copy = structuredClone(p);
      copy.id = newId();
      copy.name = t('{name} copy', { name: p.name });
      copy.blocks.forEach((b) => { b.id = newId(); });
      if (addPlan(copy)) toast(t('Plan duplicated.'), 'ok');
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
        title: t('Delete “{name}”?', { name: p.name }),
        message: t('This removes the plan and all its steps. This cannot be undone.'),
        confirm: t('Delete'),
        danger: true,
      });
      if (!ok) break;
      state.plans = state.plans.filter((x) => x.id !== p.id);
      if (!state.plans.length) state.plans.push(newPlan(t('My first plan')));
      switchPlan(state.plans[0].id);
      toast(t('Plan deleted.'));
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
      acc[typeLabel(b.type)] = (acc[typeLabel(b.type)] || 0) + 1;
      return acc;
    }, {})).map(([label, n]) => `${n} × ${label}`);
    const ok = await modal({
      title: t('Import “{name}”?', { name: imported.name }),
      message: t('{n} step(s). Review the steps before running, and only import plans from people you trust.', { n: imported.blocks.length })
        + (dropped ? ` ${t('{n} unsupported step(s) were removed.', { n: dropped })}` : ''),
      list: counts,
      confirm: t('Import'),
    });
    if (ok && addPlan(imported)) toast(t('Plan imported.'), 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- Steps ----------

// Where a step lives: the plan's list, or the steps of a "For each row" block.
function locate(id) {
  const p = plan();
  for (let i = 0; i < p.blocks.length; i++) {
    const b = p.blocks[i];
    if (b.id === id) return { list: p.blocks, index: i, parent: null };
    const j = b.steps ? b.steps.findIndex((x) => x.id === id) : -1;
    if (j >= 0) return { list: b.steps, index: j, parent: b };
  }
  return null;
}

function findBlock(id) {
  const at = locate(id);
  return at ? at.list[at.index] : null;
}

// "3", or "3.2" for the 2nd step inside step 3.
function stepNo(id) {
  const at = locate(id);
  if (!at) return '';
  return at.parent ? `${plan().blocks.indexOf(at.parent) + 1}.${at.index + 1}` : String(at.index + 1);
}

const stepTotal = () => allSteps(plan().blocks).length;

function renderBlocks() {
  const p = plan();
  const empty = p.blocks.length === 0;
  $('blockList').replaceChildren(...p.blocks.map((b, i) => blockCard(b, i, p.blocks.length)));
  if (empty && state.rec) {
    $('blockList').append(h('li', { class: 'rec-hint' },
      h('span', { class: 'rec-dot' }),
      h('div', {}, h('strong', {}, t('Listening for your actions…')),
        h('span', { class: 'muted' }, t('Click, type, and choose options on the page. Each action appears here as a step.')))));
  }
  $('emptyState').hidden = !empty || Boolean(state.rec);
  $('addWrap').hidden = empty && !state.rec;
  $('stepCount').textContent = stepTotal() || '';
  $('runBtn').disabled = empty;
}

function cardFor(id) {
  return $('blockList').querySelector(`[data-id="${CSS.escape(id)}"]`);
}

function rerenderBlock(id) {
  const at = locate(id);
  const old = cardFor(id);
  if (!at || !old) return;
  old.replaceWith(blockCard(at.list[at.index], at.index, at.list.length, at.parent));
}

function blockCard(b, index, total, parent = null) {
  const def = BLOCK_TYPES[b.type];
  const error = state.run.errors[b.id];
  const classes = ['block', `t-${b.type}`];
  if (!b.enabled) classes.push('disabled');
  if (error) classes.push('is-error');
  if (state.run.blockId === b.id) classes.push('is-running');

  const li = h('li', { class: classes.join(' '), dataset: { id: b.id } });

  const grip = h('button', {
    class: 'icon-btn grip',
    title: t('Drag to reorder (or focus and press ↑ / ↓)'),
    'aria-label': t('Reorder step {n} with the arrow keys', { n: parent ? `${plan().blocks.indexOf(parent) + 1}.${index + 1}` : index + 1 }),
    onkeydown: (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveBy(b.id, e.key === 'ArrowUp' ? -1 : 1);
      }
    },
  }, icon('grip', 14));

  const del = h('button', { class: 'icon-btn danger', title: t('Delete step'), 'aria-label': t('Delete step') }, icon('trash', 15));
  let confirmTimer;
  const resetDel = () => { clearTimeout(confirmTimer); del.classList.remove('confirm-delete'); del.replaceChildren(icon('trash', 15)); };
  del.addEventListener('click', () => {
    if (del.classList.contains('confirm-delete')) return removeBlock(b.id);
    del.classList.add('confirm-delete');
    del.replaceChildren(t('Delete?'));
    confirmTimer = setTimeout(resetDel, 2500);
  });
  del.addEventListener('blur', resetDel);

  const head = h('div', { class: 'block-head' },
    grip,
    h('span', { class: 'type-icon' }, icon(BLOCK_UI[b.type].icon)),
    h('button', {
      class: 'block-title',
      'aria-expanded': String(!b.collapsed),
      title: b.collapsed ? t('Edit step') : t('Collapse'),
      onclick: () => { b.collapsed = !b.collapsed; save(); rerenderBlock(b.id); },
    }, h('strong', {}, t(def.label)), h('span', { class: 'summary' }, summarize(b))),
    h('label', { class: 'switch', title: b.enabled ? t('Enabled') : t('Disabled') },
      h('input', {
        type: 'checkbox',
        checked: b.enabled,
        'aria-label': t('Enable step'),
        onchange: (e) => { b.enabled = e.target.checked; save(); rerenderBlock(b.id); },
      }),
      h('span')),
    h('div', { class: 'block-actions' },
      h('button', { class: 'icon-btn move-up', title: t('Move up'), 'aria-label': t('Move up'), disabled: index === 0 && !parent, onclick: () => moveBy(b.id, -1) }, icon('up', 15)),
      h('button', { class: 'icon-btn move-down', title: t('Move down'), 'aria-label': t('Move down'), disabled: index === total - 1 && !parent, onclick: () => moveBy(b.id, 1) }, icon('down', 15)),
      h('button', { class: 'icon-btn', title: t('Test this step on the page'), 'aria-label': t('Test this step'), onclick: () => startRun(b.id) }, icon('play', 14)),
      h('button', { class: 'icon-btn', title: t('Duplicate'), 'aria-label': t('Duplicate step'), onclick: () => duplicateBlock(b.id) }, icon('copy', 15)),
      del));

  const card = h('div', { class: 'step-card' }, head);
  if (b.note) card.append(h('div', { class: 'step-note' }, icon('shield', 14), h('span', {}, t(b.note))));
  if (error) card.append(h('div', { class: 'block-error', role: 'alert' }, icon('alert', 14), h('span', {}, error)));
  if (!b.collapsed) {
    card.append(h('div', { class: 'block-body' }, def.fields.filter((f) => isShown(f, b)).map((f) => fieldControl(b, f, li)), waitControl(b, li)));
  }
  // A row loop shows the steps it runs in each row, expanded or not.
  if (b.steps) {
    card.append(h('div', { class: 'inner-steps' },
      h('div', { class: 'inner-label' }, t('In each matching row, do:')),
      h('ol', { class: 'timeline inner', dataset: { parent: b.id } }, b.steps.map((x, i) => blockCard(x, i, b.steps.length, b))),
      !b.steps.length && h('p', { class: 'inner-empty muted' }, t('Add steps here, or drag steps in.')),
      addInsideMenu(b)));
  }
  const no = parent ? `${plan().blocks.indexOf(parent) + 1}.${index + 1}` : index + 1;
  li.append(h('div', { class: 'rail' }, h('span', { class: 'step-no' }, no)), card);

  head.addEventListener('pointerdown', (e) => startDrag(e, b, li));
  return li;
}

// "+ Add step inside" a row loop: any step type except another loop.
function addInsideMenu(b) {
  const menu = h('div', { class: 'menu add-menu inner-menu', role: 'menu', hidden: true },
    INNER_TYPES.map((type) => addMenuItem(type, () => addBlock(type, b.id))));
  const btn = h('button', {
    class: 'btn btn-add btn-small add-inside-btn',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: (e) => { e.stopPropagation(); toggleMenu(btn, menu); },
  }, icon('plus', 13), t('Add step inside'));
  return h('div', { class: 'menu-wrap add-inside' }, btn, menu);
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
      h('input', { type: 'checkbox', checked: b[f.key], onchange: (e) => { update(e.target.checked); rerenderBlock(b.id); } }),
      t(f.label), f.hint && h('small', { class: 'check-hint' }, t(f.hint)));
  }

  let control;
  switch (f.kind) {
    case 'selector': {
      const picking = state.pick?.blockId === b.id && state.pick?.key === f.key;
      control = h('div', { class: 'input-group' },
        h('input', {
          id, type: 'text', class: 'mono', value: b[f.key], maxLength: f.maxLen,
          placeholder: t('CSS selector, e.g. #submit'), spellcheck: 'false', autocomplete: 'off',
          oninput: (e) => update(e.target.value),
        }),
        h('button', {
          type: 'button',
          class: `chip-btn pick-btn${picking ? ' active' : ''}`,
          title: t('Click an element on the page to fill this in'),
          onclick: () => togglePick(b, f),
        }, icon('target', 14), picking ? t('Picking…') : t('Pick')),
        h('button', {
          type: 'button',
          class: 'chip-btn find-btn',
          title: t('Highlight what this selector matches on the page'),
          'aria-label': t('Find on page'),
          onclick: () => findOnPage(b[f.key]),
        }, icon('search', 14)));
      break;
    }
    case 'text':
    case 'textarea': {
      const input = f.kind === 'text'
        ? h('input', { id, type: 'text', value: b[f.key], maxLength: f.maxLen, oninput: (e) => update(e.target.value) })
        : h('textarea', { id, rows: 2, value: b[f.key], maxLength: f.maxLen, oninput: (e) => update(e.target.value) });
      control = f.variable ? variableControl(b, f, input) : input;
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
      }, f.options.map((o) => h('option', { value: o.value, selected: o.value === b[f.key] }, t(o.label))));
      break;
  }
  return h('div', { class: 'field' }, h('label', { for: id }, t(f.label)), control, f.hint && h('small', {}, t(f.hint)));
}

// "Then wait" after any step: a number, in seconds or minutes, under an hour.
function waitControl(b, li) {
  const id = `f-${b.id}-waitAfter`;
  const amount = h('input', {
    id, type: 'number', class: 'wait-amount', value: String(b.waitAfter), min: 0, max: waitMax(b.waitUnit),
    onchange: (e) => {
      const n = Math.round(Number(e.target.value));
      b.waitAfter = Number.isFinite(n) ? Math.min(waitMax(b.waitUnit), Math.max(0, n)) : 0;
      e.target.value = String(b.waitAfter);
      changed();
    },
  });
  const unit = h('select', {
    class: 'wait-unit',
    'aria-label': t('Unit'),
    onchange: (e) => {
      b.waitUnit = e.target.value;
      b.waitAfter = Math.min(b.waitAfter, waitMax(b.waitUnit));
      amount.max = waitMax(b.waitUnit);
      amount.value = String(b.waitAfter);
      changed();
    },
  }, h('option', { value: 's', selected: b.waitUnit !== 'm' }, t('seconds')), h('option', { value: 'm', selected: b.waitUnit === 'm' }, t('minutes')));
  function changed() {
    li.querySelector('.summary').textContent = summarize(b);
    save();
  }
  return h('div', { class: 'field wait-after' },
    h('label', { for: id }, t('Then wait')),
    h('div', { class: 'input-group' }, amount, unit),
    h('small', {}, t('Before the next step. 0 = no wait; up to 59 minutes.')));
}

// Fields that can take data: a Value dropdown picks fixed text or a data set.
const FIXED = '__fixed__';
const NEW_SET = '__new__';

function variableControl(b, f, input) {
  const p = plan();
  const ref = dataRef(b[f.key]);
  const set = ref && p.datasets.find((d) => d.name === ref);
  const select = h('select', {
    class: `source-select${set ? '' : ' fixed'}`,
    'aria-label': t('{field}: value source', { field: t(f.label) }),
    title: t('Where this value comes from on each run'),
    onchange: (e) => {
      const v = e.target.value;
      if (v === FIXED) setFieldSource(b, f, null);
      else if (v === NEW_SET) createSetFor(b, f);
      else setFieldSource(b, f, v);
    },
  },
  h('option', { value: FIXED, selected: !set }, t('Fixed text')),
  p.datasets.length > 0 && h('optgroup', { label: t('Data set') },
    p.datasets.map((d) => h('option', { value: d.name, selected: d.name === set?.name }, `${d.name} (${datasetValues(d).length})`))),
  p.datasets.length < LIMITS.datasets && h('option', { value: NEW_SET }, t('+ New data set')));

  let body = input;
  if (set) {
    const values = datasetValues(set);
    body = h('button', { type: 'button', class: 'uses-set', title: t('Edit this data set'), onclick: () => openDataset(set.id) },
      h('code', {}, set.name),
      h('span', { class: 'uses-preview' }, values.length
        ? `${values.slice(0, 3).join(' · ')}${values.length > 3 ? ' …' : ''}`
        : t('empty, add values')));
  } else if (ref) {
    body = h('div', { class: 'uses-set missing' }, t('Data set “{name}” doesn’t exist', { name: ref }));
  }
  return h('div', { class: 'input-group' }, body, select);
}

// "+ New data set": named after the field, seeded with the step's current text.
function createSetFor(b, f) {
  const p = plan();
  const name = uniqueDataName(nameFromSelector(b.selector) || (f.key === 'match' ? 'option' : 'text'), p.datasets.map((d) => d.name));
  const literal = dataRef(b[f.key]) ? '' : b[f.key].trim();
  const set = newDataset(name, literal);
  p.datasets.push(set);
  b[f.key] = `{{${name}}}`;
  save();
  renderBlocks();
  renderData();
  toast(literal ? t('Data set “{name}” created with “{value}”. Add more values in the Data tab.', { name, value: literal })
    : t('Data set “{name}” created. Add its values in the Data tab.', { name }), 'ok', 4000);
}

function setFieldSource(b, f, name) {
  if (name) {
    b[f.key] = `{{${name}}}`;
  } else {
    // Back to fixed text, starting from the set's first value.
    const set = plan().datasets.find((d) => d.name === dataRef(b[f.key]));
    b[f.key] = set ? (datasetValues(set)[0] ?? '') : '';
  }
  save();
  renderBlocks();
  renderData();
}

function openDataset(id) {
  showTab('data');
  const card = $('datasetList').querySelector(`[data-id="${CSS.escape(id)}"]`);
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card?.querySelector('textarea')?.focus({ preventScroll: true });
}

function addBlock(type, parentId = null) {
  if (stepTotal() >= LIMITS.blocks) return toast(t('A plan can have up to {n} steps.', { n: LIMITS.blocks }), 'error');
  const list = parentId ? findBlock(parentId).steps : plan().blocks;
  if (parentId && list.length >= LIMITS_INNER) return toast(t('A row loop can have up to {n} steps.', { n: LIMITS_INNER }), 'error');
  const b = newBlock(type);
  list.push(b);
  save();
  renderBlocks();
  const card = cardFor(b.id);
  card.classList.add('just-added');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card.querySelector('.block-body input, .block-body select')?.focus({ preventScroll: true });
}

function removeBlock(id) {
  const p = plan();
  const { list, index, parent } = locate(id);
  const [removed] = list.splice(index, 1);
  const planId = p.id;
  const parentId = parent?.id;
  toast(t('Step deleted.'), 'info', 5000, {
    label: t('Undo'),
    run: () => {
      const target = state.plans.find((x) => x.id === planId);
      if (!target || busy()) return;
      // Back where it was: inside its row loop if that still exists.
      const into = (parentId && target.blocks.find((x) => x.id === parentId)?.steps) || target.blocks;
      into.splice(Math.min(index, into.length), 0, removed);
      save();
      if (state.currentId === planId) renderBlocks();
    },
  });
  delete state.run.errors[id];
  save();
  renderBlocks();
}

function duplicateBlock(id) {
  const { list, index, parent } = locate(id);
  const copy = { ...structuredClone(list[index]), id: newId() };
  copy.steps?.forEach((x) => { x.id = newId(); });
  if (stepTotal() + 1 + (copy.steps?.length || 0) > LIMITS.blocks) return toast(t('A plan can have up to {n} steps.', { n: LIMITS.blocks }), 'error');
  if (parent && list.length >= LIMITS_INNER) return toast(t('A row loop can have up to {n} steps.', { n: LIMITS_INNER }), 'error');
  list.splice(index + 1, 0, copy);
  save();
  renderBlocks();
  cardFor(copy.id).classList.add('just-added');
}

// One step up or down. At the edge of a row loop, a step moves out of it,
// just above or below the loop.
function moveBy(id, delta) {
  const at = locate(id);
  const to = at.index + delta;
  if (to >= 0 && to < at.list.length) {
    at.list.splice(to, 0, at.list.splice(at.index, 1)[0]);
  } else if (at.parent) {
    const [moved] = at.list.splice(at.index, 1);
    const blocks = plan().blocks;
    const i = blocks.indexOf(at.parent);
    blocks.splice(delta < 0 ? i : i + 1, 0, moved);
  } else {
    return;
  }
  save();
  renderBlocks();
  cardFor(id)?.querySelector('.grip')?.focus();
}

// dest: { parentId (a row loop, or null for the plan), index in that list }.
function moveTo(id, dest) {
  const at = locate(id);
  const moved = at.list[at.index];
  const list = dest.parentId ? findBlock(dest.parentId)?.steps : plan().blocks;
  if (!list || (dest.parentId && moved.steps)) return;
  if (dest.parentId && list !== at.list && list.length >= LIMITS_INNER) return toast(t('A row loop can have up to {n} steps.', { n: LIMITS_INNER }), 'error');
  let index = dest.index;
  if (list === at.list && at.index < index) index--;
  if (list === at.list && index === at.index) return;
  at.list.splice(at.index, 1);
  list.splice(index, 0, moved);
  save();
  renderBlocks();
  cardFor(id)?.classList.add('just-added');
}

function clearDropMarks() {
  for (const el of $('blockList').querySelectorAll('.drop-before, .drop-after, .drop-inside')) el.classList.remove('drop-before', 'drop-after', 'drop-inside');
}

// Where a dragged step would land at height y: a slot in the plan, or in a
// row loop's steps (never a loop inside a loop). Marks the spot.
function dropAt(y, b, dragLi) {
  clearDropMarks();
  const cards = (ol) => [...ol.children].filter((c) => c.matches('li.block'));
  let ol = $('blockList');
  let parentId = null;
  if (!b.steps) {
    const loop = cards(ol).find((c) => {
      if (c === dragLi || !c.classList.contains('t-rows')) return false;
      const r = c.querySelector('.inner-steps').getBoundingClientRect();
      return y >= r.top && y <= r.bottom;
    });
    if (loop) {
      ol = loop.querySelector('ol.inner');
      parentId = loop.dataset.id;
    }
  }
  const kids = cards(ol);
  let index = kids.length;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i] === dragLi) continue;
    const r = kids[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) { index = i; break; }
  }
  const others = kids.filter((c) => c !== dragLi);
  if (!others.length) ol.closest('.inner-steps')?.classList.add('drop-inside');
  else if (index < kids.length && kids[index] !== dragLi) kids[index].classList.add('drop-before');
  else if (index < kids.length) kids[index + 1]?.classList.add('drop-before');
  else others.at(-1).classList.add('drop-after');
  return { parentId, index };
}

// Drag a step by its header (pointer events, so it works in the side panel
// and can scroll the list): up, down, past several steps, or into and out
// of a row loop. Esc cancels. A press without movement is still a click.
function startDrag(e, b, li) {
  if (e.button !== 0 || busy() || e.target.closest('input, select, textarea, .switch, .block-actions')) return;
  const main = $('main');
  const x0 = e.clientX;
  const y0 = e.clientY;
  let y = y0;
  let active = false;
  let dest = null;
  let timer = null;
  const scroll = () => {
    const r = main.getBoundingClientRect();
    const dy = y < r.top + 48 ? -Math.ceil((r.top + 48 - y) / 4) : y > r.bottom - 48 ? Math.ceil((y - r.bottom + 48) / 4) : 0;
    if (dy) {
      main.scrollTop += dy;
      dest = dropAt(y, b, li);
    }
  };
  const move = (ev) => {
    y = ev.clientY;
    if (!active) {
      if (Math.abs(ev.clientX - x0) + Math.abs(y - y0) < 6) return;
      active = true;
      li.classList.add('dragging');
      document.body.classList.add('is-dragging');
      timer = setInterval(scroll, 16);
    }
    ev.preventDefault();
    dest = dropAt(y, b, li);
  };
  const finish = (drop) => {
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', cancel, true);
    document.removeEventListener('keydown', key, true);
    clearInterval(timer);
    clearDropMarks();
    li.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    if (!active) return;
    // The click that ends a drag must not also toggle the step open/closed.
    const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, true), 0);
    if (drop && dest) moveTo(b.id, dest);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); } };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', cancel, true);
  document.addEventListener('keydown', key, true);
}

function addMenuItem(type, onPick) {
  return h('button', { role: 'menuitem', class: `t-${type}`, onclick: () => { closeMenus(); onPick(); } },
    h('span', { class: 'type-icon' }, icon(BLOCK_UI[type].icon)),
    h('span', { class: 'add-label' }, h('strong', {}, t(BLOCK_TYPES[type].label)), h('small', {}, t(BLOCK_UI[type].desc))));
}

function buildAddMenu() {
  $('addMenu').replaceChildren(...Object.keys(BLOCK_TYPES).map((type) => addMenuItem(type, () => addBlock(type))));
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
  for (const menu of document.querySelectorAll('.inner-menu')) {
    menu.hidden = true;
    menu.previousElementSibling?.setAttribute('aria-expanded', 'false');
  }
}

// ---------- Data sets ----------

const countText = (n) => t(n === 1 ? '{n} value' : '{n} values', { n });

function renderData() {
  const p = plan();
  const used = usedDatasets(p);
  $('datasetList').replaceChildren(...p.datasets.map((d, i) => datasetCard(d, i, used.has(d.name))));
  $('dataEmpty').hidden = p.datasets.length > 0;
  $('addDatasetBtn').hidden = p.datasets.length >= LIMITS.datasets;
  $('dataCount').textContent = p.datasets.length || '';
  updateRunCount();
}

function datasetCard(d, i, used) {
  const count = h('span', { class: 'ds-count' });
  const preview = h('div', { class: 'ds-preview', 'aria-label': t('Values by run') });
  const refresh = () => {
    const values = datasetValues(d);
    count.textContent = countText(values.length);
    const chips = values.slice(0, 8).map((v, n) => h('span', { class: 'chip', title: t('Run {n}: {value}', { n: n + 1, value: v }) }, h('b', {}, n + 1), v));
    if (values.length > 8) chips.push(h('span', { class: 'chip more' }, t('+{n} more', { n: values.length - 8 })));
    preview.replaceChildren(...chips);
  };

  const del = h('button', { class: 'icon-btn danger', title: t('Delete data set'), 'aria-label': t('Delete data set {name}', { name: d.name }) }, icon('trash', 14));
  del.addEventListener('click', () => deleteDataset(d.id));

  const split = h('div', { class: 'segmented mini', role: 'radiogroup', 'aria-label': t('Separate values by') },
    [['auto', t('Auto')], ['lines', t('Lines')], ['comma', t('Commas')]].map(([value, label]) => h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(d.split === value),
      onclick: () => { d.split = value; save(); renderData(); renderBlocks(); },
    }, label)));

  const card = h('div', { class: `dataset c${i % 6}`, dataset: { id: d.id } },
    h('div', { class: 'ds-head' },
      h('input', {
        type: 'text',
        class: 'ds-name',
        value: d.name,
        maxLength: LIMITS.dataName,
        spellcheck: 'false',
        'aria-label': t('Data set name'),
        title: t('Steps use this as {placeholder}', { placeholder: `{{${d.name}}}` }),
        onchange: (e) => renameDataset(d, e.target),
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      }),
      used && h('span', { class: 'ds-used', title: t('Used by a step') }, t('In use')),
      count,
      del),
    h('textarea', {
      value: d.text,
      rows: 4,
      spellcheck: 'false',
      maxLength: LIMITS.data,
      placeholder: t('One value per line\nor separated, by, commas'),
      'aria-label': t('Values for {name}', { name: d.name }),
      oninput: (e) => { d.text = e.target.value; save(); refresh(); updateRunCount(); },
      onchange: () => renderBlocks(),
    }),
    h('div', { class: 'ds-foot' }, split),
    preview);
  refresh();
  return card;
}

function addDataset() {
  const p = plan();
  if (p.datasets.length >= LIMITS.datasets) return;
  const set = newDataset(uniqueDataName('list', p.datasets.map((d) => d.name)));
  p.datasets.push(set);
  save();
  renderData();
  renderBlocks();
  const card = $('datasetList').querySelector(`[data-id="${CSS.escape(set.id)}"]`);
  card.classList.add('just-added');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card.querySelector('.ds-name').select();
}

function renameDataset(d, input) {
  const p = plan();
  const to = cleanDataName(input.value);
  if (to === d.name) { input.value = d.name; return; }
  if (!to || p.datasets.some((x) => x.name === to)) {
    input.value = d.name;
    return toast(to ? t('There’s already a data set named {name}.', { name: to }) : t('Names use letters, numbers and _ and start with a letter.'), 'error');
  }
  renameReferences(p, d.name, to);
  d.name = to;
  save();
  renderData();
  renderBlocks();
  toast(t('Renamed to {name}. Steps were updated.', { name: to }), 'ok');
}

async function deleteDataset(id) {
  const p = plan();
  const d = p.datasets.find((x) => x.id === id);
  if (usedDatasets(p).has(d.name)) {
    const ok = await modal({
      title: t('Delete data set {name}?', { name: d.name }),
      message: t('Some steps use it. They will need another value before the plan can run.'),
      confirm: t('Delete'),
      danger: true,
    });
    if (!ok) return;
  }
  p.datasets = p.datasets.filter((x) => x.id !== id);
  save();
  renderData();
  renderBlocks();
}

function bindData() {
  $('addDatasetBtn').addEventListener('click', addDataset);
}

// ---------- Settings ----------

function updateRunCount() {
  const p = plan();
  const { runs, shortest } = runCount(p);
  $('runCount').textContent = runs > 1 ? `${runs}×` : '';
  $('runBtn').replaceChildren(icon('play', 13), runs > 1 ? t('Run {n}×', { n: runs }) : t('Run'));
  $('runSummary').textContent = runsText(runs);
  for (const btn of $('runsMode').children) btn.setAttribute('aria-checked', String(btn.dataset.value === p.runsMode));
  $('fixedRuns').hidden = p.runsMode === 'auto';
  $('autoRunsInfo').hidden = p.runsMode !== 'auto';
  const info = $('autoRunsInfo');
  if (shortest) {
    const sets = usedDatasets(p, { enabledOnly: true }).size;
    info.replaceChildren(h('strong', {}, runsText(runs)),
      sets > 1
        ? ` · ${t('the shortest of your {sets} data sets, {name}, has {count}.', { sets, name: shortest.name, count: countText(shortest.n) })}`
        : ` · ${t('one for each value in {name}.', { name: shortest.name })}`);
  } else {
    info.replaceChildren(h('strong', {}, runsText(1)), ` · ${t('no step uses a data set yet. Runs follow the shortest data set your steps use.')}`);
  }
  for (const btn of $('quickRuns').children) btn.setAttribute('aria-pressed', String(Number(btn.dataset.runs) === p.runs));
}

const runsText = (n) => t(n === 1 ? '{n} run' : '{n} runs', { n });

function setRuns(n) {
  const p = plan();
  p.runs = Math.min(LIMITS.runs, Math.max(1, Math.round(n) || 1));
  $('runs').value = p.runs;
  save();
  updateRunCount();
}

function renderSettings() {
  const p = plan();
  $('runs').value = p.runs;
  $('whenShort').value = p.whenShort;
  $('stepDelay').value = p.stepDelay;
  $('runDelay').value = p.runDelay;
  $('timeout').value = p.timeout;
  $('onError').value = p.onError;
  $('retries').value = String(p.retries);
  updateRunCount();
}

function bindSettings() {
  const nums = { stepDelay: [0, 60000], runDelay: [0, 600000], timeout: LIMITS.timeout };
  for (const [key, [min, max]] of Object.entries(nums)) {
    $(key).addEventListener('change', (e) => {
      const n = Math.round(Number(e.target.value));
      const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : plan()[key];
      e.target.value = v;
      plan()[key] = v;
      save();
    });
  }
  $('runsMode').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.value;
    if (!v) return;
    const p = plan();
    // Switching to fixed starts from the count automatic mode would use.
    if (v === 'fixed' && p.runsMode === 'auto') p.runs = runCount(p).runs;
    p.runsMode = v;
    save();
    renderSettings();
  });
  $('runs').addEventListener('change', (e) => setRuns(Number(e.target.value)));
  $('quickRuns').addEventListener('click', (e) => {
    const n = e.target.closest('button')?.dataset.runs;
    if (n) setRuns(Number(n));
  });
  $('whenShort').addEventListener('change', (e) => { plan().whenShort = e.target.value; save(); });
  $('onError').addEventListener('change', (e) => { plan().onError = e.target.value; save(); });
  $('retries').addEventListener('change', (e) => { plan().retries = Number(e.target.value); save(); });
}

// ---------- Activity log ----------

const LOG_MAX = 500;
const shots = [];

const fileName = (name) => `${String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'screenshot'}.png`;
const where = (run, step, sub) => h('span', { class: 'log-where' }, `R${run + 1}·S${step + 1}${sub != null ? `.${sub + 1}` : ''}`);

function logAppend(node) {
  const list = $('logList');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(node);
  while (list.childElementCount > LOG_MAX) list.firstElementChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function logSeparator(text) {
  logAppend(h('li', { class: 'log-sep' }, text));
  $('logSummary').textContent = text;
}

function logRetry({ run, step, sub, block, attempt, error }) {
  logAppend(h('li', { class: 'log-item retry' },
    icon('alert', 14),
    h('span', { class: 'log-text' }, where(run, step, sub), t('Retrying ({n}) {step}', { n: attempt, step: summarize(block) }), h('span', { class: 'log-err' }, error)),
    h('span', { class: 'log-ms' }, '')));
}


// loadMs: time spent waiting for the page the step opened, so slow sites
// aren't mistaken for slow steps.
function logStep({ run, step, sub, block, ok, error, ms, loadMs, rows, opened }) {
  if (block.type === 'screenshot' && ok) return; // logged with its image by logShot
  logAppend(h('li', { class: `log-item ${ok ? 'ok' : 'err'}` },
    icon(ok ? 'check' : 'alert', 14),
    h('span', { class: 'log-text' }, where(run, step, sub), summarize(block),
      !ok && h('span', { class: 'log-err' }, error),
      opened && h('span', { class: 'log-note' }, t('Opened in a new tab')),
      ok && rows != null && h('span', { class: 'log-note' }, rows ? t(rows === 1 ? '{n} row handled' : '{n} rows handled', { n: rows }) : t('No row matched')),
      ok && loadMs >= 500 && h('span', { class: 'log-note' }, t('{time} of it waiting for the next page to load', { time: duration(loadMs) }))),
    h('span', { class: 'log-ms' }, duration(ms))));
}

// A heading line for each row a "For each row" step works on.
function logRow({ run, step, n, label }) {
  logAppend(h('li', { class: 'log-item row' },
    icon('rows', 14),
    h('span', { class: 'log-text' }, where(run, step), h('strong', {}, t('Row {n}', { n })), ` · “${label || '…'}”`),
    h('span', { class: 'log-ms' }, '')));
}

// A step's "Then wait" countdown, in the status line.
function showWait({ run, runs, step, steps, left }) {
  if (!left) return;
  const s = Math.ceil(left / 1000);
  const time = s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} s`;
  $('runStatus').textContent = `${t('Run {run}/{runs} · Step {step}/{steps}', { run: run + 1, runs, step: step + 1, steps })} · ${t('waiting {time}', { time })}`;
}

function downloadShot(shot) {
  const a = document.createElement('a');
  a.href = shot.url;
  a.download = fileName(shot.name);
  a.click();
}

function viewShot(shot) {
  const dlg = $('modal');
  dlg.replaceChildren(h('form', { method: 'dialog' },
    h('h3', {}, fileName(shot.name)),
    h('img', { class: 'shot-view', src: shot.url, alt: t('Screenshot {name}', { name: shot.name }) }),
    h('div', { class: 'modal-actions' },
      h('button', { type: 'submit', class: 'btn btn-ghost' }, t('Close')),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => downloadShot(shot) }, icon('download', 14), t('Download')))));
  dlg.oncancel = null;
  dlg.showModal();
}

function logShot({ run, step, name, blob }) {
  const shot = { name, url: URL.createObjectURL(blob) };
  shots.push(shot);
  $('logDownloadAll').hidden = false;
  $('logDownloadAll').textContent = t('Download all images ({n})', { n: shots.length });
  logAppend(h('li', { class: 'log-item shot' },
    icon('camera', 14),
    h('span', { class: 'log-text' }, where(run, step), t('Screenshot {name}', { name: fileName(name) }),
      h('span', { class: 'log-shot' },
        h('img', { src: shot.url, alt: t('Screenshot {name}', { name }), title: t('View'), onclick: () => viewShot(shot) }),
        h('button', { class: 'btn btn-ghost btn-small', onclick: () => downloadShot(shot) }, icon('download', 13), t('Download')))),
    h('span', { class: 'log-ms' }, `${Math.round(blob.size / 1024)} KB`)));
}

// The log's height is dragged from its top edge and remembered.
const LOG_HEIGHT_KEY = 'clickflow.logHeight';

function setLogHeight(px, remember = true) {
  const panel = $('logPanel');
  if (px == null) {
    panel.style.height = '';
    panel.classList.remove('sized');
  } else {
    const max = Math.max(120, window.innerHeight - 170);
    px = Math.round(Math.min(max, Math.max(90, px)));
    panel.style.height = `${px}px`;
    panel.classList.add('sized');
  }
  if (remember) {
    try { px == null ? localStorage.removeItem(LOG_HEIGHT_KEY) : localStorage.setItem(LOG_HEIGHT_KEY, String(px)); } catch { /* storage off */ }
  }
}

function bindLogResize() {
  const grip = $('logResize');
  const panel = $('logPanel');
  try {
    const saved = Number(localStorage.getItem(LOG_HEIGHT_KEY));
    if (saved) setLogHeight(saved, false);
  } catch { /* storage off */ }
  // The log and the steps share the space: dragging the divider (or the
  // log's header) up grows the log and shortens the steps area above it.
  const keepRunningStepInView = () => document.querySelector('#blockList .is-running')?.scrollIntoView({ block: 'nearest' });
  const startDrag = (el) => (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    panel.classList.add('resizing');
    const move = (ev) => { setLogHeight(startH + (startY - ev.clientY), false); keepRunningStepInView(); };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      panel.classList.remove('resizing');
      setLogHeight(startH + (startY - ev.clientY));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const head = panel.querySelector('.log-head');
  grip.addEventListener('pointerdown', startDrag(grip));
  head.addEventListener('pointerdown', startDrag(head));
  for (const el of [grip, head]) el.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) setLogHeight(null); });
  grip.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowUp' ? 24 : e.key === 'ArrowDown' ? -24 : 0;
    if (!step) return;
    e.preventDefault();
    setLogHeight(panel.getBoundingClientRect().height + step);
  });
}

function showLog(open) {
  $('logPanel').hidden = !open;
  $('logBtn').setAttribute('aria-pressed', String(open));
}

function clearLog() {
  for (const s of shots) URL.revokeObjectURL(s.url);
  shots.length = 0;
  $('logList').replaceChildren();
  $('logSummary').textContent = '';
  $('logDownloadAll').hidden = true;
}

function bindLog() {
  $('logBtn').append(icon('log', 16));
  $('logClear').append(icon('trash', 14));
  $('logClose').append(icon('close', 14));
  $('logBtn').addEventListener('click', () => showLog($('logPanel').hidden));
  $('logClose').addEventListener('click', () => showLog(false));
  $('logClear').addEventListener('click', clearLog);
  bindLogResize();
  // Chrome may ask once to allow multiple downloads from the extension.
  $('logDownloadAll').addEventListener('click', async () => {
    for (const s of shots) {
      downloadShot(s);
      await new Promise((r) => setTimeout(r, 250));
    }
  });
}

// ---------- Site access ----------

async function refreshTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  state.tab = tab || null;
  state.access = await getAccess(state.tab);
  state.allSites = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  renderBanner();
}

// Chrome only lets extensions capture a tab with all-sites access (or a
// fresh toolbar click), so plans with Screenshot steps ask for it once, at
// Run. Like requestSiteAccess, call this directly from the click handler.
function requestCaptureAccess() {
  if (state.allSites) return Promise.resolve(true);
  if (state.access.kind === 'restricted' || state.access.kind === 'file-blocked') return requestSiteAccess();
  return chrome.permissions.request({ origins: ['<all_urls>'] }).then(async (ok) => {
    await refreshTab();
    if (!ok) toast(t('Screenshot steps need permission to capture pages. Allow it, or turn those steps off.'), 'error', 5000);
    return ok;
  });
}

function renderBanner() {
  const banner = $('siteBanner');
  const chip = $('siteChip');
  const a = state.access;
  chip.hidden = a.kind !== 'granted';
  chip.textContent = a.kind === 'granted' ? a.host : '';

  const content = {
    needs: () => [h('p', {}, t('Allow ClickFlow on {host}? It only acts when you press Record, Run or Pick.', { host: a.host })),
      h('button', { class: 'btn btn-primary btn-small', onclick: requestSiteAccess }, t('Allow'))],
    unknown: () => [h('p', {}, t('ClickFlow can’t see this tab yet. Click the ClickFlow toolbar icon while on the page.')),
      h('button', { class: 'btn btn-ghost btn-small', onclick: requestAllSites, title: t('Grant access to every site') }, t('All sites'))],
    restricted: () => [h('p', {}, t('Chrome doesn’t allow extensions on this page. Switch to a regular website.'))],
    'file-blocked': () => [h('p', {}, t('To use ClickFlow on local files, turn on "Allow access to file URLs" in the extension’s details.'))],
  }[a.kind];

  banner.hidden = !content || Boolean(state.rec);
  if (content) banner.replaceChildren(icon(a.kind === 'needs' ? 'shield' : 'alert', 18), ...content());
}

// Must be called directly from a click handler so Chrome sees the user gesture.
function requestSiteAccess() {
  const a = state.access;
  if (a.kind === 'granted') return Promise.resolve(true);
  if (a.kind !== 'needs') {
    toast(a.kind === 'unknown' ? t('Grant access to this page first (see the banner above).') : t('ClickFlow can’t run on this page.'), 'error');
    return Promise.resolve(false);
  }
  return chrome.permissions.request({ origins: [a.pattern] }).then(async (ok) => {
    await refreshTab();
    if (!ok) toast(t('Access not granted.'), 'error');
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
    // Register before the page can report a pick.
    state.pick = { requestId, tabId: tab.id, blockId: b.id, key: f.key };
    rerenderBlock(b.id);
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/selector.js', 'src/content/picker.js'] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (id, text) => window.__clickflowPicker.start(id, text),
        args: [requestId, t('Click an element to select it · Esc to cancel')],
      });
      toast(t('Click an element on the page. Esc cancels.'));
    } catch (e) {
      state.pick = null;
      rerenderBlock(b.id);
      toast(friendlyError(e.message), 'error');
    }
  });
}

// "Find": flash every element the selector matches and say how many.
function findOnPage(selector) {
  if (!selector.trim()) return toast(t('Enter or pick a selector first.'), 'error');
  if (busy()) return;
  const tab = state.tab;
  requestSiteAccess().then(async (ok) => {
    if (!ok || !tab) return;
    try {
      const target = { tabId: tab.id };
      await chrome.scripting.executeScript({ target, files: ['src/content/actions.js'] });
      const [res] = await chrome.scripting.executeScript({ target, func: (s) => window.__clickflow.highlight(s), args: [selector] });
      const r = res?.result;
      if (!r?.ok) return toast(r?.error ? t(r.error.key, r.error.vars) : t('The page did not respond.'), 'error');
      if (!r.count) return toast(t('Nothing on this page matches that selector.'), 'error');
      const hidden = r.count - r.visible;
      toast(`${t(r.count === 1 ? '{n} match' : '{n} matches', { n: r.count })}${hidden ? ` ${t('({n} hidden)', { n: hidden })}` : ''}${r.count > 1 ? `. ${t('Steps use the first one.')}` : '.'}`,
        r.count === 1 ? 'ok' : 'info');
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
  const b = findBlock(pick.blockId);
  if (!b) return;
  if (msg.type === 'cf-picked' && typeof msg.selector === 'string' && msg.selector.trim()) {
    b[pick.key] = msg.selector.slice(0, LIMITS.selector);
    delete state.run.errors[b.id];
    save();
    rerenderBlock(b.id);
    $(`f-${b.id}-${pick.key}`)?.classList.add('picked');
    toast(t('Element selected.'), 'ok', 1800);
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
    toast(t('Recording. Use the page as usual, then press Stop.'), 'info', 4000);
  });
}

async function injectRecorder() {
  const rec = state.rec;
  if (!rec) return false;
  try {
    const target = { tabId: rec.tabId };
    await chrome.scripting.executeScript({ target, files: ['src/content/selector.js', 'src/content/recorder.js'] });
    await chrome.scripting.executeScript({ target, func: (id, text) => window.__clickflowRecorder.start(id, text), args: [rec.id, t('ClickFlow is recording your actions')] });
    return true;
  } catch (e) {
    toast(t('Recording stopped: {error}', { error: friendlyError(e.message) }), 'error', 5000);
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
    toast(t(rec.added === 1 ? 'Recorded {n} step. Use the Value dropdown on a step to give it a different value each run.' : 'Recorded {n} steps. Use the Value dropdown on a step to give it a different value each run.', { n: rec.added }), 'ok', 4500);
  }
}

const RECORDABLE = new Set(['click', 'type', 'select', 'scroll']);
const recordingText = (n) => t(n === 1 ? 'Recording · {n} step added' : 'Recording · {n} steps added', { n });

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
  if (b.type === 'click' && b.button === 'double') {
    for (let i = 0; i < 2; i++) {
      const prev = p.blocks.at(-1);
      if (prev?.type !== 'click' || prev.button !== 'left' || prev.selector !== b.selector) break;
      p.blocks.pop();
      rec.added--;
    }
  }
  const last = p.blocks.at(-1);
  // Consecutive scrolls of the same thing are one step.
  if (b.type === 'scroll' && last?.type === 'scroll' && last.mode === 'by' && last.selector === b.selector && rec.added > 0) {
    last.amount = Math.max(-100000, Math.min(100000, last.amount + b.amount));
    save();
    rerenderBlock(last.id);
    cardFor(last.id)?.classList.add('just-added');
    return;
  }
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
    toast(t('A plan can have up to {n} steps. Recording stopped.', { n: LIMITS.blocks }), 'error');
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
  $('runStatus').textContent = recordingText(rec.added);
}

// ---------- Running ----------

const runner = new Runner({
  onStatus(status) {
    state.run.status = status;
    if (status === 'idle') state.run.blockId = null;
    renderDock();
    renderBlocks();
  },
  onProgress({ run, runs, step, steps, blockId, row }) {
    state.run.blockId = blockId;
    for (const el of $('blockList').querySelectorAll('.is-running')) el.classList.remove('is-running');
    const card = cardFor(blockId);
    card?.classList.add('is-running');
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('runStatus').textContent = t('Run {run}/{runs} · Step {step}/{steps}', { run: run + 1, runs, step: step + 1, steps })
      + (row ? ` · ${t('Row {n}', { n: row })}` : '');
    $('progressFill').style.width = `${((run * steps + step) / (runs * steps)) * 100}%`;
  },
  onStepError(blockId, message, run) {
    state.run.errors[blockId] = run != null ? t('Run {n}: {value}', { n: run + 1, value: message }) : message;
    rerenderBlock(blockId);
  },
  onStepDone: logStep,
  onRow: logRow,
  onWait: showWait,
  onRetry: logRetry,
  onScreenshot: logShot,
  onDone({ runs, ok, failed, stopped, ms }) {
    logSeparator(t(stopped ? 'Stopped · {ok}/{runs} runs ok · {time}' : 'Finished · {ok}/{runs} runs ok · {time}', { ok, runs, time: `${(ms / 1000).toFixed(1)} s` }));
    $('progressFill').style.width = stopped ? '0%' : '100%';
    const text = stopped ? t('Stopped after {ok} of {runs} run(s)', { ok, runs })
      : failed ? t('Finished: {ok} ok, {failed} failed', { ok, failed })
        : t(ok === 1 ? 'Done: {n} run completed' : 'Done: {n} runs completed', { n: ok });
    $('runStatus').textContent = text;
    toast(text, failed ? 'error' : stopped ? 'info' : 'ok');
  },
});

function renderDock() {
  const s = state.run.status;
  const running = s !== 'idle';
  const recording = Boolean(state.rec);
  $('main').classList.toggle('locked', running);
  $('dock').classList.toggle('is-recording', recording);
  $('planSelect').disabled = running || recording;
  $('planMenuBtn').disabled = running || recording;
  $('runBtn').hidden = running || recording;
  $('recordBtn').hidden = running;
  $('pauseBtn').hidden = !running;
  $('stopBtn').hidden = !running;
  $('recordBtn').classList.toggle('recording', recording);
  $('recordBtn').replaceChildren(...(recording ? [icon('stop', 13), t('Stop')] : [icon('record', 14), t('Record')]));
  $('recordBtn').title = recording ? t('Stop recording') : t('Record your actions on the page as steps');
  $('pauseBtn').replaceChildren(icon(s === 'paused' ? 'play' : 'pause', 14), s === 'paused' ? t('Resume') : t('Pause'));
  if (s === 'paused') $('runStatus').textContent = t('Paused');
  else if (recording) $('runStatus').textContent = recordingText(state.rec.added);
  else if (!running && $('dock').classList.contains('was-recording')) $('runStatus').textContent = t('Ready');
  $('dock').classList.toggle('was-recording', recording);
}

function startRun(onlyBlockId = null) {
  if (busy()) return;
  const tab = state.tab;
  const only = onlyBlockId && findBlock(onlyBlockId);
  const capture = only ? allSteps([only]).some((b) => b.type === 'screenshot') : allSteps(plan().blocks.filter((b) => b.enabled)).some((b) => b.enabled && b.type === 'screenshot');
  (capture ? requestCaptureAccess() : requestSiteAccess()).then((ok) => {
    if (!ok || !tab) return;
    cancelPick();
    state.run.errors = {};
    showTab('steps');
    $('progressFill').style.width = '0%';
    $('runStatus').textContent = t('Starting…');
    const snapshot = structuredClone(plan());
    if (only) {
      // Test one step: just that step, once, with each data set's first value.
      // Its "Then wait" is skipped: there's no next step to wait for.
      Object.assign(snapshot, { blocks: [{ ...structuredClone(only), enabled: true, waitAfter: 0 }], runsMode: 'fixed', runs: 1, whenShort: 'cycle' });
    }
    const { runs } = runCount(snapshot);
    showLog(true);
    if (only) logSeparator(t('Testing step {n} · {type}', { n: stepNo(only.id), type: typeLabel(only.type) }));
    else logSeparator(t('Started {time} · {runs} × {steps} steps', { time: new Date().toLocaleTimeString(), runs: runsText(runs), steps: snapshot.blocks.filter((x) => x.enabled).length }));
    runner.start(snapshot, tab.id).catch((e) => {
      $('runStatus').textContent = t('Ready');
      toast(e.message, 'error', 4500);
    });
  });
}

// ---------- Init ----------

// Text set from code on static elements; redone when the language changes.
function renderStatic() {
  translateStatic();
  $('addBtn').replaceChildren(icon('plus', 14), t('Add step'));
  $('stopBtn').replaceChildren(icon('stop', 13), t('Stop'));
  $('addDatasetBtn').replaceChildren(icon('plus', 14), t('Add data set'));
  $('emptyRecordBtn').replaceChildren(icon('record', 14), t('Start recording'));
  if (!busy()) $('runStatus').textContent = t('Ready');
  for (const btn of $('langSelect').children) btn.setAttribute('aria-checked', String(btn.dataset.value === getLang()));
  buildAddMenu();
}

function bindLanguage() {
  $('langSelect').replaceChildren(...Object.entries(LANGS).map(([code, name]) => h('button', { type: 'button', role: 'radio', dataset: { value: code } }, name)));
  $('langSelect').addEventListener('click', (e) => {
    const code = e.target.closest('button')?.dataset.value;
    if (!code || code === getLang()) return;
    setLang(code);
    saveLang(code);
    renderStatic();
    renderAll();
  });
}

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

  captureStatic(document.body); // before anything is rendered into it
  setLang(state.lang);
  $('planMenuBtn').append(icon('more'));
  $('privacyIcon').replaceWith(icon('shield'));
  bindTabs();
  bindLog();

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

  $('appVersion').textContent = `v${chrome.runtime.getManifest().version}`;
  bindLanguage();
  renderStatic();
  bindSettings();
  bindData();
  watchTabs();
  window.addEventListener('pagehide', () => { stopRecording(); flushState(); });

  renderAll();
  await refreshTab();
}

init();
