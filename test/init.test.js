import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { unwrapTestScript, workflowYaml, wrapTestScript } from '../src/init.js';
import { cli, tmpDir, writeProject } from './helpers.js';

test('wraps the test script so chained commands stay together', () => {
  assert.deepEqual(wrapTestScript('vitest run'), { script: 'lastgreen run -- "vitest run"', original: 'vitest run' });
  assert.deepEqual(wrapTestScript('npm run lint && jest'), { script: 'lastgreen run -- "npm run lint && jest"', original: 'npm run lint && jest' });
  assert.deepEqual(wrapTestScript('jest -t "my test"'), { script: 'lastgreen run', configCommand: 'jest -t "my test"', original: 'jest -t "my test"' });
  assert.deepEqual(wrapTestScript('lastgreen run -- "vitest run"'), { already: true });
  assert.deepEqual(wrapTestScript('npx -y lastgreen run -- jest'), { already: true });
  assert.equal(unwrapTestScript('lastgreen run -- "vitest run"'), 'vitest run');
  assert.equal(unwrapTestScript('lastgreen run -- jest --ci'), 'jest --ci');
  assert.equal(unwrapTestScript('lastgreen run', { command: 'jest -t "x"' }), 'jest -t "x"');
});

test('CI workflow fits the package manager and Node version file', () => {
  const npm = workflowYaml({ manager: 'npm', command: 'vitest run', branch: 'main', nodeVersionFile: '.nvmrc' });
  assert.match(npm, /branches: \[main\]/);
  assert.match(npm, /node-version-file: \.nvmrc/);
  assert.match(npm, /cache: npm/);
  assert.match(npm, /- run: npm ci/);
  assert.match(npm, /uses: MarioACo\/lastgreen@v0\n {8}with:\n {10}command: "vitest run"/);
  assert.match(npm, /actions: read/);
  const pnpm = workflowYaml({ manager: 'pnpm', command: 'pnpm vitest', branch: 'master', nodeVersionFile: null });
  assert.match(pnpm, /uses: pnpm\/action-setup@v4\n {8}with:\n {10}version: 9/);
  assert.match(pnpm, /node-version: 22/);
  assert.match(pnpm, /pnpm install --frozen-lockfile/);
  assert.match(pnpm, /branches: \[master\]/);
  const quoted = workflowYaml({ manager: 'npm', command: 'jest -t "a: b"', branch: 'main' });
  assert.match(quoted, /command: "jest -t \\"a: b\\""/);
});

test('init sets a project up and is safe to run twice', () => {
  const root = path.join(tmpDir(), 'proj');
  writeProject(root, { test: 'node test.js && node other.js', testFile: 'process.exit(0)' });
  fs.writeFileSync(path.join(root, 'other.js'), '');
  fs.writeFileSync(path.join(root, '.nvmrc'), '22\n');
  let r = cli(root, ['init', '--ci', '--no-install']);
  assert.equal(r.code, 0, r.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'lastgreen run -- "node test.js && node other.js"');
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'lastgreen.yml'), 'utf8');
  assert.match(wf, /command: "node test.js && node other.js"/);
  assert.match(wf, /node-version-file: \.nvmrc/);
  assert.match(r.stdout, /npm install --save-dev lastgreen@\^/);
  assert.match(r.stdout, /claude mcp add lastgreen -- npx -y lastgreen mcp/);

  r = cli(root, ['init', '--ci', '--no-install']);
  assert.match(r.stdout, /already runs through lastgreen/);
  assert.match(r.stdout, /already exists/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test, pkg.scripts.test);
});

test('run finds local binaries in node_modules/.bin without npm (as in the GitHub Action)', () => {
  const root = path.join(tmpDir(), 'proj');
  writeProject(root, { test: 'mytest' });
  const bin = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'mytest.cmd'), '@echo local binary ok\r\n');
  fs.writeFileSync(path.join(bin, 'mytest'), '#!/bin/sh\necho local binary ok\n', { mode: 0o755 });
  const r = cli(root, ['run', '--', 'mytest']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /local binary ok/);
});

test('init --dry-run writes nothing', () => {
  const root = path.join(tmpDir(), 'proj');
  writeProject(root, { test: 'vitest run' });
  const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const r = cli(root, ['init', '--ci', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /dry run/);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, '.github')), false);
});
