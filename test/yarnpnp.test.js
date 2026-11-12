// Real Yarn Berry PnP integration. The normal suite skips this because Corepack
// may need the network; CI prepares Yarn 3 and 4 explicitly and enables it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cli, packageTarball, tmpDir, writeProject } from './helpers.js';
import { readInstalled } from '../src/packages.js';

const enabled = process.env.LASTGREEN_REAL_YARN === '1';
const yarnVersion = process.env.LASTGREEN_YARN_VERSION || '4.18.1';

function corepack(root, args, env) {
  const result = spawnSync(`corepack yarn ${args.join(' ')}`, { cwd: root, env, shell: true, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 0, `${result.error?.stack ?? ''}\n${result.stdout}\n${result.stderr}`);
}

function yarnShim(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'yarn.cmd'), '@echo off\r\ncorepack yarn %*\r\n');
  } else {
    const file = path.join(bin, 'yarn');
    fs.writeFileSync(file, '#!/bin/sh\nexec corepack yarn "$@"\n');
    fs.chmodSync(file, 0o755);
  }
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return {
    ...process.env,
    [key]: `${bin}${path.delimiter}${process.env[key] ?? ''}`,
    CI: '1',
    YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
    YARN_ENABLE_GLOBAL_CACHE: 'false',
    YARN_GLOBAL_FOLDER: path.join(dir, 'yarn-global'),
  };
}

test('Yarn Berry PnP: finds a changed direct dependency entirely inside the sandbox', { skip: !enabled && 'set LASTGREEN_REAL_YARN=1 after preparing Yarn with Corepack' }, () => {
  const dir = tmpDir('lg-yarn-pnp-');
  const root = path.join(dir, 'project');
  const fixtures = path.join(root, 'fixtures');
  writeProject(root, { testFile: "const { add } = require('alpha'); require('noise'); if (add(2, 3) !== 5) { console.error('alpha returned ' + add(2, 3)); process.exit(1); }\n" });
  const alpha1 = packageTarball(fixtures, 'alpha', '1.0.0', { 'index.js': 'exports.add = (a, b) => a + b;' }).file;
  const alpha2 = packageTarball(fixtures, 'alpha', '1.1.0', { 'index.js': 'exports.add = (a, b) => a - b;' }).file;
  const noise1 = packageTarball(fixtures, 'noise', '1.0.0', { 'index.js': '' }).file;
  const noise2 = packageTarball(fixtures, 'noise', '1.1.0', { 'index.js': '' }).file;
  const relative = (file) => `file:./${path.relative(root, file).split(path.sep).join('/')}`;
  const writeManifest = (alpha, noise) => fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'yarn-pnp-fixture', private: true, packageManager: `yarn@${yarnVersion}`,
    scripts: { test: 'node test.js' }, dependencies: { alpha: relative(alpha), noise: relative(noise) },
  }, null, 2)}\n`);
  writeManifest(alpha1, noise1);
  fs.writeFileSync(path.join(root, '.yarnrc.yml'), 'nodeLinker: pnp\nenableGlobalCache: false\ncompressionLevel: 0\n');
  const env = yarnShim(dir);
  corepack(root, ['install', '--mode=skip-build'], env);
  let installed = readInstalled(root);
  assert.equal(installed.layout, 'pnp');
  assert.ok(Object.values(installed.packages).some((entry) => entry.name === 'alpha' && entry.version === '1.0.0'));
  assert.equal(cli(root, ['run', '--', 'yarn', 'node', 'test.js'], env).code, 0);

  writeManifest(alpha2, noise2);
  corepack(root, ['install', '--mode=skip-build'], env);
  assert.equal(cli(root, ['run', '--', 'yarn', 'node', 'test.js'], env).code, 1);
  const before = new Map(['package.json', 'yarn.lock', '.pnp.cjs'].map((name) => [name, fs.readFileSync(path.join(root, name))]));

  const result = cli(root, ['why', '--json', '--offline'], env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 'found', result.stderr);
  assert.equal(out.confirmed, true, result.stderr);
  assert.equal(out.sandbox, true);
  assert.deepEqual(out.culprit.map((factor) => factor.name), ['alpha']);
  assert.deepEqual(out.fix, ['yarn add --exact alpha@1.0.0']);
  for (const [name, contents] of before) assert.ok(fs.readFileSync(path.join(root, name)).equals(contents), `${name} changed`);
  installed = readInstalled(root);
  assert.ok(Object.values(installed.packages).some((entry) => entry.name === 'alpha' && entry.version === '1.1.0'));
  const unsafe = cli(root, ['why', '--no-sandbox'], env);
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.stderr, /requires the sandbox/);
});
