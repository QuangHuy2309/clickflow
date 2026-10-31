import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDataList, applyTemplate, templateBlock } from '../src/shared/data.js';
import { sanitizePlan, newBlock, validateBlock, LIMITS } from '../src/shared/schema.js';

test('parseDataList auto-detects lines vs commas', () => {
  assert.deepEqual(parseDataList('alice, bob ,carol'), ['alice', 'bob', 'carol']);
  assert.deepEqual(parseDataList('Smith, John\nDoe, Jane\n'), ['Smith, John', 'Doe, Jane']);
  assert.deepEqual(parseDataList('a\r\n\r\n b \r\n'), ['a', 'b']);
  assert.deepEqual(parseDataList('   '), []);
  assert.deepEqual(parseDataList(undefined), []);
});

test('parseDataList honours explicit mode', () => {
  assert.deepEqual(parseDataList('a,b\nc', 'lines'), ['a,b', 'c']);
  assert.deepEqual(parseDataList('a,b\nc', 'comma'), ['a', 'b\nc']);
});

test('applyTemplate fills value and 1-based index', () => {
  assert.equal(applyTemplate('Hi {{value}} #{{ index }}', 'bob', 2), 'Hi bob #3');
  assert.equal(applyTemplate('{{other}}', 'x', 0), '{{other}}');
  assert.equal(applyTemplate('{{value}}', '$& $1', 0), '$& $1');
});

test('templateBlock only touches text fields', () => {
  const b = { ...newBlock('select'), selector: '#list-{{index}}', match: '{{value}}' };
  const t = templateBlock(b, 'Paris', 0);
  assert.equal(t.selector, '#list-1');
  assert.equal(t.match, 'Paris');
  assert.equal(t.matchMode, 'exact');
  assert.equal(b.match, '{{value}}', 'original block is not mutated');
});

test('validateBlock reports missing required fields', () => {
  assert.match(validateBlock(newBlock('click')), /required/);
  assert.equal(validateBlock({ ...newBlock('click'), selector: '#go' }), null);
  assert.equal(validateBlock(newBlock('wait')), null, 'time wait needs no selector');
  assert.match(validateBlock({ ...newBlock('wait'), mode: 'appear' }), /required/);
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
  assert.equal(plan.blocks[1].text, '{{value}}', 'non-string falls back to default');
});

test('sanitizePlan caps block count and regenerates ids when fresh', () => {
  const blocks = Array.from({ length: LIMITS.blocks + 5 }, () => ({ type: 'wait', id: 'same-id' }));
  const { plan, dropped } = sanitizePlan({ id: 'keep', blocks }, { fresh: true });
  assert.equal(plan.blocks.length, LIMITS.blocks);
  assert.equal(dropped, 5);
  assert.notEqual(plan.id, 'keep');
  assert.equal(new Set(plan.blocks.map((b) => b.id)).size, LIMITS.blocks);
});
