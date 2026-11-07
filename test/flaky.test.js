// Flaky tests: with --repeat, a configuration whose runs disagree is "flaky"
// and is never blamed on the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findCulprit } from '../src/bisect.js';
import { cli, install, packageTarball, tmpDir, writeProject } from './helpers.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `f${i}`);

test('bisect: a flaky current environment is reported as flaky, not searched', async () => {
  const res = await findCulprit(ids(8), async (cur) => (cur.size === 8 ? 'flaky' : 'pass'));
  assert.deepEqual(res, { status: 'flaky', side: 'current', runs: 1 });
});

test('bisect: a flaky old environment means the environment cannot be blamed', async () => {
  const res = await findCulprit(ids(8), async (cur) => (cur.size === 0 ? 'flaky' : 'fail'));
  assert.equal(res.status, 'flaky');
  assert.equal(res.side, 'green');
});

test('bisect: flaky configurations never count as failures during the search', async () => {
  // f3 breaks it for real; anything with f6 (but not f3) is merely flaky.
  const res = await findCulprit(ids(10), async (cur) => (cur.has('f3') ? 'fail' : cur.has('f6') ? 'flaky' : 'pass'));
  assert.equal(res.status, 'found');
  assert.deepEqual(res.culprit, ['f3']);
});

test('--repeat tells a flaky test apart from an environment change', async () => {
  const dir = tmpDir();
  const root = path.join(dir, 'proj');
  writeProject(root, {
    dependencies: { alpha: '^1.0.0' },
    // Fails every other run, but only while LG_FLAKY is set (a flaky test that a new
    // variable happens to expose). Without repeating, the variable looks guilty.
    testFile: [
      "const fs = require('fs'); const f = __dirname + '/count.txt';",
      "const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;",
      'fs.writeFileSync(f, String(n + 1));',
      'if (process.env.LG_FLAKY && n % 2 === 1) { console.error("Error: timeout talking to the fake server"); process.exit(1); }',
    ].join('\n'),
  });
  await install(root, { 'node_modules/alpha': packageTarball(path.join(dir, 'tars'), 'alpha', '1.0.0', { 'index.js': '' }) });
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);
  fs.writeFileSync(path.join(root, 'count.txt'), '1');
  assert.equal(cli(root, ['run', '--', 'node', 'test.js'], { LG_FLAKY: '1' }).code, 1);

  const r = cli(root, ['why', '--json', '--repeat', '2'], { LG_FLAKY: '1' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'flaky', r.stderr);
  assert.equal(out.flakySide, 'current');
  assert.equal(out.repeat, 2);
  assert.match(r.stderr, /flaky \(1\/2 failed\)/);
  assert.match(r.stderr, /That is a flaky test, not an environment change/);
});
