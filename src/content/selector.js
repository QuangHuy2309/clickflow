// Shared by the picker and the recorder: builds a short, unique, stable CSS
// selector for an element. Exposed as window.__clickflowSelector.
//
// Preference order: meaningful attributes (name/aria-label/placeholder for
// form fields, test ids, link targets) > hand-written ids > generated ids >
// a structural path. Many sites (Google, React/CSS-in-JS apps) generate ids
// and class names that change between page loads, so those are avoided.
(() => {
  if (window.__clickflowSelector) return;

  const unique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };
  const quote = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // e.g. "ti6dpd", "C6AK7c", ":r3:", "ember123", "a1b2c3d4"
  const looksGenerated = (s) => /\d{4,}|[0-9a-f]{8,}|^[\d:_-]|:/i.test(s)
    || (/^[A-Za-z0-9]{4,10}$/.test(s) && /[a-z]\d|\d[a-z]/i.test(s));
  const stableId = (id) => id.length < 60 && !looksGenerated(id);
  const stableClass = (c) => c.length < 40 && !looksGenerated(c)
    && !/^(css|sc|jsx|emotion|svelte)-/.test(c)
    && !/(^|[-_])(active|hover|focus|focused|selected|open|show|visible|disabled)$/i.test(c);

  const FIELD_ATTRS = ['name', 'aria-label', 'placeholder'];
  const ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name', 'title', 'alt'];
  const isField = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;

  function byAttr(el, attrs) {
    const tag = el.localName;
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v && v.length < 100) {
        const sel = `${tag}[${a}="${quote(v)}"]`;
        if (unique(sel)) return sel;
      }
    }
    return null;
  }

  function byHref(el) {
    if (el.localName !== 'a') return null;
    const href = el.getAttribute('href');
    if (!href || href.length > 200 || href === '#' || /^javascript:/i.test(href)) return null;
    const sel = `a[href="${quote(href)}"]`;
    return unique(sel) ? sel : null;
  }

  function byPath(el) {
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
      let seg;
      if (cur !== el && cur.id && stableId(cur.id)) {
        seg = `#${CSS.escape(cur.id)}`;
      } else {
        seg = cur.localName + [...cur.classList].filter(stableClass).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
        const parent = cur.parentElement;
        if (parent) {
          const same = [...parent.children].filter((c) => c.localName === cur.localName);
          if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(seg);
      const sel = parts.join(' > ');
      if (unique(sel)) return sel;
    }
    return parts.join(' > ');
  }

  function build(el) {
    if (el === document.documentElement || el === document.body) return el.localName;
    const idSel = el.id ? `#${CSS.escape(el.id)}` : null;
    return (isField(el) && byAttr(el, FIELD_ATTRS))
      || (idSel && stableId(el.id) && unique(idSel) && idSel)
      || byAttr(el, ATTRS)
      || byHref(el)
      || (idSel && el.id.length < 60 && unique(idSel) && idSel)
      || byPath(el);
  }

  window.__clickflowSelector = { build, looksGenerated };
})();
