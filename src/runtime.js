// Node.js versions: which one the user's command really gets, where an older
// one already lives on this machine (nvm, fnm, volta, mise, asdf, n), and how
// to download an official build verified against nodejs.org SHA-256 sums.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { capture } from './exec.js';
import { exists, mkdirp, readJson, rename, rm } from './fsx.js';
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

export async function managerVersion(manager, env, cwd) {
  if (!manager || manager === 'npm') return null;
  return capture(manager, ['--version'], { env, cwd, shell: process.platform === 'win32', timeoutMs: 15_000 });
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

async function fetchOk(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

/** Download an official Node.js build into the cache, verified with SHASUMS256.txt. */
export async function downloadNode(version, cacheDir, { mirror = process.env.LASTGREEN_NODE_MIRROR } = {}) {
  const v = `v${version.replace(/^v/, '')}`;
  const build = officialBuild(v);
  if (!build) throw new Error(`no official Node.js build for ${process.platform}`);
  const base = `${(mirror || 'https://nodejs.org/dist').replace(/\/+$/, '')}/${v}/`;
  const sums = await (await fetchOk(`${base}SHASUMS256.txt`, 30_000)).text();
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
    const res = await fetchOk(base + build.file, 15 * 60_000);
    const hash = crypto.createHash('sha256');
    await pipeline(
      Readable.fromWeb(res.body),
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
