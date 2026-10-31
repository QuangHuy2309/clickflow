// UI language. The English text is the key; VI maps it to Vietnamese, and
// anything missing falls back to English. {name} placeholders are filled from
// `vars`, so translations can reorder them.

import { VI } from './i18n-vi.js';

export const LANGS = { en: 'English', vi: 'Tiếng Việt' };

let lang = 'en';

export function setLang(code) {
  lang = Object.hasOwn(LANGS, code) ? code : 'en';
}

export const getLang = () => lang;

export function t(key, vars) {
  let s = (lang === 'vi' && VI[key]) || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  return s;
}

// Static text in index.html: remembered once in English (before anything is
// rendered into the page), then rewritten whenever the language changes.
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
const texts = [];
const attrs = [];

export function captureStatic(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(n.nodeValue);
    if (/\p{L}/u.test(m[2])) texts.push({ node: n, key: m[2].replace(/\s+/g, ' '), pre: m[1], post: m[3] });
  }
  for (const el of root.querySelectorAll('*')) {
    for (const a of ATTRS) if (el.hasAttribute(a)) attrs.push({ el, attr: a, key: el.getAttribute(a) });
  }
}

export function translateStatic() {
  for (const x of texts) x.node.nodeValue = x.pre + t(x.key) + x.post;
  for (const x of attrs) x.el.setAttribute(x.attr, t(x.key));
  document.documentElement.lang = lang;
}
