// End to end, offline: a fake project goes green, then "npm update" + noise
// break it, and `lastgreen why` must name the one package that did it, leaving
// node_modules exactly as it found it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BIN, cli, install, packageTarball, tmpDir, versionOnDisk, writeProject } from './helpers.js';

const TEST_FILE = `
if (require('fs').existsSync(__dirname + '/slow.flag')) { const end = Date.now() + 1500; while (Date.now() < end); }
const { add } = require('alpha');
const beta = require('beta');
for (let i = 1; i <= 5; i++) require('noise' + i);
if (beta.gammaMajor() < 1) { console.error('beta could not load its own gamma'); process.exit(3); }
if (process.env.LG_BREAK) { console.error('LG_BREAK is set'); process.exit(4); }
if (add(2, 3) !== 5) { console.error('add(2, 3) returned ' + add(2, 3)); process.exit(1); }
console.log('all good');
`;

async function fixture() {
  const dir = tmpDir();
  const root = path.join(dir, 'proj');
  const tars = path.join(dir, 'tars');
  const deps = { alpha: '^1.0.0', beta: '^1.0.0' };
  for (let i = 1; i <= 5; i++) deps[`noise${i}`] = '^1.0.0';
  writeProject(root, { dependencies: deps, testFile: TEST_FILE });

  const pkg = (name, version, src) => packageTarball(tars, name, version, { 'index.js': src });
  const beta = (v) => pkg('beta', v, `module.exports.gammaMajor = () => Number(require('gamma').version.split('.')[0]);`);
  const gamma = (v) => packageTarball(tars, 'gamma', v, { 'index.js': `module.exports.version = '${v}';` });

  const greenTree = {
    'node_modules/alpha': pkg('alpha', '1.0.0', 'exports.add = (a, b) => a + b;'),
    'node_modules/beta': beta('1.0.0'),
    'node_modules/beta/node_modules/gamma': gamma('1.0.0'),
    'node_modules/gone': pkg('gone', '1.0.0', ''),
    'node_modules/gone/node_modules/gone-inner': pkg('gone-inner', '1.0.0', ''),
  };
  const redTree = {
    'node_modules/alpha': pkg('alpha', '1.0.1', 'exports.add = (a, b) => a - b; // "refactor"'),
    'node_modules/beta': beta('1.1.0'),
    'node_modules/beta/node_modules/gamma': gamma('2.0.0'),
    'node_modules/extra': pkg('extra', '1.0.0', ''),
  };
  for (let i = 1; i <= 5; i++) {
    greenTree[`node_modules/noise${i}`] = pkg(`noise${i}`, '1.0.0', '');
    redTree[`node_modules/noise${i}`] = pkg(`noise${i}`, '1.1.0', '');
  }
  await install(root, greenTree);
  return { dir, root, greenTree, redTree };
}

function assertTree(root, tree, absent = []) {
  for (const [key, t] of Object.entries(tree)) assert.equal(versionOnDisk(root, key), t.version, key);
  for (const key of absent) assert.equal(fs.existsSync(path.join(root, ...key.split('/'))), false, `${key} should not exist`);
  assert.equal(fs.existsSync(path.join(root, 'node_modules', '.lastgreen-stash')), false, 'stash left behind');
  assert.equal(fs.existsSync(path.join(root, '.lastgreen', 'journal.json')), false, 'journal left behind');
}

test('finds the package that broke the tests, among many changes, and restores node_modules', async () => {
  const { root, redTree } = await fixture();
  let r = cli(root, ['run', '--', 'node', 'test.js']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /all good/);
  assert.match(r.stderr, /green saved/);

  await install(root, redTree);
  r = cli(root, ['run', '--', 'node', 'test.js'], { LG_NOISE: '1' });
  assert.equal(r.code, 1, 'exit code of the user command is passed through');
  assert.match(r.stderr, /failed .* since the last green/);
  assert.match(r.stderr, /npx lastgreen why/);

  r = cli(root, ['why', '--json'], { LG_NOISE: '1' });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'found');
  assert.equal(out.confirmed, true);
  assert.deepEqual(out.culprit, [{ kind: 'package', name: 'alpha', change: 'changed', from: '1.0.0', to: '1.0.1' }]);
  assert.equal(out.restored, true);
  assert.deepEqual(out.fix, ['npm install --save-exact alpha@1.0.0']);
  assert.ok(out.changes.length >= 10, `saw ${out.changes.length} changes`);
  assert.ok(out.runs <= 12, `took ${out.runs} runs`);
  assertTree(root, redTree, ['node_modules/gone']);
  assert.match(r.stderr, /Culprit confirmed/);
});

test('finds an environment variable culprit', async () => {
  const { root } = await fixture();
  assert.equal(cli(root, ['run', 'node', 'test.js']).code, 0);
  assert.equal(cli(root, ['run', 'node', 'test.js'], { LG_BREAK: '1', LG_OTHER: 'x' }).code, 4);
  const r = cli(root, ['why', '--json'], { LG_BREAK: '1', LG_OTHER: 'x' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'found', r.stderr);
  assert.deepEqual(out.culprit.map((f) => f.name), ['LG_BREAK']);
});

test('diff runs nothing and lists the changes', async () => {
  const { root, redTree } = await fixture();
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);
  await install(root, redTree);
  const r = cli(root, ['diff', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'diff');
  const names = out.changes.map((c) => c.name);
  for (const n of ['alpha', 'beta', 'gamma', 'extra', 'gone']) assert.ok(names.includes(n), n);
  assert.equal(fs.existsSync(path.join(root, 'node_modules', '.lastgreen-stash')), false);
});

test('a hard crash in the middle of a bisect is repaired by the next command', async () => {
  const { root, redTree } = await fixture();
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);
  await install(root, redTree);
  const crashed = cli(root, ['why'], { LASTGREEN_DEBUG_CRASH_AFTER: '2' });
  assert.notEqual(crashed.code, 0);
  assert.ok(fs.existsSync(path.join(root, '.lastgreen', 'journal.json')), 'journal must survive the crash');
  // node_modules is in the "old" state right now
  assert.equal(versionOnDisk(root, 'node_modules/alpha'), '1.0.0');

  const r = cli(root, ['restore']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /node_modules restored/);
  assertTree(root, redTree, ['node_modules/gone']);
});

test('without a green run it explains what to do', async () => {
  const { root } = await fixture();
  const r = cli(root, ['why']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No green run saved/);
});

test('an upgrade that also removed dependencies is still confirmed (chalk 4 -> 5 case)', async () => {
  const dir = tmpDir();
  const root = path.join(dir, 'proj');
  const tars = path.join(dir, 'tars');
  writeProject(root, {
    dependencies: { colors: '^4.0.0', other: '^1.0.0' },
    testFile: `const colors = require('colors');\nrequire('other');\nif (typeof colors.red !== 'function') { console.error('TypeError: colors.red is not a function'); process.exit(1); }\nconsole.log(colors.red('ok'));\n`,
  });
  const t = (name, version, src, extra) => packageTarball(tars, name, version, { 'index.js': src }, extra);
  await install(root, {
    'node_modules/colors': t('colors', '4.1.2', `const paint = require('paint'); exports.red = (s) => paint(s);`, { dependencies: { paint: '^1.0.0' } }),
    'node_modules/paint': t('paint', '1.0.0', `const hue = require('hue'); module.exports = (s) => hue + s;`, { dependencies: { hue: '^2.0.0' } }),
    'node_modules/hue': t('hue', '2.0.0', `module.exports = 'red:';`),
    'node_modules/other': t('other', '1.0.0', ''),
  });
  // npm writes deps into the hidden lockfile; mirror that.
  const lockPath = path.join(root, 'node_modules', '.package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.packages['node_modules/colors'].dependencies = { paint: '^1.0.0' };
  lock.packages['node_modules/paint'].dependencies = { hue: '^2.0.0' };
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);

  await install(root, {
    'node_modules/colors': t('colors', '5.0.0', `exports.default = { red: (s) => s };`),
    'node_modules/other': t('other', '1.1.0', ''),
  });
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 1);
  const r = cli(root, ['why', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'found', r.stderr);
  assert.equal(out.confirmed, true, r.stderr);
  assert.deepEqual(out.culprit.map((f) => f.name), ['colors']);
  assert.match(r.stderr, /puts back 2 dependencies the old version needs: paint, hue/);
  assert.equal(versionOnDisk(root, 'node_modules/colors'), '5.0.0');
  assert.equal(fs.existsSync(path.join(root, 'node_modules', 'paint')), false);
});

test('Ctrl+C in the middle of a bisect restores node_modules', { skip: process.platform === 'win32' && 'SIGINT cannot be sent to a child on Windows; checked by hand with a real console' }, async () => {
  const { root, redTree } = await fixture();
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);
  await install(root, redTree);
  fs.writeFileSync(path.join(root, 'slow.flag'), '');
  const env = { ...process.env, NO_COLOR: '1', LASTGREEN_LANG: 'en', LASTGREEN_CACHE_DIR: path.join(root, '..', 'lg-cache') };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [BIN, 'why'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  // Wait until the old environment is in place (run #2 or later is running).
  const deadline = Date.now() + 60_000;
  while (!/#2 /.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /#2 /, out);
  child.kill('SIGINT');
  const code = await new Promise((r) => child.on('close', (c) => r(c)));
  assert.equal(code, 130, out);
  assert.match(out, /interrupted, node_modules restored/);
  assertTree(root, redTree, ['node_modules/gone']);
});

test('writes a GitHub Actions job summary', async () => {
  const { root, redTree } = await fixture();
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);
  await install(root, redTree);
  const summary = path.join(root, '..', 'summary.md');
  const r = cli(root, ['why'], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.code, 0, r.stderr);
  const md = fs.readFileSync(summary, 'utf8');
  assert.match(md, /### lastgreen/);
  assert.match(md, /Culprit confirmed:\*\* `alpha 1\.0\.0 → 1\.0\.1`/);
  assert.match(md, /npm install --save-exact alpha@1\.0\.0/);
});

test('--rebuild runs the install script of a restored native package', async () => {
  const dir = tmpDir();
  const root = path.join(dir, 'proj');
  const tars = path.join(dir, 'tars');
  writeProject(root, {
    dependencies: { native: '^1.0.0', alpha: '^1.0.0' },
    testFile: `require('native');\nif (require('alpha').add(2, 3) !== 5) process.exit(1);\n`,
  });
  // Like a node-gyp addon: the published tarball has no binary, the install script builds it.
  const native = (v) => ({
    ...packageTarball(tars, 'native', v, { 'index.js': `module.exports = require('./build/addon.js');` }, {
      scripts: { install: `node -e "require('fs').mkdirSync('build',{recursive:true});require('fs').writeFileSync('build/addon.js','module.exports=1')"` },
    }),
    hasInstallScript: true,
    build: { 'build/addon.js': 'module.exports = 1;' },
  });
  const alpha = (v, src) => packageTarball(tars, 'alpha', v, { 'index.js': src });
  fs.mkdirSync(path.join(root, 'node_modules', 'native', 'build'), { recursive: true });
  await install(root, { 'node_modules/native': native('1.0.0'), 'node_modules/alpha': alpha('1.0.0', 'exports.add = (a, b) => a + b;') });
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);
  fs.rmSync(path.join(root, 'node_modules', 'native'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'native', 'build'), { recursive: true });
  await install(root, { 'node_modules/native': native('1.1.0'), 'node_modules/alpha': alpha('1.0.1', 'exports.add = (a, b) => a * b;') });
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 1);

  // Without rebuilding, the old native package cannot load, so even the old environment fails.
  let r = cli(root, ['why', '--json']);
  assert.equal(JSON.parse(r.stdout).status, 'not-in-env', r.stderr);
  assert.match(r.stderr, /--rebuild/);

  r = cli(root, ['why', '--json', '--rebuild']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'found', r.stderr);
  assert.deepEqual(out.culprit.map((f) => f.name), ['alpha']);
  assert.equal(out.restored, true);
  assert.equal(versionOnDisk(root, 'node_modules/native'), '1.1.0');
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'native', 'build', 'addon.js')), 'current build output kept');
});

