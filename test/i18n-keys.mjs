// Collects every English UI string that should have a translation: t('…')
// calls, page-side error keys, block definitions, and the static text of
// index.html. Used by i18n.test.js.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCK_TYPES } from '../src/shared/schema.js';
import { BLOCK_UI } from '../src/sidepanel/blocks.js';

// Text that is the same in every language.
export const SAME = new Set(['ClickFlow', 'Quang Huy', 'lqhuy2309@gmail.com', 'Luong Quang Huy · Techcombank · 2309 1999 09', 'English', 'Tiếng Việt']);

// A JS string literal's value ('…' or "…", no template literals).
const unquote = (lit) => JSON.parse(lit[0] === "'" ? `"${lit.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : lit);
const STR = String.raw`('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")`;

export function collectKeys(root) {
  const keys = new Set();
  const src = (dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(root, dir, f), 'utf8'));
  for (const code of [...src('src/sidepanel'), ...src('src/shared')]) {
    // t('…'), and both branches of t(cond ? '…' : '…')
    for (const m of code.matchAll(new RegExp(String.raw`\bt\(\s*(?:[^()?]*\?\s*)?${STR}(?:\s*:\s*${STR})?`, 'g'))) {
      keys.add(unquote(m[1]));
      if (m[2]) keys.add(unquote(m[2]));
    }
  }
  // Page-side errors: StepError('…'), { key: '…' } and message = '…'.
  const actions = readFileSync(join(root, 'src/content/actions.js'), 'utf8');
  for (const m of actions.matchAll(new RegExp(String.raw`(?:StepError\(|key:\s*|message = )${STR}`, 'g'))) keys.add(unquote(m[1]));
  for (const def of Object.values(BLOCK_TYPES)) {
    keys.add(def.label);
    for (const f of def.fields) {
      keys.add(f.label);
      if (f.hint) keys.add(f.hint);
      for (const o of f.options || []) keys.add(o.label);
    }
  }
  for (const ui of Object.values(BLOCK_UI)) keys.add(ui.desc);
  // Notes are stored in English and shown through t().
  for (const m of readFileSync(join(root, 'src/sidepanel/panel.js'), 'utf8').matchAll(new RegExp(String.raw`\.note = ${STR}`, 'g'))) keys.add(unquote(m[1]));
  for (const verb of ['Click', 'Right-click', 'Double-click']) keys.add(verb);
  // index.html: text between tags, and title/aria-label/placeholder/alt.
  const html = readFileSync(join(root, 'src/sidepanel/index.html'), 'utf8').replace(/<head>[\s\S]*<\/head>/, '');
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const text = m[1].replace(/\s+/g, ' ').trim().replace(/&amp;/g, '&');
    if (/\p{L}/u.test(text)) keys.add(text);
  }
  for (const m of html.matchAll(/\s(?:title|aria-label|placeholder|alt)="([^"]+)"/g)) keys.add(m[1]);
  for (const k of SAME) keys.delete(k);
  return keys;
}
