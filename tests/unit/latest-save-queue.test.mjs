import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestSaveQueue } from '../../src/renderer/latest-save-queue.ts';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));

test('active save finishes, intermediate pending saves coalesce into latest snapshot', async () => {
  const first = deferred(), last = deferred(), calls = [], busy = [];
  const queue = new LatestSaveQueue(async (key, value) => {
    calls.push([key, value]);
    return calls.length === 1 ? first.promise : last.promise;
  }, (value) => busy.push(value));
  const a = queue.request('a', 1), b = queue.request('a', 2), c = queue.request('a', 3);
  assert.deepEqual(calls, [['a', 1]]);
  first.resolve(true); await tick();
  assert.deepEqual(calls, [['a', 1], ['a', 3]]);
  assert.equal(queue.isBusy(), true);
  last.resolve(true);
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
  assert.deepEqual(busy, [true, false]);
});

test('unchanged repeat requests join one write; a revert replaces waiting edits', async () => {
  const gate = deferred(), calls = [], snapshot = {};
  const queue = new LatestSaveQueue(async (key, value) => { calls.push(value); return gate.promise; });
  const a = queue.request('a', snapshot), b = queue.request('a', snapshot);
  gate.resolve(true); await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  const gate2 = deferred(), values = [];
  const q2 = new LatestSaveQueue(async (_key, value) => { values.push(value); return values.length === 1 ? gate2.promise : true; });
  const requests = [q2.request('a', 1), q2.request('a', 2), q2.request('a', 1)];
  gate2.resolve(true); await Promise.all(requests);
  assert.deepEqual(values, [1, 1]);
});

test('failure stops the same document pending saves and still processes other documents', async () => {
  const gate = deferred(), calls = [];
  const queue = new LatestSaveQueue(async (key, value) => { calls.push([key, value]); return key === 'a' ? gate.promise : true; });
  const a = queue.request('a', 1), b = queue.request('a', 2), c = queue.request('b', 3);
  gate.resolve(false);
  assert.deepEqual(await Promise.all([a, b, c]), [false, false, true]);
  assert.deepEqual(calls, [['a', 1], ['b', 3]]);
  assert.equal(queue.isBusy(), false);
});

test('exceptions release the queue and a later explicit request may retry', async () => {
  let calls = 0;
  const queue = new LatestSaveQueue(async () => { if (++calls === 1) throw new Error('disk error'); return true; });
  assert.equal(await queue.request('a', 1), false);
  assert.equal(await queue.request('a', 2), true);
  assert.equal(queue.isBusy(), false);
});
