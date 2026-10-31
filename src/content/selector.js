// Shared by the picker and the recorder: builds a short, unique, stable CSS
// selector for an element. Exposed as window.__clickflowSelector.
(() => {
  if (window.__clickflowSelector) return;

  const unique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };
  const quote = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const stableId = (id) => id.length < 60 && !/\d{4,}|[0-9a-f]{8,}|^[\d:_-]|:/i.test(id);
  const stableClass = (c) => c.length < 40 && !/\d{3,}/.test(c)
    && !/^(css|sc|jsx|emotion|svelte)-/.test(c)
    && !/(^|[-_])(active|hover|focus|focused|selected|open|show|visible|disabled)$/i.test(c);

  const ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder', 'title', 'alt'];

  function build(el) {
    if (el.id && stableId(el.id) && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    const tag = el.localName;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length < 80) {
        const sel = `${tag}[${a}="${quote(v)}"]`;
        if (unique(sel)) return sel;
      }
    }
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
      let seg;
      if (cur.id && stableId(cur.id)) {
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

  window.__clickflowSelector = { build };
})();
