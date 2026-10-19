import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentNumberDraft, parseNumberText } from '../../src/renderer/number-input-state.ts';

test('complete finite decimal numbers commit without normalizing their local text', () => {
  for (const [raw, value] of [['12', 12], ['-12', -12], ['1.', 1], ['.25', .25], ['-0.5', -.5], ['1e3', 1000], ['2.5e-2', .025]]) {
    assert.equal(parseNumberText(raw), value);
    const draft = { text: raw, value };
    assert.equal(currentNumberDraft(draft, value), draft);
  }
});

test('empty and unfinished numeric text never changes the document to zero or NaN', () => {
  for (const raw of ['', '-', '+', '.', '-.', '1e', '1e-', '1e+', 'NaN', 'Infinity', '1e999', '0x10', ' 2 ', 'abc']) {
    assert.equal(parseNumberText(raw), null, raw);
  }
});

test('undo and edits from another tree invalidate a locally committed numeric draft', () => {
  const draft = { text: '601', value: 601 };
  assert.equal(currentNumberDraft(draft, 601), draft);
  assert.equal(currentNumberDraft(draft, 600), null, 'undo immediately restores the external value');
  assert.equal(currentNumberDraft(draft, 700), null, 'a second editor updates the same field');
  assert.equal(currentNumberDraft(null, 600), null);
});

test('incomplete drafts survive unrelated document changes but expire when their value changes', () => {
  const draft = { text: '-', value: 600 };
  assert.equal(currentNumberDraft(draft, 600), draft);
  assert.equal(currentNumberDraft(draft, 500), null);
  assert.equal(parseNumberText(draft.text), null);
});
