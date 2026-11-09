import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { captureEnv, isNoise, prependPath, setEnv } from '../src/env.js';
import { computeDiff, mentionedPackages, versionLevel } from '../src/diff.js';
import { packagesFromNpmLock, pnpmName, readInstalled } from '../src/packages.js';
import { shellJoin } from '../src/exec.js';
import { cleanupStaleSandboxes, createSandbox } from '../src/sandbox.js';
import { install, packageTarball, tmpDir, writeProject } from './helpers.js';

test('env: noise is ignored, secrets are hash-only, behavioural values are kept', () => {
  const env = captureEnv(
    {
      PATH: '/bin',
      VSCODE_PID: '1',
      npm_config_cache: '/x',
      API_TOKEN: 'super-secret',
      NODE_OPTIONS: '--max-old-space-size=4096',
      TZ: 'UTC',
      MY_FLAG: '1',
      NODE_AUTH_TOKEN: 'abc',
    },
    { platform: 'linux' },
  );
  assert.deepEqual(Object.keys(env).sort(), ['API_TOKEN', 'MY_FLAG', 'NODE_AUTH_TOKEN', 'NODE_OPTIONS', 'TZ']);
  assert.equal(env.API_TOKEN.v, undefined);
  assert.equal(env.NODE_AUTH_TOKEN.v, undefined, 'NODE_ prefix must not leak tokens');
  assert.equal(env.MY_FLAG.v, undefined);
  assert.equal(env.NODE_OPTIONS.v, '--max-old-space-size=4096');
  assert.match(env.API_TOKEN.h, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(env).includes('super-secret'));
});

test('env: Windows names are case-insensitive and shell noise is ignored', () => {
  const env = captureEnv({ Path: 'C:\\x', PSModulePath: 'x', Node_Env: 'test', HOME: '/c/Users/a' }, { platform: 'win32' });
  assert.deepEqual(Object.keys(env), ['NODE_ENV']);
  assert.ok(isNoise('FOO_BAR', { ignore: ['FOO_*'] }));
  const e = { Path: 'C:\\a' };
  prependPath(e, 'C:\\node16', 'win32');
  assert.deepEqual(e, { Path: 'C:\\node16;C:\\a' });
  setEnv(e, 'PATH', null, 'win32');
  assert.deepEqual(e, {});
});

test('diff: ranks the package named in the error first and folds nested folders', () => {
  const base = { system: { machine: 'm', platform: 'linux', arch: 'x64', release: '1' }, layout: 'hoisted', node: { version: 'v20.0.0' } };
  const green = {
    ...base,
    packages: {
      'node_modules/a': { version: '1.0.0', direct: 'prod' },
      'node_modules/b': { version: '2.0.0' },
      'node_modules/gone': { version: '1.0.0' },
      'node_modules/gone/node_modules/inner': { version: '1.0.0' },
    },
    env: { TZ: { h: '1', v: 'UTC' }, SECRET_KEY: { h: 'a' } },
  };
  const current = {
    ...base,
    node: { version: 'v22.1.0' },
    packages: {
      'node_modules/a': { version: '1.0.1', direct: 'prod' },
      'node_modules/b': { version: '3.0.0' },
      'node_modules/new': { version: '1.0.0' },
    },
    env: { TZ: { h: '2', v: 'Europe/Madrid' }, SECRET_KEY: { h: 'b' }, PATH: { h: 'x' } },
  };
  const diff = computeDiff(green, current, { output: "TypeError: x\n    at Object.<anonymous> (/p/node_modules/a/index.js:3:9)" });
  assert.equal(diff.factors[0].id, 'pkg:node_modules/a');
  assert.ok(diff.factors[0].tags.includes('in-output'));
  const gone = diff.factors.find((f) => f.id === 'pkg:node_modules/gone');
  assert.equal(gone.change, 'removed');
  assert.equal(gone.paths.length, 2, 'nested package moves with its parent');
  assert.ok(!diff.factors.some((f) => f.id === 'pkg:node_modules/gone/node_modules/inner'));
  assert.equal(diff.factors.find((f) => f.id === 'node').level, 'major');
  const tz = diff.factors.find((f) => f.id === 'env:TZ');
  assert.equal(tz.testable, true);
  const secret = diff.factors.find((f) => f.id === 'env:SECRET_KEY');
  assert.equal(secret.testable, false);
  assert.equal(secret.reason, 'value-not-stored');
  assert.equal(diff.factors.find((f) => f.id === 'env:PATH').reason, 'critical');
});

test('diff: snapshots from another platform do not test platform-specific packages', () => {
  const green = { system: { machine: 'a', platform: 'darwin', arch: 'arm64' }, layout: 'hoisted', packages: { 'node_modules/@esbuild/darwin-arm64': { version: '0.20.0', os: ['darwin'] } }, env: { HOME_THING: { h: '1' } } };
  const current = { system: { machine: 'b', platform: 'win32', arch: 'x64' }, layout: 'hoisted', packages: { 'node_modules/@esbuild/win32-x64': { version: '0.20.0', os: ['win32'] } }, env: {} };
  const diff = computeDiff(green, current);
  assert.equal(diff.testable.length, 0);
  assert.ok(diff.factors.filter((f) => f.kind === 'package').every((f) => f.reason === 'platform'));
  assert.equal(diff.factors.find((f) => f.kind === 'env').reason, 'other-machine');
});

test('versionLevel treats 0.x minor bumps as breaking', () => {
  assert.equal(versionLevel('1.2.3', '2.0.0'), 'major');
  assert.equal(versionLevel('0.3.1', '0.4.0'), 'major');
  assert.equal(versionLevel('1.2.3', '1.3.0'), 'minor');
  assert.equal(versionLevel('v20.1.0', 'v20.1.5'), 'patch');
});

test('mentionedPackages reads stack traces from Windows and POSIX', () => {
  const names = mentionedPackages(
    "at C:\\app\\node_modules\\@scope\\pkg\\dist\\x.js:1\nat /app/node_modules/lodash/index.js:2\nError: Cannot find module 'left-pad/lib'\nimport x from 'chalk'",
  );
  for (const n of ['@scope/pkg', 'lodash', 'left-pad', 'chalk']) assert.ok(names.has(n), n);
});

test('readInstalled uses the hidden lockfile and falls back to disk when it is stale', async () => {
  const dir = tmpDir();
  const root = path.join(dir, 'proj');
  const tars = path.join(dir, 'tars');
  writeProject(root, { dependencies: { a: '^1.0.0' } });
  const a1 = packageTarball(tars, 'a', '1.0.0');
  await install(root, { 'node_modules/a': a1, 'node_modules/a/node_modules/b': packageTarball(tars, 'b', '2.0.0') });
  let got = readInstalled(root);
  assert.equal(got.source, 'hidden-lockfile');
  assert.equal(got.packages['node_modules/a'].version, '1.0.0');
  assert.equal(got.packages['node_modules/a'].direct, 'prod');
  assert.equal(got.packages['node_modules/a'].integrity, a1.integrity);
  assert.equal(got.packages['node_modules/a/node_modules/b'].version, '2.0.0');

  // Someone edits node_modules behind npm's back: the hidden lockfile now lies.
  const pj = path.join(root, 'node_modules', 'a', 'package.json');
  fs.writeFileSync(pj, JSON.stringify({ name: 'a', version: '1.0.9' }));
  got = readInstalled(root);
  assert.equal(got.source, 'walk');
  assert.equal(got.packages['node_modules/a'].version, '1.0.9');
  assert.equal(got.packages['node_modules/a/node_modules/b'].version, '2.0.0');
});

test('npm lockfiles v1-v3 become a bisectable installed tree', () => {
  const pkg = { dependencies: { a: '^1.0.0' }, devDependencies: { dev: '^2.0.0' } };
  const modern = packagesFromNpmLock(
    {
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/a': { version: '1.0.0', integrity: 'sha512-a', dependencies: { b: '^1.0.0' } },
        'node_modules/a/node_modules/b': { version: '1.2.0' },
        'node_modules/dev': { version: '2.0.0' },
        'node_modules/local': { resolved: 'packages/local', link: true },
      },
    },
    pkg,
  );
  assert.equal(modern['node_modules/a'].direct, 'prod');
  assert.deepEqual(modern['node_modules/a'].deps, { b: '^1.0.0' });
  assert.equal(modern['node_modules/dev'].direct, 'dev');
  assert.equal(modern['node_modules/local'], undefined);

  const legacy = packagesFromNpmLock(
    {
      lockfileVersion: 1,
      dependencies: {
        a: { version: '1.0.0', requires: { b: '^1.0.0' }, dependencies: { b: { version: '1.2.0' } } },
      },
    },
    pkg,
  );
  assert.equal(legacy['node_modules/a'].direct, 'prod');
  assert.equal(legacy['node_modules/a/node_modules/b'].version, '1.2.0');
});

test('pnpm store folder names', () => {
  assert.equal(pnpmName('vite@5.4.2_@types+node@22.0.0'), 'vite');
  assert.equal(pnpmName('@babel+core@7.24.0'), '@babel/core');
  assert.equal(pnpmName('node_modules'), null);
});

test('shellJoin quotes for cmd.exe and sh', () => {
  assert.equal(shellJoin(['npm', 'test']), 'npm test');
  assert.equal(shellJoin(['npm test']), 'npm test');
  assert.equal(shellJoin(['node', 'a b.js'], 'win32'), 'node "a b.js"');
  assert.equal(shellJoin(['echo', "it's"], 'linux'), `echo 'it'\\''s'`);
});

test('sandbox copies the project, excludes lastgreen state and cleans up idempotently', () => {
  const tempRoot = tmpDir();
  const root = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(root, 'node_modules', 'a'), { recursive: true });
  fs.mkdirSync(path.join(root, '.lastgreen'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', '.cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'source.js'), 'source');
  fs.writeFileSync(path.join(root, 'node_modules', 'a', 'index.js'), 'package');
  fs.writeFileSync(path.join(root, 'node_modules', '.cache', 'artifact'), 'cache');
  fs.writeFileSync(path.join(root, '.lastgreen', 'snapshot.json'), 'private state');
  const sandbox = createSandbox(root, { tempRoot });
  assert.equal(fs.readFileSync(path.join(sandbox.root, 'source.js'), 'utf8'), 'source');
  assert.equal(fs.readFileSync(path.join(sandbox.root, 'node_modules', 'a', 'index.js'), 'utf8'), 'package');
  assert.equal(fs.existsSync(path.join(sandbox.root, '.lastgreen')), false);
  assert.equal(fs.existsSync(path.join(sandbox.root, 'node_modules', '.cache')), false);
  assert.equal(sandbox.excludedPaths, 2);
  assert.match(sandbox.strategy, /^(copy|copy-on-write|mixed)$/);
  assert.ok(sandbox.requiredBytes > sandbox.bytes);
  assert.equal(fs.existsSync(sandbox.base), true);
  sandbox.cleanup();
  sandbox.cleanup();
  assert.equal(fs.existsSync(sandbox.base), false);
});

test('sandbox preflight rejects low disk and a failed copy leaves no partial sandbox', () => {
  const tempRoot = tmpDir();
  const root = path.join(tempRoot, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'source.js'), 'source');
  assert.throws(
    () => createSandbox(root, { tempRoot, availableBytes: 0 }),
    (err) => err.code === 'ENOSPC' && err.details.requiredBytes > 0,
  );
  assert.throws(
    () => createSandbox(root, { tempRoot, availableBytes: Number.MAX_SAFE_INTEGER, copyFile: () => {
      const err = new Error('locked');
      err.code = 'EACCES';
      throw err;
    } }),
    (err) => err.code === 'EACCES',
  );
  assert.deepEqual(fs.readdirSync(tempRoot).filter((name) => name.startsWith('lastgreen-sandbox-')), []);
});

test('sandbox cleanup removes dead owners but not a live process', () => {
  const tempRoot = tmpDir();
  const dead = path.join(tempRoot, 'lastgreen-sandbox-dead');
  const live = path.join(tempRoot, 'lastgreen-sandbox-live');
  fs.mkdirSync(dead);
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(dead, '.lastgreen-sandbox.json'), JSON.stringify({ pid: 2147483647 }));
  fs.writeFileSync(path.join(live, '.lastgreen-sandbox.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(cleanupStaleSandboxes({ tempRoot }), 1);
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(live), true);
});

test('semver ranges the way npm reads them', async () => {
  const { satisfies } = await import('../src/semver.js');
  const yes = [
    ['1.2.3', '^1.0.0'], ['1.9.9', '^1.2.3'], ['0.2.5', '^0.2.3'], ['0.0.3', '^0.0.3'], ['1.2.9', '~1.2.3'],
    ['2.1.2', '2.1.2'], ['1.4.0', '1.x'], ['1.4.0', '1'], ['3.0.0', '>=2.0.0'], ['1.5.0', '1.2.3 - 1.8'],
    ['2.0.0', '^1.0.0 || ^2.0.0'], ['4.0.0', '*'], ['1.2.3', '>= 1.0.0 < 2'], ['1.0.0-beta.2', '^1.0.0-beta.1'],
    ['1.2.3', 'npm:other@^1.0.0'],
  ];
  const no = [
    ['2.0.0', '^1.0.0'], ['0.3.0', '^0.2.3'], ['0.0.4', '^0.0.3'], ['1.3.0', '~1.2.3'], ['2.1.3', '2.1.2'],
    ['1.9.0', '1.2.3 - 1.8'], ['2.0.0-rc.1', '^1.0.0'], ['1.0.0', 'file:../x'], ['1.0.0', 'github:a/b'], ['1.0.0', 'nonsense'],
  ];
  for (const [v, r] of yes) assert.equal(satisfies(v, r), true, `${v} should satisfy ${r}`);
  for (const [v, r] of no) assert.equal(satisfies(v, r), false, `${v} should not satisfy ${r}`);
});

test('coupling: an old version brings back the dependencies it needs', async () => {
  const { computeDiff, couple, greenClosure } = await import('../src/diff.js');
  const sys = { machine: 'm', platform: 'linux', arch: 'x64' };
  const green = {
    system: sys, layout: 'hoisted', env: {},
    packages: {
      'node_modules/chalk': { version: '4.1.2', direct: 'prod', deps: { 'ansi-styles': '^4.1.0' } },
      'node_modules/ansi-styles': { version: '4.3.0', deps: { 'color-convert': '^2.0.1' } },
      'node_modules/color-convert': { version: '2.0.1' },
      'node_modules/debug': { version: '4.3.4', direct: 'prod', deps: { ms: '2.1.2' } },
      'node_modules/ms': { version: '2.1.2' },
    },
  };
  const current = {
    system: sys, layout: 'hoisted', env: {},
    packages: {
      'node_modules/chalk': { version: '5.3.0', direct: 'prod' },
      'node_modules/debug': { version: '4.4.0', direct: 'prod', deps: { ms: '^2.1.3' } },
      'node_modules/ms': { version: '2.1.3' },
    },
  };
  const diff = computeDiff(green, current);
  const ids = diff.testable.map((f) => f.id);
  const back = greenClosure(['pkg:node_modules/chalk'], diff.coupling);
  assert.deepEqual([...back].sort(), ['pkg:node_modules/ansi-styles', 'pkg:node_modules/color-convert']);
  // Keeping only chalk@5 new: its old deps stay old (fine, nothing needs them).
  // Putting chalk back: ansi-styles and color-convert must come back too.
  const eff = couple(new Set(ids.filter((id) => id !== 'pkg:node_modules/chalk')), ids, diff.coupling);
  assert.ok(!eff.has('pkg:node_modules/ansi-styles') && !eff.has('pkg:node_modules/color-convert'));
  // debug@4.4.0 needs ms ^2.1.3: keeping debug new keeps ms new.
  assert.ok(couple(new Set(['pkg:node_modules/debug']), ids, diff.coupling).has('pkg:node_modules/ms'));
  // debug@4.3.4 pinned ms 2.1.2: putting debug back puts ms back.
  assert.ok(!couple(new Set(['pkg:node_modules/ms']), ids, diff.coupling).has('pkg:node_modules/ms'));
});
