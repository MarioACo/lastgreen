import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCulprit } from '../src/bisect.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `f${i}`);

/** Fails when every id in `needed` is still in its current state. */
const failsWhen = (needed) => async (current) => (needed.every((id) => current.has(id)) ? 'fail' : 'pass');

test('finds a single culprit among many changes in few runs', async () => {
  const all = ids(200);
  const res = await findCulprit(all, failsWhen(['f137']));
  assert.equal(res.status, 'found');
  assert.deepEqual(res.culprit, ['f137']);
  assert.equal(res.confirmed, true);
  assert.ok(res.runs <= 22, `took ${res.runs} runs`);
});

test('finds two changes that only fail together', async () => {
  const res = await findCulprit(ids(16), failsWhen(['f2', 'f11']));
  assert.equal(res.status, 'found');
  assert.deepEqual([...res.culprit].sort(), ['f11', 'f2']);
  assert.equal(res.confirmed, true);
});

test('reports when the failure does not reproduce', async () => {
  const res = await findCulprit(ids(5), async () => 'pass');
  assert.equal(res.status, 'not-reproduced');
  assert.equal(res.runs, 1);
});

test('reports when the old environment still fails (cause is elsewhere)', async () => {
  const res = await findCulprit(ids(5), async () => 'fail');
  assert.equal(res.status, 'not-in-env');
  assert.equal(res.runs, 2);
});

test('a strong first guess short-circuits the search', async () => {
  const all = ids(64);
  const withGuess = await findCulprit(all, failsWhen(['f40']), { firstGuess: 'f40' });
  const without = await findCulprit(all, failsWhen(['f40']));
  assert.deepEqual(withGuess.culprit, ['f40']);
  assert.ok(withGuess.runs < without.runs, `${withGuess.runs} vs ${without.runs}`);
});

test('a wrong first guess still finds the real culprit', async () => {
  const res = await findCulprit(ids(30), failsWhen(['f7']), { firstGuess: 'f20' });
  assert.deepEqual(res.culprit, ['f7']);
});

test('never runs the same configuration twice', async () => {
  const seen = new Set();
  await findCulprit(ids(40), async (current) => {
    const key = [...current].sort().join(',');
    assert.ok(!seen.has(key), 'repeated configuration');
    seen.add(key);
    return current.has('f3') && current.has('f33') ? 'fail' : 'pass';
  });
});

test('stops at the run budget', async () => {
  const res = await findCulprit(ids(100), failsWhen(['f1', 'f50', 'f99']), { maxRuns: 4 });
  assert.equal(res.status, 'budget');
  assert.equal(res.runs, 4);
});
