// Data sets → per-run values, and {{name}} templating.

import { BLOCK_TYPES, LIMITS, splitValues } from './schema.js';

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export { splitValues };

export const datasetValues = (d) => splitValues(d.text, d.split);

// {{name}} → that data set's value for this run; {{index}} → 1-based run number.
export function applyTemplate(str, values, runIndex) {
  return str.replace(PLACEHOLDER_RE, (match, key) => {
    if (key === 'index') return String(runIndex + 1);
    return Object.hasOwn(values, key) ? values[key] : match;
  });
}

export function templateBlock(block, values, runIndex) {
  const out = { ...block };
  for (const f of BLOCK_TYPES[block.type].fields) {
    if (typeof out[f.key] === 'string' && f.kind !== 'enum') out[f.key] = applyTemplate(out[f.key], values, runIndex);
  }
  return out;
}

export function placeholders(str) {
  return [...String(str).matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

// If the whole field is one placeholder, returns the data set name.
export function dataRef(str) {
  const m = /^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(String(str));
  return m ? m[1] : null;
}

function eachTextField(plan, fn, { enabledOnly = false } = {}) {
  for (const b of plan.blocks) {
    if (enabledOnly && !b.enabled) continue;
    for (const f of BLOCK_TYPES[b.type].fields) if (typeof b[f.key] === 'string') fn(b, f);
  }
}

// Names of data sets used by the plan's steps.
export function usedDatasets(plan, opts) {
  const used = new Set();
  eachTextField(plan, (b, f) => { for (const p of placeholders(b[f.key])) used.add(p); }, opts);
  used.delete('index');
  return used;
}

// Placeholders used by enabled steps that don't match any data set.
export function unknownPlaceholders(plan) {
  const known = new Set(plan.datasets.map((d) => d.name));
  return [...usedDatasets(plan, { enabledOnly: true })].filter((p) => !known.has(p));
}

// Renames {{from}} to {{to}} in every step.
export function renameReferences(plan, from, to) {
  const re = new RegExp(`\\{\\{\\s*${from}\\s*\\}\\}`, 'g');
  eachTextField(plan, (b, f) => { b[f.key] = b[f.key].replace(re, `{{${to}}}`); });
}

// How many runs a plan does. "auto": one per value of the shortest data set
// the enabled steps use (1 if they use none). "fixed": plan.runs.
export function runCount(plan) {
  const used = usedDatasets(plan, { enabledOnly: true });
  const lengths = plan.datasets.filter((d) => used.has(d.name)).map((d) => ({ name: d.name, n: datasetValues(d).length }));
  const shortest = lengths.reduce((min, x) => (!min || x.n < min.n ? x : min), null);
  if (plan.runsMode === 'auto') return { runs: Math.min(shortest ? shortest.n : 1, LIMITS.runs), shortest };
  return { runs: Math.min(plan.runs, LIMITS.runs), shortest };
}

// The values each run gets, as { setName: value } objects. With a fixed run
// count, a set with fewer values than runs either starts over ("cycle"),
// gives "" ("empty"), or ends the whole job early ("stop", counting only sets
// the steps actually use).
export function planRuns(plan) {
  const sets = plan.datasets.map((d) => ({ name: d.name, values: datasetValues(d) }));
  let { runs, shortest } = runCount(plan);
  if (plan.runsMode !== 'auto' && plan.whenShort === 'stop' && shortest) runs = Math.min(runs, shortest.n);
  return Array.from({ length: runs }, (_, i) => Object.fromEntries(sets.map((s) => {
    if (!s.values.length) return [s.name, ''];
    if (i < s.values.length) return [s.name, s.values[i]];
    return [s.name, plan.whenShort === 'cycle' ? s.values[i % s.values.length] : ''];
  })));
}

// A readable name for a field, e.g. "#email" → "email".
export function nameFromSelector(selector) {
  const s = String(selector);
  const m = /#([A-Za-z][\w-]*)\s*$/.exec(s)
    || /\[(?:name|aria-label|placeholder|data-testid|title)="([^"]+)"\]\s*$/.exec(s);
  return m ? m[1] : '';
}
