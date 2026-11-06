// Test helpers: build real tar/tgz files and fake-but-realistic npm installs
// (files in node_modules + npm's hidden lockfile), fully offline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractTarball } from '../src/tar.js';

export const BIN = fileURLToPath(new URL('../bin/lastgreen.js', import.meta.url));

export function tmpDir(prefix = 'lg-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function tarHeader(name, size, { type = '0', mode = 0o644 } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  h.write(`${(1_700_000_000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii'); // fixed mtime: reproducible tarballs
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** @param {{name: string, content?: string|Buffer, type?: string, mode?: number}[]} entries */
export function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const body = Buffer.from(e.content ?? '');
    const size = e.type === '5' ? 0 : body.length;
    parts.push(tarHeader(e.name, size, e));
    if (size) {
      parts.push(body);
      const pad = (512 - (size % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function paxEntry(record) {
  const body = (() => {
    let len = record.length + 3;
    for (;;) {
      const line = `${len} ${record}\n`;
      if (Buffer.byteLength(line) === len) return line;
      len = Buffer.byteLength(line);
    }
  })();
  return { name: 'PaxHeader', type: 'x', content: body };
}

export function sri(file) {
  return `sha512-${crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;
}

/** Write <dir>/<name>-<version>.tgz in the same shape npm publishes (package/...). */
export function packageTarball(dir, name, version, files = {}, pkgExtra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const pj = { name, version, main: 'index.js', ...pkgExtra };
  const entries = [
    { name: 'package/package.json', content: JSON.stringify(pj, null, 2) },
    ...Object.entries(files).map(([rel, content]) => ({ name: `package/${rel}`, content })),
  ];
  const file = path.join(dir, `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`);
  // Byte-identical on every machine (the CI action test compares Linux, Windows and
  // ARM macOS): level 0 avoids CPU-specific deflate paths, and the gzip "OS" byte is fixed.
  const gz = zlib.gzipSync(makeTar(entries), { level: 0 });
  gz[9] = 3;
  fs.writeFileSync(file, gz);
  return { file, integrity: sri(file), name, version };
}

/**
 * Make node_modules look exactly like npm installed `tree` (key -> tarball).
 * Removes paths that are no longer in the tree and rewrites the hidden lockfile.
 */
export async function install(root, tree) {
  const lockPath = path.join(root, 'node_modules', '.package-lock.json');
  const old = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')).packages : {};
  const keys = Object.keys(tree).sort((a, b) => a.split('/').length - b.split('/').length);
  for (const key of Object.keys(old).sort((a, b) => b.split('/').length - a.split('/').length)) {
    if (!key.startsWith('node_modules/')) continue; // "" is the project itself
    if (!tree[key]) fs.rmSync(path.join(root, ...key.split('/')), { recursive: true, force: true });
  }
  for (const key of keys) {
    const t = tree[key];
    if (old[key]?.version === t.version && old[key]?.integrity === t.integrity) continue;
    const dest = path.join(root, ...key.split('/'));
    const nested = path.join(dest, 'node_modules');
    const keepNested = fs.existsSync(nested) ? `${dest}.nested-tmp` : null;
    if (keepNested) fs.renameSync(nested, keepNested);
    fs.rmSync(dest, { recursive: true, force: true });
    await extractTarball(t.file, dest, { strip: 1 });
    if (keepNested) fs.renameSync(keepNested, nested);
  }
  const packages = { '': { name: path.basename(root), version: '1.0.0' } };
  for (const key of keys) {
    const t = tree[key];
    packages[key] = {
      version: t.version,
      resolved: `file:${path.relative(root, t.file).split(path.sep).join('/')}`,
      integrity: t.integrity,
      ...(t.hasInstallScript ? { hasInstallScript: true } : {}),
    };
    // What npm would have done at install time for a package with a build step.
    for (const [rel, content] of Object.entries(t.build ?? {})) {
      const file = path.join(root, ...key.split('/'), rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ name: path.basename(root), lockfileVersion: 3, requires: true, packages }, null, 2));
}

export function writeProject(root, { dependencies = {}, test = 'node test.js', testFile } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { test }, dependencies }, null, 2),
  );
  if (testFile) fs.writeFileSync(path.join(root, 'test.js'), testFile);
}

/** Run the CLI. Returns { code, stdout, stderr }. */
export function cli(cwd, args, env = {}) {
  const fullEnv = { ...process.env, NO_COLOR: '1', LASTGREEN_LANG: 'en', LASTGREEN_CACHE_DIR: path.join(cwd, '..', 'lg-cache'), ...env };
  delete fullEnv.NODE_TEST_CONTEXT;
  for (const [k, v] of Object.entries(fullEnv)) if (v === undefined) delete fullEnv[k];
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: fullEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, signal: res.signal };
}

export function versionOnDisk(root, key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ...key.split('/'), 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  if (process.platform === 'win32') fs.symlinkSync(target, at, 'junction');
  else fs.symlinkSync(path.relative(path.dirname(at), target), at);
}

/**
 * Lay node_modules out exactly like pnpm does (isolated linker), from scratch.
 * @param {{instances: Record<string, {tar: {file: string, name: string, version: string, integrity: string}, links?: Record<string, string>}>, root: Record<string, string>, hoisted?: Record<string, string>}} layout
 */
export async function installPnpm(root, { instances, root: rootLinks, hoisted = {} }) {
  const nm = path.join(root, 'node_modules');
  fs.rmSync(nm, { recursive: true, force: true });
  const store = path.join(nm, '.pnpm');
  const pkgDir = (dir) => path.join(store, dir, 'node_modules', ...instances[dir].tar.name.split('/'));
  for (const dir of Object.keys(instances)) await extractTarball(instances[dir].tar.file, pkgDir(dir), { strip: 1 });
  for (const [dir, inst] of Object.entries(instances)) {
    for (const [dep, target] of Object.entries(inst.links ?? {})) link(pkgDir(target), path.join(store, dir, 'node_modules', ...dep.split('/')));
  }
  for (const [name, dir] of Object.entries(rootLinks)) link(pkgDir(dir), path.join(nm, ...name.split('/')));
  for (const [name, dir] of Object.entries(hoisted)) link(pkgDir(dir), path.join(store, 'node_modules', ...name.split('/')));
  const lines = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies: {}', '', 'packages:', ''];
  for (const inst of Object.values(instances)) {
    lines.push(`  ${inst.tar.name.startsWith('@') ? `'${inst.tar.name}@${inst.tar.version}'` : `${inst.tar.name}@${inst.tar.version}`}:`);
    lines.push(`    resolution: {integrity: ${inst.tar.integrity}, tarball: file:${path.relative(root, inst.tar.file).split(path.sep).join("/")}}`, "");
  }
  fs.writeFileSync(path.join(store, 'lock.yaml'), lines.join('\n'));
  fs.writeFileSync(path.join(nm, '.modules.yaml'), 'layoutVersion: 5\n');
}
