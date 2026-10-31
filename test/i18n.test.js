import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VI } from '../src/shared/i18n-vi.js';
import { setLang, t } from '../src/shared/i18n.js';
import { collectKeys } from './i18n-keys.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const placeholders = (s) => [...s.matchAll(/\{\{?\w+\}?\}/g)].map((m) => m[0]).sort();

test('every UI string has a Vietnamese translation', () => {
  const missing = [...collectKeys(root)].filter((k) => !VI[k]);
  assert.deepEqual(missing, [], `add these to src/shared/i18n-vi.js:\n${missing.join('\n')}`);
});

test('translations keep every {placeholder}', () => {
  const broken = Object.entries(VI).filter(([en, vi]) => placeholders(en).join() !== placeholders(vi).join()).map(([en]) => en);
  assert.deepEqual(broken, []);
});

test('no stale translations', () => {
  const keys = collectKeys(root);
  const stale = Object.keys(VI).filter((k) => !keys.has(k) && k !== 'OK');
  assert.deepEqual(stale, [], `no longer used:\n${stale.join('\n')}`);
});

test('t() fills placeholders and falls back to English', () => {
  setLang('vi');
  assert.equal(t('Run {run}/{runs} · Step {step}/{steps}', { run: 1, runs: 3, step: 2, steps: 5 }), 'Lượt 1/3 · Bước 2/5');
  assert.equal(t('Not translated {x}', { x: 1 }), 'Not translated 1');
  assert.equal(t('Tip: {{index}} inserts the run number'), 'Mẹo: {{index}} chèn số thứ tự lượt chạy');
  setLang('xx');
  assert.equal(t('Run'), 'Run', 'unknown language falls back to English');
});
