// Presentation metadata for block types: icon, description, one-line summary.

export const BLOCK_UI = {
  click: { icon: 'click', desc: 'Click a button, link or any element' },
  type: { icon: 'type', desc: 'Type text into a field (supports {{value}})' },
  select: { icon: 'select', desc: 'Pick a dropdown option or scroll a list to find it' },
  wait: { icon: 'wait', desc: 'Pause for a while or until something appears' },
  scroll: { icon: 'scroll', desc: 'Scroll the page or an element' },
};

const short = (s, n = 28) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const duration = (ms) => (ms >= 1000 ? `${+(ms / 1000).toFixed(2)} s` : `${ms} ms`);

export function summarize(b) {
  const sel = short(b.selector) || 'no element yet';
  switch (b.type) {
    case 'click':
      return b.selector ? `Click ${sel}` : 'Choose an element to click';
    case 'type':
      return `“${short(b.text, 20)}” → ${sel}`;
    case 'select':
      return `Find “${short(b.match, 18)}” in ${sel}`;
    case 'wait':
      if (b.mode === 'time') return duration(b.ms);
      return `Until ${sel} ${b.mode === 'appear' ? 'appears' : 'disappears'}`;
    case 'scroll':
      if (b.mode === 'into-view') return `Bring ${sel} into view`;
      return `${b.amount >= 0 ? 'Down' : 'Up'} ${Math.abs(b.amount)}px ${b.selector ? `in ${sel}` : 'on page'}`;
    default:
      return '';
  }
}
