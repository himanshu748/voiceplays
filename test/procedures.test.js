import { test } from 'node:test';
import assert from 'node:assert/strict';
import { despeak, speakable, rank } from '../procedures.js';

test('despeak strips ANSI colour, box drawing and markdown', () => {
  assert.equal(despeak('\u001b[32m\u2500\u2500 **done** \u2714\u001b[0m'), 'done');
});

test('speakable caps long replies at a word boundary and ends with a full stop', () => {
  const out = speakable('word '.repeat(100));
  assert.ok(out.length <= 240);
  assert.match(out, /word\.$/);
});

test('rank weighs name over tags over description and ignores stopwords', () => {
  const rows = [
    { name: 'check-cpu', tags: [], description: 'check the disk is not the issue' },
    { name: 'disk-space', tags: ['system'], description: 'Report free space' },
    { name: 'backup', tags: ['disk'], description: '' }
  ];
  assert.deepEqual(rank(rows, 'check my disk space').map(r => r.name), ['disk-space', 'backup', 'check-cpu']);
  assert.deepEqual(rank(rows, 'please run the'), []);
});
