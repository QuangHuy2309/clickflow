// Presentation metadata for block types: icon, description, one-line summary.

import { t } from '../shared/i18n.js';
import { BLOCK_TYPES, waitAfterMs } from '../shared/schema.js';

export const BLOCK_UI = {
  click: { icon: 'click', desc: 'Click a button, link or any element' },
  type: { icon: 'type', desc: 'Type text into a field (supports {{value}})' },
  select: { icon: 'select', desc: 'Pick a dropdown option or scroll a list to find it' },
  wait: { icon: 'wait', desc: 'Pause for a while or until something appears' },
  scroll: { icon: 'scroll', desc: 'Scroll the page or an element' },
  screenshot: { icon: 'camera', desc: 'Capture the page or one element as an image' },
  rows: { icon: 'rows', desc: 'Click in every row of a list that matches a rule' },
};

const CLICK_VERB = { left: 'Click', right: 'Right-click', double: 'Double-click' };

const short = (s, n = 28) => {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

// "{{email}}" reads as "email (data set)"; other text is quoted.
const value = (s, n) => {
  const m = /^\s*\{\{\s*([A-Za-z_]\w*)\s*\}\}\s*$/.exec(String(s || ''));
  return m ? t('{name} (data set)', { name: m[1] }) : `“${short(s, n)}”`;
};

export const duration = (ms) => (ms >= 1000 ? `${+(ms / 1000).toFixed(2)} s` : `${ms} ms`);

// "30 s", "2 min": a step's "Then wait".
export const waitText = (b) => (b.waitUnit === 'm' ? `${b.waitAfter} min` : `${b.waitAfter} s`);

const OP_TEXT = { eq: '=', ne: '≠', gt: '>', lt: '<' };

function describe(b) {
  const sel = short(b.selector) || t('no element yet');
  switch (b.type) {
    case 'click':
      return b.selector ? `${t(CLICK_VERB[b.button] || 'Click')} ${sel}` : t('Choose an element to click');
    case 'screenshot':
      return `${b.selector ? sel : t('Visible page')} → ${short(b.name, 22) || 'screenshot'}.png`;
    case 'type':
      return `${value(b.text, 20)} → ${sel}`;
    case 'select':
      return t('Find {value} in {sel}', { value: value(b.match, 18), sel });
    case 'wait':
      if (b.mode === 'time') return duration(b.ms);
      return t(b.mode === 'appear' ? 'Until {sel} appears' : 'Until {sel} disappears', { sel });
    case 'scroll':
      if (b.mode === 'into-view') return t('Bring {sel} into view', { sel });
      return t(b.selector ? '{dir} {px}px in {sel}' : '{dir} {px}px on page', { dir: t(b.amount >= 0 ? 'Down' : 'Up'), px: Math.abs(b.amount), sel });
    case 'rows': {
      if (!b.target) return t('Choose what to click in each row');
      const what = t('Click {sel} in each row', { sel: short(b.target, 22) });
      const rule = b.op === 'any' ? '' : ` · ${short(b.cell, 16) || '?'} ${b.op === 'contains' ? t('contains') : OP_TEXT[b.op]} ${value(b.value, 12)}`;
      return `${what}${rule}${b.onlyTicked ? ` · ${t('ticked only')}` : ''}`;
    }
    default:
      return '';
  }
}

export function summarize(b) {
  const text = describe(b);
  return waitAfterMs(b) ? `${text} · ${t('then wait {time}', { time: waitText(b) })}` : text;
}

export const typeLabel = (type) => t(BLOCK_TYPES[type].label);
