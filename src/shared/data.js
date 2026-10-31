// Data table helpers: run rows, {{column}} templating, and paste parsing.

import { BLOCK_TYPES } from './schema.js';

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// A list of values: "auto" splits by lines when there is more than one line,
// else by commas.
export function parseDataList(text, mode = 'auto') {
  if (typeof text !== 'string' || !text.trim()) return [];
  const resolved = mode === 'auto' ? (/\r?\n/.test(text.trim()) ? 'lines' : 'comma') : mode;
  const parts = resolved === 'lines' ? text.split(/\r?\n/) : text.split(',');
  return parts.map((s) => s.trim()).filter(Boolean);
}

// Pasted text → rows of cells. Lines are rows; cells split on tabs (Excel /
// Sheets) or, for multi-column tables, commas. A single comma-separated line
// pasted into a one-column table becomes one row per item.
export function parsePaste(text, columnCount) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const hasTabs = text.includes('\t');
  if (columnCount === 1 && !hasTabs) return parseDataList(text).map((v) => [v]);
  return lines
    .map((line) => (hasTabs ? line.split('\t') : line.split(',')).map((c) => c.trim()))
    .filter((cells) => cells.some(Boolean));
}

// Rows that contain at least one value, as { column: value } objects.
export function runRows(plan) {
  return plan.rows
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(plan.columns.map((c, i) => [c, r[i] ?? ''])));
}

// {{column}} → that column; {{value}} → the first column when no column is
// named "value" (plans from v1.0); {{index}} → 1-based run number.
export function applyTemplate(str, row, runIndex, columns = Object.keys(row)) {
  return str.replace(PLACEHOLDER_RE, (match, key) => {
    if (key === 'index') return String(runIndex + 1);
    if (Object.hasOwn(row, key)) return row[key];
    if (key === 'value' && columns.length) return row[columns[0]] ?? '';
    return match;
  });
}

export function templateBlock(block, row, runIndex, columns) {
  const out = { ...block };
  for (const f of BLOCK_TYPES[block.type].fields) {
    if (typeof out[f.key] === 'string' && f.kind !== 'enum') out[f.key] = applyTemplate(out[f.key], row, runIndex, columns);
  }
  return out;
}

export function placeholders(str) {
  return [...String(str).matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

// If the whole field is one placeholder, returns its column name.
export function columnRef(str) {
  const m = /^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(String(str));
  return m ? m[1] : null;
}

// Placeholders used by a plan's steps that don't match any column.
export function unknownPlaceholders(plan) {
  const known = new Set([...plan.columns, 'index', 'value']);
  const missing = new Set();
  for (const b of plan.blocks) {
    if (!b.enabled) continue;
    for (const f of BLOCK_TYPES[b.type].fields) {
      if (typeof b[f.key] === 'string') for (const p of placeholders(b[f.key])) if (!known.has(p)) missing.add(p);
    }
  }
  return [...missing];
}

// Renames {{old}} to {{new}} in every step.
export function renameReferences(plan, from, to) {
  const re = new RegExp(`\\{\\{\\s*${from}\\s*\\}\\}`, 'g');
  for (const b of plan.blocks) {
    for (const f of BLOCK_TYPES[b.type].fields) {
      if (typeof b[f.key] === 'string') b[f.key] = b[f.key].replace(re, `{{${to}}}`);
    }
  }
}

// A readable column name for a field, e.g. "#email" → "email".
export function nameFromSelector(selector) {
  const s = String(selector);
  const m = /#([A-Za-z][\w-]*)\s*$/.exec(s)
    || /\[(?:name|aria-label|placeholder|data-testid|title)="([^"]+)"\]\s*$/.exec(s);
  return m ? m[1] : '';
}
