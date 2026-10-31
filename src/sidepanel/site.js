// Works out whether ClickFlow may run on a tab, and which origin to ask for.
// Host access is optional and granted one site at a time.

import { t } from '../shared/i18n.js';

const RESTRICTED = [
  /^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-search|chrome-untrusted|chrome-extension|data|blob|javascript):/i,
  /^https:\/\/chromewebstore\.google\.com\//i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
];

export async function getAccess(tab) {
  if (!tab) return { kind: 'none' };
  const url = tab.url || tab.pendingUrl;
  if (!url) return { kind: 'unknown' };
  if (RESTRICTED.some((re) => re.test(url))) return { kind: 'restricted' };

  let u;
  try { u = new URL(url); } catch { return { kind: 'restricted' }; }

  let pattern;
  let host;
  if (u.protocol === 'file:') {
    if (!(await chrome.extension.isAllowedFileSchemeAccess())) return { kind: 'file-blocked' };
    pattern = 'file:///*';
    host = t('local files');
  } else if (u.protocol === 'http:' || u.protocol === 'https:') {
    pattern = `${u.protocol}//${u.hostname}/*`;
    host = u.hostname;
  } else {
    return { kind: 'restricted' };
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  return { kind: granted ? 'granted' : 'needs', pattern, host };
}

export function friendlyError(message = '') {
  if (/cannot access|cannot be scripted|missing host permission|permission/i.test(message)) {
    return t('ClickFlow doesn’t have access to this page. Allow it on this site and try again.');
  }
  if (/no tab with id|tab was closed/i.test(message)) return t('The tab was closed.');
  if (/frame.*removed|navigat/i.test(message)) return t('The page navigated away during this step.');
  return message || t('Something went wrong.');
}
