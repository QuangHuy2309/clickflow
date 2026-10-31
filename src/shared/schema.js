// Plan and block definitions, defaults, and strict sanitizing of untrusted input
// (saved state and imported files both pass through sanitizePlan).

export const LIMITS = {
  blocks: 200,
  plans: 100,
  name: 80,
  note: 200,
  selector: 1000,
  text: 5000,
  data: 1000000,
  datasets: 20,
  dataName: 30,
  runs: 10000,
  importBytes: 1000000,
};

const selector = (key, label, extra = {}) => ({ key, label, kind: 'selector', default: '', maxLen: LIMITS.selector, ...extra });
const text = (key, label, def, extra = {}) => ({ key, label, kind: 'text', default: def, maxLen: LIMITS.text, ...extra });
const textarea = (key, label, def, extra = {}) => ({ key, label, kind: 'textarea', default: def, maxLen: LIMITS.text, ...extra });
const number = (key, label, def, min, max, extra = {}) => ({ key, label, kind: 'number', default: def, min, max, ...extra });
const bool = (key, label, def, extra = {}) => ({ key, label, kind: 'bool', default: def, ...extra });
const choice = (key, label, options, def, extra = {}) => ({ key, label, kind: 'enum', options, default: def, ...extra });
const timeout = (extra = {}) => number('timeout', 'Wait for element up to (ms)', 5000, 0, 120000, extra);

export const BLOCK_TYPES = {
  click: {
    label: 'Click',
    fields: [selector('selector', 'Element', { required: true }), timeout()],
  },
  type: {
    label: 'Type text',
    fields: [
      selector('selector', 'Input field', { required: true }),
      textarea('text', 'Text', '', { variable: true, hint: 'Tip: {{index}} inserts the run number' }),
      bool('clear', 'Clear the field first', true),
      bool('enter', 'Press Enter after typing', false),
      timeout(),
    ],
  },
  select: {
    label: 'Select / find in list',
    fields: [
      selector('selector', 'Dropdown or scrollable list', { required: true }),
      selector('opener', 'Click this first to open the list (optional)'),
      text('match', 'Value to find', '', { required: true, variable: true }),
      choice('matchMode', 'Match', [
        { value: 'exact', label: 'Exact text' },
        { value: 'contains', label: 'Contains text' },
      ], 'exact'),
      selector('item', 'Item selector (optional)', { hint: 'Leave empty to match any element in the list' }),
      number('maxScrolls', 'Max scroll attempts', 300, 1, 5000),
      timeout(),
    ],
  },
  wait: {
    label: 'Wait',
    fields: [
      choice('mode', 'Wait for', [
        { value: 'time', label: 'A fixed time' },
        { value: 'appear', label: 'Element to appear' },
        { value: 'disappear', label: 'Element to disappear' },
      ], 'time'),
      number('ms', 'Duration (ms)', 1000, 0, 600000, { show: (b) => b.mode === 'time' }),
      selector('selector', 'Element', { show: (b) => b.mode !== 'time', required: (b) => b.mode !== 'time' }),
      number('timeout', 'Give up after (ms)', 10000, 0, 600000, { show: (b) => b.mode !== 'time' }),
    ],
  },
  scroll: {
    label: 'Scroll',
    fields: [
      choice('mode', 'Action', [
        { value: 'by', label: 'Scroll by pixels' },
        { value: 'into-view', label: 'Bring element into view' },
      ], 'by'),
      selector('selector', 'Element', {
        hint: 'Leave empty to scroll the whole page',
        required: (b) => b.mode === 'into-view',
      }),
      number('amount', 'Pixels (negative scrolls up)', 500, -100000, 100000, { show: (b) => b.mode === 'by' }),
      timeout({ show: (b) => Boolean(b.selector) }),
    ],
  },
};

export const PLAN_FIELDS = {
  onError: ['stop', 'skip'],
  // What a data set gives once a run number is past its last value.
  whenShort: ['cycle', 'empty', 'stop'],
  split: ['auto', 'lines', 'comma'],
};

// Data set names double as {{placeholders}}; "index" is reserved for the run number.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function cleanDataName(raw) {
  const name = String(raw ?? '').trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^[^A-Za-z_]+/, '')
    .slice(0, LIMITS.dataName);
  return NAME_RE.test(name) && name !== 'index' ? name : '';
}

export function uniqueDataName(base, taken) {
  const name = cleanDataName(base) || 'list';
  if (!taken.includes(name)) return name;
  for (let i = 2; ; i++) if (!taken.includes(`${name}${i}`)) return `${name}${i}`;
}

export function newDataset(name, text = '') {
  return { id: newId(), name, text, split: 'auto' };
}

export function newId() {
  return crypto.randomUUID();
}

export function newBlock(type) {
  const def = BLOCK_TYPES[type];
  if (!def) throw new Error(`Unknown step type: ${type}`);
  const block = { id: newId(), type, enabled: true, collapsed: false, note: '' };
  for (const f of def.fields) block[f.key] = f.default;
  return block;
}

export function newPlan(name = 'Untitled plan') {
  return {
    id: newId(),
    name,
    blocks: [],
    datasets: [],
    runs: 1,
    whenShort: 'cycle',
    stepDelay: 300,
    runDelay: 1000,
    onError: 'stop',
  };
}

const isRequired = (f, b) => (typeof f.required === 'function' ? f.required(b) : Boolean(f.required));
export const isShown = (f, b) => !f.show || f.show(b);

// Returns a human-readable problem with the block, or null when it can run.
export function validateBlock(b) {
  const def = BLOCK_TYPES[b.type];
  if (!def) return 'Unknown step type.';
  for (const f of def.fields) {
    if (isShown(f, b) && isRequired(f, b) && !String(b[f.key] ?? '').trim()) return `"${f.label}" is required.`;
  }
  return null;
}

function cleanString(v, max, def = '') {
  return typeof v === 'string' ? v.slice(0, max) : def;
}

function cleanNumber(v, min, max, def) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanEnum(v, allowed, def) {
  return allowed.includes(v) ? v : def;
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function sanitizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const def = BLOCK_TYPES[raw.type];
  if (!def) return null;
  const block = {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId(),
    type: raw.type,
    enabled: raw.enabled !== false,
    collapsed: raw.collapsed === true,
    note: cleanString(raw.note, LIMITS.note),
  };
  for (const f of def.fields) {
    const v = raw[f.key];
    switch (f.kind) {
      case 'selector':
      case 'text':
      case 'textarea':
        block[f.key] = cleanString(v, f.maxLen, f.default);
        break;
      case 'number':
        block[f.key] = cleanNumber(v, f.min, f.max, f.default);
        break;
      case 'bool':
        block[f.key] = typeof v === 'boolean' ? v : f.default;
        break;
      case 'enum':
        block[f.key] = cleanEnum(v, f.options.map((o) => o.value), f.default);
        break;
    }
  }
  return block;
}

// Values in a data set: "auto" splits by lines when the text has more than
// one line, else by commas.
export function splitValues(text, split = 'auto') {
  if (typeof text !== 'string' || !text.trim()) return [];
  const mode = split === 'auto' ? (/\r?\n/.test(text.trim()) ? 'lines' : 'comma') : split;
  return text.split(mode === 'lines' ? /\r?\n/ : ',').map((s) => s.trim()).filter(Boolean);
}

const splitCount = (d) => splitValues(d.text, d.split).length;

// Data sets: unique valid names, text capped in total by LIMITS.data.
// Older plans are migrated: a single `data` list (v1.0) becomes a set named
// "value"; a `columns`/`rows` table becomes one set per column.
function sanitizeDatasets(raw) {
  let source = Array.isArray(raw.datasets) ? raw.datasets : null;
  if (!source && Array.isArray(raw.columns) && Array.isArray(raw.rows)) {
    source = raw.columns.map((name, i) => ({
      name,
      text: raw.rows.map((r) => (Array.isArray(r) && typeof r[i] === 'string' ? r[i].trim() : '')).filter(Boolean).join('\n'),
      split: 'lines',
    }));
  }
  if (!source && typeof raw.data === 'string' && raw.data.trim()) {
    source = [{ name: 'value', text: raw.data, split: raw.splitMode }];
  }

  const datasets = [];
  let size = 0;
  for (const d of (source || []).slice(0, LIMITS.datasets)) {
    if (!d || typeof d !== 'object') continue;
    const name = cleanDataName(d.name);
    if (!name || datasets.some((x) => x.name === name)) continue;
    const text = cleanString(d.text, LIMITS.data - size);
    size += text.length;
    datasets.push({
      id: typeof d.id === 'string' && ID_RE.test(d.id) ? d.id : newId(),
      name,
      text,
      split: cleanEnum(d.split, PLAN_FIELDS.split, 'auto'),
    });
  }
  return datasets;
}

// Accepts a bare plan or an export wrapper ({ format, plan }). Throws on a
// malformed root; silently drops unknown keys and counts unusable blocks.
// `fresh` regenerates every id so an import never collides with saved data.
export function sanitizePlan(raw, { fresh = false } = {}) {
  if (raw && typeof raw === 'object' && raw.format === 'clickflow-plan') raw = raw.plan;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('This is not a ClickFlow plan.');
  if (raw.blocks !== undefined && !Array.isArray(raw.blocks)) throw new Error('This plan has an invalid step list.');

  const base = newPlan();
  const rawBlocks = raw.blocks || [];
  const blocks = [];
  let dropped = Math.max(0, rawBlocks.length - LIMITS.blocks);
  for (const rb of rawBlocks.slice(0, LIMITS.blocks)) {
    const b = sanitizeBlock(rb);
    if (!b) { dropped++; continue; }
    if (fresh || blocks.some((x) => x.id === b.id)) b.id = newId();
    blocks.push(b);
  }

  const datasets = sanitizeDatasets(raw);
  if (fresh) datasets.forEach((d) => { d.id = newId(); });
  // Older plans had no run count: they ran once per data row, or `repeat` times.
  const legacyRuns = Array.isArray(raw.rows) ? raw.rows.length
    : typeof raw.data === 'string' && raw.data.trim() ? Math.max(...datasets.map((d) => splitCount(d)), 1)
      : raw.repeat;
  const plan = {
    id: !fresh && typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : base.id,
    name: cleanString(raw.name, LIMITS.name).trim() || base.name,
    blocks,
    datasets,
    runs: cleanNumber(raw.runs ?? legacyRuns, 1, LIMITS.runs, base.runs),
    whenShort: cleanEnum(raw.whenShort, PLAN_FIELDS.whenShort, base.whenShort),
    stepDelay: cleanNumber(raw.stepDelay, 0, 60000, base.stepDelay),
    runDelay: cleanNumber(raw.runDelay, 0, 600000, base.runDelay),
    onError: cleanEnum(raw.onError, PLAN_FIELDS.onError, base.onError),
  };
  return { plan, dropped };
}
