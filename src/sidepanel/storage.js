// Plans persist only in chrome.storage.local on this device.

import { LANGS, t } from '../shared/i18n.js';
import { LIMITS, newPlan, sanitizePlan } from '../shared/schema.js';

export async function loadState() {
  const raw = await chrome.storage.local.get(['plans', 'currentPlanId', 'lang']);
  const plans = [];
  for (const p of Array.isArray(raw.plans) ? raw.plans.slice(0, LIMITS.plans) : []) {
    try { plans.push(sanitizePlan(p).plan); } catch { /* skip corrupt entry */ }
  }
  if (!plans.length) plans.push(newPlan('My first plan'));
  const currentId = plans.some((p) => p.id === raw.currentPlanId) ? raw.currentPlanId : plans[0].id;
  // Language: the saved choice, else Vietnamese for a Vietnamese Chrome.
  const lang = Object.hasOwn(LANGS, raw.lang) ? raw.lang : (/^vi/i.test(chrome.i18n.getUILanguage()) ? 'vi' : 'en');
  return { plans, currentId, lang };
}

export function saveLang(lang) {
  chrome.storage.local.set({ lang });
}

let timer = null;
let pending = null;

export function saveState(state) {
  pending = { plans: state.plans, currentPlanId: state.currentId };
  clearTimeout(timer);
  timer = setTimeout(flushState, 250);
}

export function flushState() {
  clearTimeout(timer);
  if (!pending) return;
  chrome.storage.local.set(pending);
  pending = null;
}

export function exportPlan(plan) {
  const { id, ...rest } = plan;
  const json = JSON.stringify({ format: 'clickflow-plan', version: 1, plan: rest }, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const slug = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}.clickflow.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readImportFile(file) {
  if (file.size > LIMITS.importBytes) throw new Error(t('That file is too large to be a ClickFlow plan.'));
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(t('That file is not valid JSON.'));
  }
  return sanitizePlan(data, { fresh: true });
}
