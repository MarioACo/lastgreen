// The Node version a project declares (.nvmrc, engines...) works as a baseline
// when there is no green run yet, and `run` warns when it does not match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { declaredNode, nodeSpecSatisfied, resolveNodeSpec } from '../src/runtime.js';
import { execSync } from 'node:child_process';
import { cli, tmpDir, writeProject } from './helpers.js';

// The Node that commands get from PATH (not necessarily the one running the tests).
const PATH_NODE = execSync('node -v', { encoding: 'utf8' }).trim();
const CURRENT_MAJOR = Number(PATH_NODE.slice(1).split('.')[0]);
const OTHER = CURRENT_MAJOR === 12 ? 14 : 12;

test('reads what the project declares, in order of precedence', () => {
  const root = tmpDir();
  writeProject(root, {});
  assert.equal(declaredNode(root), null);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...pkg, engines: { node: '>=18 <21' } }));
  assert.deepEqual(declaredNode(root), { spec: '>=18 <21', source: 'package.json "engines"' });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...pkg, volta: { node: '18.20.4' }, engines: { node: '>=18' } }));
  assert.equal(declaredNode(root).source, 'package.json "volta"');
  fs.writeFileSync(path.join(root, '.tool-versions'), 'python 3.12.1\nnodejs 20.11.0\n');
  assert.deepEqual(declaredNode(root), { spec: '20.11.0', source: '.tool-versions' });
  fs.writeFileSync(path.join(root, '.nvmrc'), 'v18\n');
  assert.deepEqual(declaredNode(root), { spec: 'v18', source: '.nvmrc' });
});

test('matching: a plain version means its major line; ranges use semver', () => {
  assert.equal(nodeSpecSatisfied('18', 'v22.1.0'), false);
  assert.equal(nodeSpecSatisfied('v18.19.0', 'v18.20.8'), true, 'a patch difference never matters');
  assert.equal(nodeSpecSatisfied('>=18', 'v22.1.0'), true);
  assert.equal(nodeSpecSatisfied('^18 || ^20', 'v22.1.0'), false);
  assert.equal(nodeSpecSatisfied('lts/*', 'v22.1.0'), null, 'unknown without the release index');
  const index = [{ version: 'v22.1.0', lts: 'Jod' }, { version: 'v18.20.8', lts: 'Hydrogen' }, { version: 'v23.0.0', lts: false }];
  assert.equal(nodeSpecSatisfied('lts/hydrogen', 'v22.1.0', index), false);
  assert.equal(nodeSpecSatisfied('lts/*', 'v23.0.0', index), false);
});

test('resolves to a version already installed by a version manager (offline)', async () => {
  const nvm = tmpDir();
  for (const v of ['v18.19.0', 'v18.20.8', 'v20.11.0']) fs.mkdirSync(path.join(nvm, v));
  const env = { NVM_HOME: nvm, NVM_DIR: path.join(nvm, 'none'), HOME: nvm, USERPROFILE: nvm };
  assert.equal(await resolveNodeSpec('18', { env, offline: true }), 'v18.20.8');
  assert.equal(await resolveNodeSpec('>=19', { env, offline: true }), 'v20.11.0');
  assert.equal(await resolveNodeSpec('16.20.2', { env, offline: true }), 'v16.20.2', 'an exact version needs no lookup');
});

function project() {
  const dir = tmpDir();
  const root = path.join(dir, 'proj');
  writeProject(root, { testFile: 'process.exit(0)' });
  fs.writeFileSync(path.join(root, '.nvmrc'), `${OTHER}\n`);
  const nvm = path.join(dir, 'nvm');
  fs.mkdirSync(path.join(nvm, `v${OTHER}.22.12`), { recursive: true });
  return { root, env: { NVM_HOME: nvm } };
}

test('run warns when the Node in use is not what the project declares', () => {
  const { root, env } = project();
  const r = cli(root, ['run', '--', 'node', 'test.js'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`this project asks for Node ${OTHER} \\(\\.nvmrc\\) and this run used ${PATH_NODE}`));
});

test('why without a green run compares with the declared Node version', () => {
  const { root, env } = project();
  const r = cli(root, ['why', '--dry-run', '--offline', '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'diff');
  assert.deepEqual(out.changes.filter((c) => c.kind === 'node'), [
    { kind: 'node', name: 'node', change: 'changed', from: `v${OTHER}.22.12`, to: PATH_NODE, testable: true, reason: null },
  ]);
  assert.match(r.stderr, new RegExp(`comparing with what the project declares, Node ${OTHER} \\(\\.nvmrc\\)`));
});

test('--node compares with any version, and a matching .nvmrc explains why there is nothing to do', () => {
  const { root, env } = project();
  let r = cli(root, ['why', '--node', String(OTHER), '--dry-run', '--offline', '--json'], env);
  assert.equal(JSON.parse(r.stdout).changes.find((c) => c.kind === 'node').from, `v${OTHER}.22.12`);
  fs.writeFileSync(path.join(root, '.nvmrc'), `${CURRENT_MAJOR}\n`);
  r = cli(root, ['why', '--offline'], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /matches what the project declares/);
});
