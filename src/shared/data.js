// Data list parsing and {{value}} templating.

import { BLOCK_TYPES } from './schema.js';

// "auto" splits by lines when the text has more than one line, else by commas.
export function parseDataList(text, mode = 'auto') {
  if (typeof text !== 'string' || !text.trim()) return [];
  const resolved = mode === 'auto' ? (/\r?\n/.test(text.trim()) ? 'lines' : 'comma') : mode;
  const parts = resolved === 'lines' ? text.split(/\r?\n/) : text.split(',');
  return parts.map((s) => s.trim()).filter(Boolean);
}

export function applyTemplate(str, value, runIndex) {
  return str.replace(/\{\{\s*(value|index)\s*\}\}/g, (_, key) => (key === 'value' ? value : String(runIndex + 1)));
}

// Fills placeholders in every text-like field of a block for one run.
export function templateBlock(block, value, runIndex) {
  const out = { ...block };
  for (const f of BLOCK_TYPES[block.type].fields) {
    if (typeof out[f.key] === 'string' && f.kind !== 'enum') out[f.key] = applyTemplate(out[f.key], value, runIndex);
  }
  return out;
}
