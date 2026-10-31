// Tiny DOM builder. Children are appended as nodes or text — never parsed as
// HTML — so user and imported content can't inject markup.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || (k in el && typeof v !== 'string')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// 24×24 stroke icons (static path data only).
const ICONS = {
  click: 'M9 9l11 4-5 1.5L13.5 20z M4 4l2.5 2.5 M10 3v3 M3 10h3',
  type: 'M5 7V5h14v2 M12 5v14 M9 19h6',
  select: 'M4 6h11 M4 12h11 M4 18h7 M15 17l2.5 2.5L22 15',
  wait: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z M12 8v4l3 2',
  scroll: 'M12 3v18 M8 7l4-4 4 4 M8 17l4 4 4-4',
  rows: 'M4 5h16v14H4z M4 10h16 M4 15h16 M9 5v14',
  grip: 'M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01',
  plus: 'M12 5v14 M5 12h14',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  chevron: 'M9 6l6 6-6 6',
  play: 'M7 5l12 7-12 7z',
  pause: 'M8 5v14 M16 5v14',
  stop: 'M6 6h12v12H6z',
  record: 'M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4z M15.5 13a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z',
  log: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  download: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  close: 'M6 6l12 12 M18 6L6 18',
  search: 'M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z M20 20l-4.5-4.5',
  target: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z M12 2v4 M12 18v4 M2 12h4 M18 12h4',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  shield: 'M12 3l8 3v6c0 4.5-3.5 8-8 9-4.5-1-8-4.5-8-9V6z',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 8v5 M12 16h.01 M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
};

const SVG = 'http://www.w3.org/2000/svg';

export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon icon-${name}`);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}
