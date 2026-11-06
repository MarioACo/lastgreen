// pnpm end to end, offline: the same scenarios as npm, on pnpm's symlinked layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, installPnpm, packageTarball, tmpDir, writeProject } from './helpers.js';
import { lockKey, parseLock, readPnpm } from '../src/pnpm.js';

async function pnpmFixture() {
  const dir = tmpDir();
  const root = path.join(dir, 'proj');
  const tars = path.join(dir, 'tars');
  writeProject(root, {
    dependencies: { alpha: '^1.0.0', beta: '^1.0.0', noise1: '^1.0.0', noise2: '^1.0.0' },
    testFile: [
      "require('noise1'); require('noise2');",
      "if (require('beta').gammaMajor() < 1) process.exit(3);",
      "const { add } = require('alpha');",
      "if (add(2, 3) !== 5) { console.error('add(2, 3) returned ' + add(2, 3)); process.exit(1); }",
    ].join('\n'),
  });
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  const t = (name, version, src) => packageTarball(tars, name, version, { 'index.js': src });
  const beta = (v) => t('beta', v, "module.exports.gammaMajor = () => Number(require('gamma').version.split('.')[0]);");
  const gamma = (v) => t('gamma', v, `module.exports.version = '${v}';`);
  const green = {
    instances: {
      'alpha@1.0.0': { tar: t('alpha', '1.0.0', 'exports.add = (a, b) => a + b;') },
      'beta@1.0.0': { tar: beta('1.0.0'), links: { gamma: 'gamma@1.0.0' } },
      'gamma@1.0.0': { tar: gamma('1.0.0') },
      'noise1@1.0.0': { tar: t('noise1', '1.0.0', '') },
      'noise2@1.0.0': { tar: t('noise2', '1.0.0', '') },
      'gone@1.0.0': { tar: t('gone', '1.0.0', '') },
    },
    root: { alpha: 'alpha@1.0.0', beta: 'beta@1.0.0', noise1: 'noise1@1.0.0', noise2: 'noise2@1.0.0', gone: 'gone@1.0.0' },
    hoisted: { gamma: 'gamma@1.0.0' },
  };
  const red = {
    instances: {
      'alpha@1.0.1': { tar: t('alpha', '1.0.1', 'exports.add = (a, b) => a - b;') },
      'beta@1.1.0': { tar: beta('1.1.0'), links: { gamma: 'gamma@2.0.0' } },
      'gamma@2.0.0': { tar: gamma('2.0.0') },
      'noise1@1.1.0': { tar: t('noise1', '1.1.0', '') },
      'noise2@1.0.0': { tar: t('noise2', '1.0.0', '') },
      'extra@1.0.0': { tar: t('extra', '1.0.0', '') },
    },
    root: { alpha: 'alpha@1.0.1', beta: 'beta@1.1.0', noise1: 'noise1@1.1.0', noise2: 'noise2@1.0.0', extra: 'extra@1.0.0' },
    hoisted: { gamma: 'gamma@2.0.0' },
  };
  await installPnpm(root, green);
  return { root, red };
}

function graph(root) {
  const g = readPnpm(root);
  return JSON.stringify({ links: Object.fromEntries(Object.entries(g.packages).map(([k, v]) => [k, v.links ?? {}])), pnpm: g.pnpm });
}

test('pnpm: lockfile keys and integrity', () => {
  assert.equal(lockKey('chalk@4.1.2'), 'chalk@4.1.2');
  assert.equal(lockKey('/@babel/core@7.24.0(supports-color@8.1.1)'), '@babel/core@7.24.0');
  assert.equal(lockKey('/react-dom@18.2.0_react@18.2.0'), 'react-dom@18.2.0');
  assert.equal(lockKey('/@scope/x/1.0.0'), '@scope/x@1.0.0');
  const lock = parseLock("lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n  packages/app:\n    dependencies: {}\n\npackages:\n\n  chalk@4.1.2:\n    resolution: {integrity: sha512-abc==}\n  '@a/b@1.0.0':\n    resolution: {integrity: sha512-def==, tarball: x}\n");
  assert.deepEqual(lock.importers, ['.', 'packages/app']);
  assert.deepEqual(lock.integrity, { 'chalk@4.1.2': 'sha512-abc==', '@a/b@1.0.0': 'sha512-def==' });
  assert.deepEqual(lock.tarball, { '@a/b@1.0.0': 'x' });
});

test('pnpm: reads the real graph (instances, links, importers, hoisted)', async () => {
  const { root } = await pnpmFixture();
  const g = readPnpm(root);
  assert.equal(g.packages['pnpm:beta@1.0.0'].links.gamma, 'gamma@1.0.0');
  assert.match(g.packages['pnpm:alpha@1.0.0'].integrity, /^sha512-/);
  assert.equal(g.pnpm.importers['.'].alpha, 'alpha@1.0.0');
  assert.equal(g.pnpm.hoisted.gamma, 'gamma@1.0.0');
});

test('pnpm: finds the culprit by re-pointing links and leaves everything exactly as it was', async () => {
  const { root, red } = await pnpmFixture();
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);
  await installPnpm(root, red);
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 1);
  const before = graph(root);
  const r = cli(root, ['why', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'found', r.stderr);
  assert.equal(out.confirmed, true, r.stderr);
  assert.deepEqual(out.culprit, [{ kind: 'package', name: 'alpha', change: 'changed', from: '1.0.0', to: '1.0.1' }]);
  assert.deepEqual(out.fix, ['pnpm add --save-exact alpha@1.0.0']);
  assert.equal(out.restored, true);
  assert.equal(graph(root), before, 'links must be restored exactly');
  assert.equal(fs.existsSync(path.join(root, 'node_modules', '.pnpm', 'alpha@1.0.0')), false, 'recreated copies are removed');
  assert.equal(fs.existsSync(path.join(root, '.lastgreen', 'journal.json')), false);
});

test('pnpm: an old version comes back with the dependencies pnpm already deleted', async () => {
  const dir = tmpDir();
  const root = path.join(dir, 'proj');
  const tars = path.join(dir, 'tars');
  writeProject(root, {
    dependencies: { colors: '^4.0.0' },
    testFile: "const c = require('colors');\nif (typeof c.red !== 'function') { console.error('TypeError: colors.red is not a function'); process.exit(1); }\n",
  });
  const t = (name, version, src) => packageTarball(tars, name, version, { 'index.js': src });
  await installPnpm(root, {
    instances: {
      'colors@4.1.2': { tar: t('colors', '4.1.2', "const p = require('paint'); exports.red = (s) => p(s);"), links: { paint: 'paint@1.0.0' } },
      'paint@1.0.0': { tar: t('paint', '1.0.0', "const h = require('hue'); module.exports = (s) => h + s;"), links: { hue: 'hue@2.0.0' } },
      'hue@2.0.0': { tar: t('hue', '2.0.0', "module.exports = 'red:';") },
    },
    root: { colors: 'colors@4.1.2' },
  });
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);
  await installPnpm(root, { instances: { 'colors@5.0.0': { tar: t('colors', '5.0.0', 'exports.default = {};') } }, root: { colors: 'colors@5.0.0' } });
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 1);
  const r = cli(root, ['why', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'found', r.stderr);
  assert.equal(out.confirmed, true, r.stderr);
  assert.deepEqual(out.culprit.map((f) => f.name), ['colors']);
  assert.match(r.stderr, /puts back 2 dependencies the old version needs: paint, hue/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'node_modules', '.pnpm')).sort(), ['colors@5.0.0', 'lock.yaml']);
});

test('pnpm: a hard crash mid-bisect is repaired by the next command', async () => {
  const { root, red } = await pnpmFixture();
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);
  await installPnpm(root, red);
  const before = graph(root);
  const crashed = cli(root, ['why'], { LASTGREEN_DEBUG_CRASH_AFTER: '2' });
  assert.notEqual(crashed.code, 0);
  assert.ok(fs.existsSync(path.join(root, '.lastgreen', 'journal.json')));
  assert.notEqual(graph(root), before, 'mid-bisect the links point to old versions');
  const r = cli(root, ['restore']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(graph(root), before);
  assert.equal(fs.existsSync(path.join(root, 'node_modules', '.pnpm', 'alpha@1.0.0')), false);
});
