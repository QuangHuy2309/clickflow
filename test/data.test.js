import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitValues, applyTemplate, templateBlock, planRuns, runCount, dataRef, usedDatasets,
  unknownPlaceholders, renameReferences, nameFromSelector,
} from '../src/shared/data.js';
import {
  sanitizePlan, newBlock, newPlan, newDataset, validateBlock, cleanDataName, uniqueDataName, LIMITS,
} from '../src/shared/schema.js';

const planWith = (datasets, blocks, extra = {}) => ({
  ...newPlan(),
  datasets: datasets.map(([name, text]) => newDataset(name, text)),
  blocks,
  ...extra,
});
const typeStep = (text) => ({ ...newBlock('type'), selector: '#f', text });

test('splitValues auto-detects lines vs commas', () => {
  assert.deepEqual(splitValues('alice, bob ,carol'), ['alice', 'bob', 'carol']);
  assert.deepEqual(splitValues('Smith, John\nDoe, Jane\n'), ['Smith, John', 'Doe, Jane']);
  assert.deepEqual(splitValues('a,b\nc', 'lines'), ['a,b', 'c']);
  assert.deepEqual(splitValues('a,b\nc', 'comma'), ['a', 'b\nc']);
  assert.deepEqual(splitValues('   '), []);
});

test('applyTemplate fills data set values and {{index}}', () => {
  const values = { name: 'bob', email: 'b@x.com' };
  assert.equal(applyTemplate('{{name}} <{{ email }}> #{{index}}', values, 2), 'bob <b@x.com> #3');
  assert.equal(applyTemplate('{{other}}', values, 0), '{{other}}');
  assert.equal(applyTemplate('{{name}}', { name: '$& $1' }, 0), '$& $1');
});

test('templateBlock only touches text fields and does not mutate', () => {
  const b = { ...newBlock('select'), selector: '#list-{{index}}', match: '{{city}}' };
  const t = templateBlock(b, { city: 'Paris' }, 0);
  assert.equal(t.selector, '#list-1');
  assert.equal(t.match, 'Paris');
  assert.equal(t.matchMode, 'exact');
  assert.equal(b.match, '{{city}}');
});

test('runCount: automatic mode uses the shortest data set the steps use', () => {
  const p = planWith([['names', 'alice\nbob\ncarol'], ['emails', 'a@x\nb@x'], ['unused', 'x']],
    [typeStep('{{names}}'), typeStep('{{emails}}')]);
  assert.equal(p.runsMode, 'auto', 'new plans count runs automatically');
  assert.deepEqual(runCount(p), { runs: 2, shortest: { name: 'emails', n: 2 } });
  assert.deepEqual(planRuns(p), [{ names: 'alice', emails: 'a@x', unused: 'x' }, { names: 'bob', emails: 'b@x', unused: 'x' }]);
  const one = planWith([['names', 'a, b, c, d']], [typeStep('{{names}}')]);
  assert.equal(runCount(one).runs, 4, 'a single data set: one run per value');
  assert.equal(runCount(planWith([], [typeStep('hi')])).runs, 1, 'no data sets used: one run');
  const disabled = planWith([['names', 'a\nb\nc'], ['short', 'x']], [typeStep('{{names}}'), { ...typeStep('{{short}}'), enabled: false }]);
  assert.equal(runCount(disabled).runs, 3, 'disabled steps do not count');
  assert.equal(runCount({ ...p, runsMode: 'fixed', runs: 7 }).runs, 7, 'fixed mode uses the number');
});

test('planRuns gives each data set its own list, per run', () => {
  const p = planWith([['names', 'alice\nbob\ncarol'], ['emails', 'a@x\nb@x']], [typeStep('{{names}}'), typeStep('{{emails}}')], { runs: 4, runsMode: 'fixed' });
  assert.deepEqual(planRuns(p), [
    { names: 'alice', emails: 'a@x' },
    { names: 'bob', emails: 'b@x' },
    { names: 'carol', emails: 'a@x' },
    { names: 'alice', emails: 'b@x' },
  ], 'cycle starts each short list over');
  assert.deepEqual(planRuns({ ...p, whenShort: 'empty' }).map((r) => r.emails), ['a@x', 'b@x', '', '']);
  assert.equal(planRuns({ ...p, whenShort: 'stop' }).length, 2, 'stop ends at the shortest used set');
  const unusedShort = planWith([['names', 'a\nb\nc'], ['unused', 'x']], [typeStep('{{names}}')], { runs: 3, runsMode: 'fixed', whenShort: 'stop' });
  assert.equal(planRuns(unusedShort).length, 3, 'unused sets do not shorten the job');
  assert.equal(planRuns({ ...newPlan(), runs: 3, runsMode: 'fixed' }).length, 3, 'fixed runs without any data');
});

test('dataRef, usedDatasets, unknownPlaceholders, renameReferences', () => {
  assert.equal(dataRef(' {{ email }} '), 'email');
  assert.equal(dataRef('Hi {{email}}'), null);
  const p = planWith([['name', 'a']], [typeStep('{{name}} {{email}} {{index}}')]);
  assert.deepEqual([...usedDatasets(p)].sort(), ['email', 'name']);
  assert.deepEqual(unknownPlaceholders(p), ['email']);
  renameReferences(p, 'name', 'full_name');
  assert.equal(p.blocks[0].text, '{{full_name}} {{email}} {{index}}');
});

test('data set names are sanitized and made unique', () => {
  assert.equal(cleanDataName(' first name '), 'first_name');
  assert.equal(cleanDataName('9lives'), 'lives');
  assert.equal(cleanDataName('index'), '');
  assert.equal(cleanDataName('<script>'), '_script_');
  assert.equal(uniqueDataName('email', ['email', 'email2']), 'email3');
  assert.equal(uniqueDataName('', []), 'list');
  assert.equal(nameFromSelector('#email'), 'email');
  assert.equal(nameFromSelector('input[name="user"]'), 'user');
  assert.equal(nameFromSelector('div > span:nth-of-type(2)'), '');
});

test('validateBlock reports missing required fields', () => {
  assert.match(validateBlock(newBlock('click')), /required/);
  assert.equal(validateBlock({ ...newBlock('click'), selector: '#go' }), null);
  assert.equal(validateBlock(newBlock('wait')), null);
  assert.match(validateBlock({ ...newBlock('wait'), mode: 'appear' }), /required/);
});

test('sanitizePlan migrates older data formats', () => {
  const v1 = sanitizePlan({ data: 'alice, bob', blocks: [{ type: 'type', selector: '#a', text: '{{value}}' }] }).plan;
  assert.deepEqual(v1.datasets.map((d) => [d.name, d.text]), [['value', 'alice, bob']]);
  assert.equal(v1.runs, 2, 'ran once per item');
  assert.equal(v1.data, undefined);

  const table = sanitizePlan({ columns: ['name', 'email'], rows: [['a', 'a@x'], ['b', ''], ['c', 'c@x']] }).plan;
  assert.deepEqual(table.datasets.map((d) => [d.name, d.text]), [['name', 'a\nb\nc'], ['email', 'a@x\nc@x']]);
  assert.equal(table.runs, 3);

  assert.equal(sanitizePlan({ repeat: 7 }).plan.runs, 7, 'repeat becomes runs');
});

test('sanitizePlan cleans data sets and run settings', () => {
  const { plan } = sanitizePlan({
    runs: 1e9,
    whenShort: 'explode',
    datasets: [
      { name: 'names', text: 'a\nb', split: 'lines', evil: 1 },
      { name: 'names', text: 'dup' },
      { name: 'bad name!', text: 42 },
      'nope',
      ...Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, text: '' })),
    ],
  });
  assert.equal(plan.runs, LIMITS.runs);
  assert.equal(plan.whenShort, 'cycle');
  assert.deepEqual(plan.datasets.slice(0, 2).map((d) => [d.name, d.text, d.split]), [['names', 'a\nb', 'lines'], ['bad_name_', '', 'auto']]);
  assert.equal(plan.datasets[0].evil, undefined);
  assert.ok(plan.datasets.length <= LIMITS.datasets);
});

test('sanitizePlan rejects non-plans', () => {
  assert.throws(() => sanitizePlan(null));
  assert.throws(() => sanitizePlan([1, 2]));
  assert.throws(() => sanitizePlan({ blocks: 'nope' }));
});

test('sanitizePlan drops unknown types and keys, clamps values', () => {
  const { plan, dropped } = sanitizePlan({
    format: 'clickflow-plan',
    plan: {
      name: '<img src=x onerror=alert(1)>',
      evil: 'x',
      stepDelay: -50,
      onError: 'explode',
      blocks: [
        { type: 'click', selector: '#a', onclick: 'alert(1)', timeout: '999999999' },
        { type: 'eval', code: 'alert(1)' },
        'garbage',
        { type: 'type', selector: 'x'.repeat(5000), text: 42 },
      ],
    },
  });
  assert.equal(dropped, 2);
  assert.equal(plan.evil, undefined);
  assert.equal(plan.name, '<img src=x onerror=alert(1)>', 'kept as inert text');
  assert.equal(plan.stepDelay, 0);
  assert.equal(plan.onError, 'stop');
  assert.equal(plan.blocks.length, 2);
  assert.equal(plan.blocks[0].onclick, undefined);
  assert.equal(plan.blocks[0].timeout, undefined, 'steps no longer have their own timeout');
  assert.equal(plan.timeout, LIMITS.timeout[1], 'the old step timeout moves to the plan, clamped');
  assert.equal(plan.blocks[1].selector.length, LIMITS.selector);
  assert.equal(plan.blocks[1].text, '');
});

test('sanitizePlan caps block count and regenerates ids when fresh', () => {
  const blocks = Array.from({ length: LIMITS.blocks + 5 }, () => ({ type: 'wait', id: 'same-id' }));
  const { plan, dropped } = sanitizePlan({ id: 'keep', blocks, datasets: [{ id: 'ds-1', name: 'a' }] }, { fresh: true });
  assert.equal(plan.blocks.length, LIMITS.blocks);
  assert.equal(dropped, 5);
  assert.notEqual(plan.id, 'keep');
  assert.notEqual(plan.datasets[0].id, 'ds-1');
  assert.equal(new Set(plan.blocks.map((b) => b.id)).size, LIMITS.blocks);
});

test('sanitizePlan: one shared element timeout, migrated from old per-step timeouts', () => {
  assert.equal(sanitizePlan({ blocks: [] }).plan.timeout, 5000, 'default');
  assert.equal(sanitizePlan({ timeout: 8000, blocks: [{ type: 'click', selector: '#a', timeout: 2000 }] }).plan.timeout, 8000, 'plan value wins');
  const old = sanitizePlan({ blocks: [
    { type: 'click', selector: '#a', timeout: 3000 },
    { type: 'type', selector: '#b', timeout: 3000 },
    { type: 'click', selector: '#c', timeout: 20000 },
  ] }).plan;
  assert.equal(old.timeout, 3000, 'the value most steps used');
  assert.equal(sanitizePlan({ blocks: [{ type: 'click', selector: '#a', timeout: 2000 }, { type: 'click', selector: '#b', timeout: 9000 }] }).plan.timeout, 9000, 'tie: the longer one');
  assert.equal(sanitizePlan({ timeout: 1 }).plan.timeout, LIMITS.timeout[0], 'clamped');
});
