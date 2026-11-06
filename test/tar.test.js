import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractTarball } from '../src/tar.js';
import { makeTar, paxEntry, tmpDir } from './helpers.js';

test('extracts gzip tarballs and strips the first folder like npm', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.tgz');
  fs.writeFileSync(
    file,
    zlib.gzipSync(
      makeTar([
        { name: 'package/', type: '5' },
        { name: 'package/package.json', content: '{"name":"a","version":"1.0.0"}' },
        { name: 'package/lib/deep/index.js', content: 'module.exports = 42;\n' },
        { name: 'package/empty.txt', content: '' },
      ]),
    ),
  );
  const out = path.join(dir, 'out');
  const written = await extractTarball(file, out);
  assert.deepEqual(written.sort(), ['empty.txt', 'lib/deep/index.js', 'package.json']);
  assert.equal(fs.readFileSync(path.join(out, 'lib', 'deep', 'index.js'), 'utf8'), 'module.exports = 42;\n');
  assert.equal(fs.readFileSync(path.join(out, 'empty.txt'), 'utf8'), '');
});

test('reads plain (not gzipped) tar and large files across chunks', async () => {
  const dir = tmpDir();
  const big = Buffer.alloc(300_000, 7);
  const file = path.join(dir, 'b.tar');
  fs.writeFileSync(file, makeTar([{ name: 'p/big.bin', content: big }, { name: 'p/after.txt', content: 'ok' }]));
  const out = path.join(dir, 'out');
  await extractTarball(file, out);
  assert.deepEqual(fs.readFileSync(path.join(out, 'big.bin')), big);
  assert.equal(fs.readFileSync(path.join(out, 'after.txt'), 'utf8'), 'ok');
});

test('honours pax long paths', async () => {
  const dir = tmpDir();
  const long = `package/${'x'.repeat(120)}/file.js`;
  const file = path.join(dir, 'c.tgz');
  fs.writeFileSync(file, zlib.gzipSync(makeTar([paxEntry(`path=${long}`), { name: 'package/short', content: 'pax' }])));
  const out = path.join(dir, 'out');
  await extractTarball(file, out);
  assert.equal(fs.readFileSync(path.join(out, 'x'.repeat(120), 'file.js'), 'utf8'), 'pax');
});

test('refuses to write outside the destination', async () => {
  const dir = tmpDir();
  for (const evil of ['package/../../evil.js', '/etc/evil', 'C:/evil.js', 'package\\..\\..\\evil.js']) {
    const file = path.join(dir, 'evil.tgz');
    fs.writeFileSync(file, zlib.gzipSync(makeTar([{ name: evil, content: 'boom' }])));
    await assert.rejects(extractTarball(file, path.join(dir, 'out')), /refusing/);
  }
  assert.equal(fs.existsSync(path.join(dir, 'evil.js')), false);
});

test('rejects corrupt headers', async () => {
  const dir = tmpDir();
  const tar = makeTar([{ name: 'p/a.txt', content: 'x' }]);
  tar[10] ^= 0xff;
  const file = path.join(dir, 'bad.tar');
  fs.writeFileSync(file, tar);
  await assert.rejects(extractTarball(file, path.join(dir, 'out')), /checksum/);
});

test('filter extracts only the wanted entry and keeps exec bits', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'node.tgz');
  fs.writeFileSync(
    file,
    zlib.gzipSync(
      makeTar([
        { name: 'node-v1/README.md', content: 'readme' },
        { name: 'node-v1/bin/node', content: '#!/bin/sh\necho hi\n', mode: 0o755 },
      ]),
    ),
  );
  const out = path.join(dir, 'out');
  const written = await extractTarball(file, out, { filter: (rel) => rel === 'bin/node' });
  assert.deepEqual(written, ['bin/node']);
  assert.equal(fs.existsSync(path.join(out, 'README.md')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(out, 'bin', 'node')).mode & 0o111, 0o111);
});
