// Builds a small demo project for the GitHub Action self-test.
//   node scripts/action-demo.mjs good <dir>   tests pass
//   node scripts/action-demo.mjs bad  <dir>   an "npm update" broke them
// Tarballs are deterministic, so two different CI machines build identical ones.
import fs from 'node:fs';
import path from 'node:path';
import { install, packageTarball, writeProject } from '../test/helpers.js';

const [mode, base] = process.argv.slice(2);
const root = path.join(base, 'demo');
const tars = path.join(base, 'demo-tars');
fs.rmSync(root, { recursive: true, force: true });
writeProject(root, {
  dependencies: { alpha: '^1.0.0', noise1: '^1.0.0', noise2: '^1.0.0' },
  testFile: "require('noise1'); require('noise2');\nif (require('alpha').add(2, 3) !== 5) { console.error('AssertionError: add(2, 3) !== 5'); process.exit(1); }\nconsole.log('all good');\n",
});
const t = (name, version, src = '') => packageTarball(tars, name, version, { 'index.js': src });
const good = {
  'node_modules/alpha': t('alpha', '1.0.0', 'exports.add = (a, b) => a + b;'),
  'node_modules/noise1': t('noise1', '1.0.0'),
  'node_modules/noise2': t('noise2', '1.0.0'),
};
const bad = {
  'node_modules/alpha': t('alpha', '1.0.1', 'exports.add = (a, b) => a - b;'),
  'node_modules/noise1': t('noise1', '1.1.0'),
  'node_modules/noise2': t('noise2', '1.2.0'),
};
await install(root, mode === 'bad' ? bad : good);
console.log(`demo project (${mode}) in ${root}`);
