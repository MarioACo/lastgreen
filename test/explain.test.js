import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  changelogItems,
  cleanNote,
  envUsages,
  failingLocations,
  githubRepo,
  missingSymbols,
  noteItems,
  parseDeprecations,
  pickNotes,
} from '../src/explain.js';
import { cli, install, packageTarball, tmpDir, writeProject } from './helpers.js';

test('finds the failing line in the project, skipping node_modules and Node internals', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'line one\nconst x = chalk.green("hi");\n');
  fs.writeFileSync(path.join(root, 'test.js'), 'a\nb\nrequire("./src/app")\n');
  const app = path.join(root, 'src', 'app.js');
  const output = [
    `${app}:2`,
    'const x = chalk.green("hi");',
    '          ^',
    'TypeError: chalk.green is not a function',
    `    at Object.<anonymous> (${app}:2:17)`,
    `    at ${path.join(root, 'node_modules', 'chalk', 'index.js')}:1:1`,
    `    at Module._compile (node:internal/modules/cjs/loader:1554:14)`,
    `    at file://${pathToFileURL(path.join(root, 'test.js')).pathname}:3:1`,
  ].join('\n');
  const where = failingLocations(output, root);
  assert.deepEqual(where.map((w) => `${w.file}:${w.line}`), ['src/app.js:2', 'test.js:3']);
  assert.equal(where[0].code, 'const x = chalk.green("hi");');
});

test('understands test runners that print relative paths (vitest, jest)', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'src', 'report.js'), 'a\nb\nc\nd\ne\nf\ng\n  const byDay = groupBy(valid, (o) => format(o.date));\n');
  fs.writeFileSync(path.join(root, 'test', 'report.test.js'), 'a\nb\nc\nd\n    const out = report([]);\n');
  const vitest = ' FAIL  test/report.test.js > report > groups orders by day\nTypeError: format is not a function\n ❯ src/report.js:8:52\n ❯ test/report.test.js:5:17\n';
  assert.deepEqual(failingLocations(vitest, root).map((w) => `${w.file}:${w.line}`), ['src/report.js:8', 'test/report.test.js:5']);
  const jest = '    TypeError: format is not a function\n\n      at format (src/report.js:8:52)\n      at Object.<anonymous> (test/report.test.js:5:17)\n';
  assert.deepEqual(failingLocations(jest, root).map((w) => `${w.file}:${w.line}`), ['src/report.js:8', 'test/report.test.js:5']);
});

test('notes that talk about what failed come first', async () => {
  const { clues, pickNotes: pick } = await import('../src/explain.js');
  const words = clues('TypeError: format is not a function', [{ code: "const format = require('date-fns/format');" }]);
  const items = [
    { version: '3.0.0', text: 'BREAKING: TypeScript types are now completely rewritten', breaking: true },
    { version: '3.0.0', text: 'BREAKING: everything is exported via named exports instead of export default, i.e. const format = require("date-fns/format")', breaking: true },
  ];
  assert.match(pick(items, 6, words)[0].text, /named exports/);
});

test('CommonJS code + an "ESM only" release: that note goes first', async () => {
  const { noteBoost, pickNotes: pick } = await import('../src/explain.js');
  const boost = noteBoost('TypeError: chalk.green is not a function', [{ code: "const chalk = require('chalk');" }]);
  const items = [
    { version: '5.0.0', text: 'Require Node.js 12.20', breaking: true },
    { version: '5.0.0', text: 'The tagged template literal support moved into a separate package', breaking: true },
    { version: '5.0.0', text: 'This package is now pure ESM. Please read this.', breaking: true },
    { version: '5.0.0', text: 'Move some properties off the default export to individual named exports:', breaking: true },
  ];
  assert.deepEqual(pick(items, 2, new Set(['green']), boost).map((i) => i.text.slice(0, 20)), ['This package is now ', 'Move some properties']);
});

const CHALK_5 = `### Breaking

- **This package is now pure ESM. Please [read this](https://gist.github.com/x).**
	- If you use TypeScript, you need to use TypeScript 4.7 or later.
- Require Node.js 12.20  fa16f4e
- Remove \`.keyword()\` coloring methods (#433)  4cf2e40

### Improvements

- Improve performance (#470)  1ab2c3d

\`\`\`diff
-import chalk from 'chalk';
\`\`\`

https://github.com/chalk/chalk/compare/v4.1.2...v5.0.0`;

test('release notes: breaking items first, markdown and commit hashes cleaned', () => {
  const items = noteItems(CHALK_5, '5.0.0');
  assert.equal(items[0].text, 'This package is now pure ESM. Please read this.');
  assert.ok(items[0].breaking);
  assert.equal(items.find((i) => i.text.startsWith('Remove')).text, 'Remove `.keyword()` coloring methods');
  assert.ok(items.find((i) => i.text.startsWith('If you use')).nested);
  assert.ok(!items.some((i) => i.text.includes('import chalk')), 'code fences are skipped');
  const picked = pickNotes(items);
  assert.ok(picked.every((i) => i.breaking));
  assert.equal(picked.length, 3);
  assert.equal(cleanNote('Fix [bug](https://x) in `y` (#12)  abcdef1'), 'Fix bug in `y`');
});

test('CHANGELOG sections are filtered to the version range (atx and setext headings)', () => {
  const md = '# Changelog\n\n## [2.0.0] - 2024-01-01\n### Breaking\n- dropped Node 14\n\n## 1.5.0\n- added x\n\n## 1.4.0\n- old\n';
  assert.deepEqual(changelogItems(md, '1.4.0', '2.0.0').map((i) => i.version), ['2.0.0', '1.5.0']);
  const history = '3.1.0 / 2024-02-02\n==================\n\n  * removed foo()\n\n3.0.0 / 2023\n============\n  * x\n';
  assert.deepEqual(changelogItems(history, '3.0.0', '3.1.0').map((i) => i.text), ['removed foo()']);
});

test('Node deprecations: symbol from the error -> DEP entry with replacement and codemod', () => {
  const doc = `# Deprecations

### DEP0044: \`util.isArray()\`

<!-- YAML
changes: []
-->

Type: Runtime

The [\`util.isArray()\`][] API is deprecated. Please use \`Array.isArray()\`
instead.

### DEP0047: \`util.isDate()\`

Type: End-of-Life

The \`util.isDate()\` API has been removed. Please use
\`arg instanceof Date\` instead.

An automated migration is available ([source](https://x)):

\`\`\`bash
npx codemod@latest @nodejs/util-is
\`\`\`
`;
  const all = parseDeprecations(doc);
  assert.deepEqual(all.map((d) => d.id), ['DEP0044', 'DEP0047']);
  const d = all[1];
  assert.equal(d.title, 'util.isDate()');
  assert.equal(d.type, 'End-of-Life');
  assert.equal(d.text, 'The `util.isDate()` API has been removed. Please use `arg instanceof Date` instead.');
  assert.equal(d.migration, 'npx codemod@latest @nodejs/util-is');
  assert.equal(all[0].text, 'The `util.isArray()` API is deprecated. Please use `Array.isArray()` instead.');
  assert.deepEqual(missingSymbols('TypeError: util.isDate is not a function\n(node:1) [DEP0005] Buffer()'), ['util.isDate', 'DEP0005']);
});

test('repository field -> GitHub owner/repo', () => {
  assert.deepEqual(githubRepo({ repository: 'chalk/chalk' }), { owner: 'chalk', repo: 'chalk' });
  assert.deepEqual(githubRepo({ repository: { url: 'git+https://github.com/vitejs/vite.git', directory: 'packages/vite' } }), { owner: 'vitejs', repo: 'vite' });
  assert.equal(githubRepo({ repository: 'gitlab:a/b' }), null);
});

test('finds where the code reads an environment variable', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'config.ts'), 'export const tz = process.env.APP_TZ ?? "UTC";\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'process.env.APP_TZ');
  assert.deepEqual(envUsages('APP_TZ', root), [{ file: 'src/config.ts', line: 1, code: 'export const tz = process.env.APP_TZ ?? "UTC";' }]);
});

test('why explains the culprit: failing line and its CHANGELOG (offline)', async () => {
  const dir = tmpDir();
  const root = path.join(dir, 'proj');
  const tars = path.join(dir, 'tars');
  writeProject(root, {
    dependencies: { alpha: '^1.0.0' },
    testFile: "const { add } = require('alpha');\nif (add(2, 3) !== 5) throw new Error('add(2, 3) returned ' + add(2, 3));\n",
  });
  const alpha = (v, src, changelog) => packageTarball(tars, 'alpha', v, { 'index.js': src, ...(changelog ? { 'CHANGELOG.md': changelog } : {}) });
  await install(root, { 'node_modules/alpha': alpha('1.0.0', 'exports.add = (a, b) => a + b;') });
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 0);
  await install(root, {
    'node_modules/alpha': alpha('1.1.0', 'exports.add = (a, b) => a - b;', '# Changelog\n\n## 1.1.0\n\n### Breaking\n\n- `add()` now subtracts (renamed semantics)\n\n## 1.0.0\n\n- first\n'),
  });
  assert.equal(cli(root, ['run', '--', 'node', 'test.js']).code, 1);
  const r = cli(root, ['why', '--json', '--offline']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'found', r.stderr);
  const e = out.explain[0];
  assert.deepEqual(e.where.map((w) => `${w.file}:${w.line}`), ['test.js:2']);
  assert.equal(e.notes.source, 'changelog');
  assert.deepEqual(e.notes.items, [{ version: '1.1.0', text: '`add()` now subtracts (renamed semantics)', breaking: true }]);
  assert.deepEqual(out.fixForward, ['update test.js:2 for alpha 1.1.0 (see what changed above)']);
  assert.match(r.stderr, /Where it breaks in your code\n {4}test\.js:2/);
  assert.match(r.stderr, /What changed in alpha 1\.0\.0 → 1\.1\.0 \(its CHANGELOG\)/);
});
