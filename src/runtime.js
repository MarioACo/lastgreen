// Node.js versions: which one the user's command really gets, where an older
// one already lives on this machine (nvm, fnm, volta, mise, asdf, n), and how
// to download an official build verified against nodejs.org SHA-256 sums.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { capture } from './exec.js';
import { exists, mkdirp, readJson, rename, rm } from './fsx.js';
import { get, getJson, getText } from './http.js';
import { satisfies } from './semver.js';
import { extractTarball } from './tar.js';

const NODE_BIN = process.platform === 'win32' ? 'node.exe' : 'node';

/** The node that a shell command started with `env` would run. */
export async function probeNode(env, cwd) {
  const out = await capture('node', ['-p', 'JSON.stringify([process.version, process.execPath, process.arch])'], {
    env,
    cwd,
  });
  if (!out) return null;
  try {
    const [version, execPath, arch] = JSON.parse(out.split(/\r?\n/).pop());
    return { version, path: execPath, arch };
  } catch {
    return null;
  }
}

export function npmCliFor(nodePath) {
  if (!nodePath) return null;
  const dir = path.dirname(nodePath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find(exists) ?? null;
}

export function npmVersionFor(nodePath) {
  const cli = npmCliFor(nodePath);
  if (!cli) return null;
  return readJson(path.join(path.dirname(cli), '..', 'package.json'))?.version ?? null;
}

/** Every match for an executable on PATH (Windows: .exe/.cmd/.bat), without a shell. */
export function findOnPath(name, env = process.env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const out = [];
  for (const dir of String(env[key] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) out.push(file);
      } catch {}
    }
  }
  return out;
}

/**
 * Version of pnpm / yarn / bun, with no shell involved: pnpm records itself in
 * node_modules/.modules.yaml; a .cmd shim is read from the package.json next to
 * it; a real executable is run directly.
 */
export async function managerVersion(manager, env, cwd) {
  if (!manager || manager === 'npm') return null;
  if (manager === 'pnpm') {
    try {
      const yaml = fs.readFileSync(path.join(cwd, 'node_modules', '.modules.yaml'), 'utf8');
      const m = /packageManager:\s*["']?pnpm@([^\s"']+)/.exec(yaml);
      if (m) return m[1];
    } catch {}
  }
  for (const file of findOnPath(manager, env)) {
    if (/\.(cmd|bat)$/i.test(file)) {
      const pj = readJson(path.join(path.dirname(file), 'node_modules', manager, 'package.json'));
      if (pj?.version) return pj.version;
      continue;
    }
    return capture(file, ['--version'], { env, cwd, timeoutMs: 15_000 });
  }
  return null;
}

export function nodeCandidates(version, env = process.env, cacheDir) {
  const v = version.replace(/^v/, '');
  const home = os.homedir();
  const win = process.platform === 'win32';
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const xdgData = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const unixBin = win ? '' : 'bin';
  const dirs = [];
  if (env.NVM_HOME) dirs.push(path.join(env.NVM_HOME, `v${v}`));
  dirs.push(path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node', `v${v}`, 'bin'));
  for (const fnm of [env.FNM_DIR, win ? path.join(roaming, 'fnm') : null, path.join(xdgData, 'fnm'),
    path.join(home, 'Library', 'Application Support', 'fnm'), path.join(home, '.fnm')]) {
    if (fnm) dirs.push(path.join(fnm, 'node-versions', `v${v}`, 'installation', unixBin));
  }
  const volta = env.VOLTA_HOME || (win ? path.join(local, 'Volta') : path.join(home, '.volta'));
  dirs.push(path.join(volta, 'tools', 'image', 'node', v, unixBin));
  const mise = env.MISE_DATA_DIR || (win ? path.join(local, 'mise') : path.join(xdgData, 'mise'));
  dirs.push(path.join(mise, 'installs', 'node', v, unixBin));
  dirs.push(path.join(env.ASDF_DATA_DIR || path.join(home, '.asdf'), 'installs', 'nodejs', v, 'bin'));
  dirs.push(path.join(env.N_PREFIX || '/usr/local', 'n', 'versions', 'node', v, 'bin'));
  if (cacheDir) dirs.push(path.join(cacheDir, 'node', `v${v}`));
  return dirs;
}

/** A directory that contains the requested node binary, or null. */
export function findNodeDir(version, env = process.env, cacheDir) {
  return nodeCandidates(version, env, cacheDir).find((dir) => exists(path.join(dir, NODE_BIN))) ?? null;
}

export function officialBuild(version, platform = process.platform, arch = process.arch) {
  const v = `v${version.replace(/^v/, '')}`;
  const a = arch === 'ia32' ? 'x86' : arch;
  if (platform === 'win32') return { file: `win-${a}/node.exe`, kind: 'exe' };
  if (platform === 'darwin' || platform === 'linux') return { file: `node-${v}-${platform}-${a}.tar.gz`, kind: 'tar' };
  return null;
}

/** Download an official Node.js build into the cache, verified with SHASUMS256.txt. */
export async function downloadNode(version, cacheDir, { mirror = process.env.LASTGREEN_NODE_MIRROR } = {}) {
  const v = `v${version.replace(/^v/, '')}`;
  const build = officialBuild(v);
  if (!build) throw new Error(`no official Node.js build for ${process.platform}`);
  const base = `${(mirror || 'https://nodejs.org/dist').replace(/\/+$/, '')}/${v}/`;
  const sums = await getText(`${base}SHASUMS256.txt`, { timeoutMs: 30_000 });
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === build.file)?.[0];
  if (!expected) throw new Error(`nodejs.org has no ${build.file} for ${v}`);

  const nodeRoot = path.join(cacheDir, 'node');
  mkdirp(nodeRoot);
  const tmpFile = path.join(nodeRoot, `.${v}-${process.pid}.download`);
  const tmpDir = path.join(nodeRoot, `.${v}-${process.pid}.dir`);
  const finalDir = path.join(nodeRoot, v);
  try {
    const res = await get(base + build.file, { timeoutMs: 120_000 });
    const hash = crypto.createHash('sha256');
    await pipeline(
      res,
      new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      fs.createWriteStream(tmpFile),
    );
    const actual = hash.digest('hex');
    if (actual !== expected) throw new Error(`checksum mismatch for ${build.file} (expected ${expected}, got ${actual})`);
    rm(tmpDir);
    mkdirp(tmpDir);
    if (build.kind === 'exe') {
      rename(tmpFile, path.join(tmpDir, 'node.exe'));
    } else {
      await extractTarball(tmpFile, tmpDir, { strip: 1, filter: (rel) => rel === 'bin/node' });
      rename(path.join(tmpDir, 'bin', 'node'), path.join(tmpDir, 'node'));
      rm(path.join(tmpDir, 'bin'));
      fs.chmodSync(path.join(tmpDir, 'node'), 0o755);
    }
    rm(finalDir);
    rename(tmpDir, finalDir);
    return finalDir;
  } finally {
    rm(tmpFile);
    rm(tmpDir);
  }
}

// ------------------------------------------------------------------ declared Node version

/** What the project says it runs on: .nvmrc, .node-version, .tool-versions, volta, engines. */
export function declaredNode(root) {
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(root, f), 'utf8').trim();
    } catch {
      return '';
    }
  };
  const first = (text) => text.split(/\s+/)[0];
  const nvmrc = read('.nvmrc');
  if (nvmrc) return { spec: first(nvmrc), source: '.nvmrc' };
  const nodeVersion = read('.node-version');
  if (nodeVersion) return { spec: first(nodeVersion), source: '.node-version' };
  const tool = /^(?:nodejs|node)\s+(\S+)/m.exec(read('.tool-versions'));
  if (tool) return { spec: tool[1], source: '.tool-versions' };
  const pkg = readJson(path.join(root, 'package.json'), {});
  if (pkg?.volta?.node) return { spec: String(pkg.volta.node), source: 'package.json "volta"' };
  if (pkg?.engines?.node) return { spec: String(pkg.engines.node), source: 'package.json "engines"' };
  return null;
}

const PLAIN = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i;

/**
 * Does `version` (v22.11.0) fit what the project declares? A plain version
 * (18, 18.19, v18.19.0) means "this major line": a patch difference never
 * matters. A range (engines ">=18 <21") is checked with semver. lts/<name>
 * needs the release index; without it the answer is null (unknown).
 */
export function nodeSpecSatisfied(spec, version, index = null) {
  const s = String(spec ?? '').trim();
  const major = Number(/^v?(\d+)/.exec(version ?? '')?.[1]);
  if (!s || !major) return null;
  if (/^(node|latest|current|stable|system)$/i.test(s)) return null;
  const lts = /^lts\/(.+)$/i.exec(s);
  if (lts) {
    if (!index) return null;
    const name = lts[1].toLowerCase();
    const majors = new Set(index.filter((r) => r.lts && (name === '*' || String(r.lts).toLowerCase() === name)).map((r) => Number(r.version.slice(1).split('.')[0])));
    return majors.has(major);
  }
  const plain = PLAIN.exec(s);
  if (plain) return Number(plain[1]) === major;
  return satisfies(String(version).replace(/^v/, ''), s.replace(/(^|[\s<>=~^])v(\d)/g, '$1$2'));
}

/** Node versions already installed by version managers or downloaded by lastgreen. */
export function localNodeVersions(env = process.env, cacheDir) {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const xdgData = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dirs = [
    env.NVM_HOME,
    path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'),
    ...[env.FNM_DIR, win ? path.join(env.APPDATA || '', 'fnm') : null, path.join(xdgData, 'fnm'), path.join(home, 'Library', 'Application Support', 'fnm')]
      .filter(Boolean)
      .map((d) => path.join(d, 'node-versions')),
    path.join(env.VOLTA_HOME || (win ? path.join(local, 'Volta') : path.join(home, '.volta')), 'tools', 'image', 'node'),
    path.join(env.MISE_DATA_DIR || (win ? path.join(local, 'mise') : path.join(xdgData, 'mise')), 'installs', 'node'),
    path.join(env.ASDF_DATA_DIR || path.join(home, '.asdf'), 'installs', 'nodejs'),
    cacheDir ? path.join(cacheDir, 'node') : null,
  ].filter(Boolean);
  const out = new Set();
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    for (const n of names) if (/^v?\d+\.\d+\.\d+$/.test(n)) out.add(`v${n.replace(/^v/, '')}`);
  }
  return [...out];
}

/** nodejs.org release index, cached for a day. */
export async function nodeIndex(cacheDir, { offline = false } = {}) {
  const file = cacheDir ? path.join(cacheDir, 'node-index.json') : null;
  try {
    if (file && Date.now() - fs.statSync(file).mtimeMs < 24 * 3600_000) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  if (offline) return null;
  try {
    const index = (await getJson('https://nodejs.org/dist/index.json', { timeoutMs: 15_000 })).map((r) => ({ version: r.version, lts: r.lts }));
    if (file) {
      mkdirp(cacheDir);
      fs.writeFileSync(file, JSON.stringify(index));
    }
    return index;
  } catch {
    return null;
  }
}

const cmpV = (a, b) => {
  const x = a.slice(1).split('.').map(Number);
  const y = b.slice(1).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/**
 * Turn what the project declares into one concrete version to test with.
 * Prefers a version already on this machine; otherwise the newest matching
 * release (LTS first for open ranges).
 */
export async function resolveNodeSpec(spec, { env = process.env, cacheDir, offline = false } = {}) {
  const s = String(spec ?? '').trim();
  const exact = /^v?(\d+\.\d+\.\d+)$/.exec(s);
  if (exact) return `v${exact[1]}`;
  const index = await nodeIndex(cacheDir, { offline });
  const fits = (v) => nodeSpecSatisfied(s, v, index) === true;
  const local = localNodeVersions(env, cacheDir).filter(fits).sort(cmpV);
  if (local.length) return local[local.length - 1];
  if (!index) return null;
  const remote = index.filter((r) => fits(r.version));
  const lts = remote.filter((r) => r.lts);
  const pool = (lts.length ? lts : remote).map((r) => r.version).sort(cmpV);
  return pool.length ? pool[pool.length - 1] : null;
}
