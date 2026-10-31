import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDataList, parsePaste, applyTemplate, templateBlock, runRows, columnRef,
  unknownPlaceholders, renameReferences, nameFromSelector,
} from '../src/shared/data.js';
import { sanitizePlan, newBlock, newPlan, validateBlock, cleanColumnName, uniqueColumnName, LIMITS } from '../src/shared/schema.js';

test('parseDataList auto-detects lines vs commas', () => {
  assert.deepEqual(parseDataList('alice, bob ,carol'), ['alice', 'bob', 'carol']);
  assert.deepEqual(parseDataList('Smith, John\nDoe, Jane\n'), ['Smith, John', 'Doe, Jane']);
  assert.deepEqual(parseDataList('   '), []);
});

test('parsePaste handles spreadsheets, CSV and single-column lists', () => {
  assert.deepEqual(parsePaste('alice\ta@x.com\nbob\tb@x.com\n', 2), [['alice', 'a@x.com'], ['bob', 'b@x.com']]);
  assert.deepEqual(parsePaste('alice, a@x.com\r\nbob,b@x.com', 2), [['alice', 'a@x.com'], ['bob', 'b@x.com']]);
  assert.deepEqual(parsePaste('alice, bob, carol', 1), [['alice'], ['bob'], ['carol']]);
  assert.deepEqual(parsePaste('Smith, John\nDoe, Jane', 1), [['Smith, John'], ['Doe, Jane']]);
  assert.deepEqual(parsePaste('a\t\n\t\nb\tc', 2), [['a', ''], ['b', 'c']], 'blank rows dropped');
});

test('applyTemplate fills named columns, legacy {{value}} and {{index}}', () => {
  const row = { name: 'bob', email: 'b@x.com' };
  assert.equal(applyTemplate('{{name}} <{{ email }}> #{{index}}', row, 2), 'bob <b@x.com> #3');
  assert.equal(applyTemplate('{{value}}', row, 0, ['name', 'email']), 'bob', '{{value}} falls back to first column');
  assert.equal(applyTemplate('{{other}}', row, 0), '{{other}}');
  assert.equal(applyTemplate('{{name}}', { name: '$& $1' }, 0), '$& $1');
});

test('templateBlock only touches text fields and does not mutate', () => {
  const b = { ...newBlock('select'), selector: '#list-{{index}}', match: '{{city}}' };
  const t = templateBlock(b, { city: 'Paris' }, 0, ['city']);
  assert.equal(t.selector, '#list-1');
  assert.equal(t.match, 'Paris');
  assert.equal(t.matchMode, 'exact');
  assert.equal(b.match, '{{city}}');
});

test('runRows skips empty rows and keys cells by column', () => {
  const plan = { ...newPlan(), columns: ['name', 'email'], rows: [['a', 'a@x'], ['', ' '], ['b', '']] };
  assert.deepEqual(runRows(plan), [{ name: 'a', email: 'a@x' }, { name: 'b', email: '' }]);
});

test('columnRef, unknownPlaceholders and renameReferences', () => {
  assert.equal(columnRef(' {{ email }} '), 'email');
  assert.equal(columnRef('Hi {{email}}'), null);
  const plan = { ...newPlan(), columns: ['name'], blocks: [{ ...newBlock('type'), selector: '#a', text: '{{name}} {{email}} {{index}}' }] };
  assert.deepEqual(unknownPlaceholders(plan), ['email']);
  renameReferences(plan, 'name', 'full_name');
  assert.equal(plan.blocks[0].text, '{{full_name}} {{email}} {{index}}');
});

test('column names are sanitized and made unique', () => {
  assert.equal(cleanColumnName(' first name '), 'first_name');
  assert.equal(cleanColumnName('9lives'), 'lives');
  assert.equal(cleanColumnName('index'), '');
  assert.equal(cleanColumnName('<script>'), '_script_');
  assert.equal(uniqueColumnName('email', ['email', 'email2']), 'email3');
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

test('sanitizePlan migrates v1.0 data text into a one-column table', () => {
  assert.deepEqual(sanitizePlan({ data: 'alice, bob' }).plan.rows, [['alice'], ['bob']]);
  const { plan } = sanitizePlan({ data: 'Smith, John\nDoe, Jane', splitMode: 'auto' });
  assert.deepEqual(plan.columns, ['value']);
  assert.deepEqual(plan.rows, [['Smith, John'], ['Doe, Jane']]);
  assert.equal(plan.data, undefined);
});

test('sanitizePlan cleans the table', () => {
  const { plan } = sanitizePlan({
    columns: ['name', 'name', 'bad name!', 42, 'index', ...Array(30).fill('x')],
    rows: [['a', 'b', 'c', 'extra'], 'nope', [1, null]],
  });
  assert.deepEqual(plan.columns.slice(0, 3), ['name', 'bad_name_', 'x']);
  assert.ok(plan.columns.length <= LIMITS.columns);
  assert.deepEqual(plan.rows[0], ['a', 'b', 'c']);
  assert.deepEqual(plan.rows[1], ['', '', ''], 'non-string cells become empty');
  assert.equal(plan.rows.length, 2);
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
      repeat: 1e9,
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
  assert.equal(plan.repeat, LIMITS.runs);
  assert.equal(plan.onError, 'stop');
  assert.equal(plan.blocks.length, 2);
  assert.equal(plan.blocks[0].onclick, undefined);
  assert.equal(plan.blocks[0].timeout, 120000);
  assert.equal(plan.blocks[1].selector.length, LIMITS.selector);
  assert.equal(plan.blocks[1].text, '{{value}}');
});

test('sanitizePlan caps block count and regenerates ids when fresh', () => {
  const blocks = Array.from({ length: LIMITS.blocks + 5 }, () => ({ type: 'wait', id: 'same-id' }));
  const { plan, dropped } = sanitizePlan({ id: 'keep', blocks }, { fresh: true });
  assert.equal(plan.blocks.length, LIMITS.blocks);
  assert.equal(dropped, 5);
  assert.notEqual(plan.id, 'keep');
  assert.equal(new Set(plan.blocks.map((b) => b.id)).size, LIMITS.blocks);
});
