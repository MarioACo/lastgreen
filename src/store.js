// Where lastgreen keeps things.
//   <project>/.lastgreen/            snapshots + bisect journal (self-ignored by git)
//   <user cache>/lastgreen/          downloaded package tarballs and Node builds
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exists, mkdirp, readJson, rm, writeJson } from './fsx.js';

const KEEP = 12;

export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function cacheDir(env = process.env) {
  if (env.LASTGREEN_CACHE_DIR) return path.resolve(env.LASTGREEN_CACHE_DIR);
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'lastgreen', 'cache');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'lastgreen');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'lastgreen');
}

export function loadConfig(root) {
  const rc = readJson(path.join(root, '.lastgreenrc.json'));
  const fromPkg = readJson(path.join(root, 'package.json'), {})?.lastgreen;
  const config = { ...(fromPkg && typeof fromPkg === 'object' ? fromPkg : {}), ...(rc ?? {}) };
  return {
    command: typeof config.command === 'string' ? config.command : null,
    ignoreEnv: Array.isArray(config.ignoreEnv) ? config.ignoreEnv.map(String) : [],
    timeout: Number(config.timeout) > 0 ? Number(config.timeout) : null,
  };
}

export class Store {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, '.lastgreen');
    this.snapDir = path.join(this.dir, 'snapshots');
    this.journal = path.join(this.dir, 'journal.json');
  }

  ensure() {
    mkdirp(this.snapDir);
    const ignore = path.join(this.dir, '.gitignore');
    if (!exists(ignore)) fs.writeFileSync(ignore, '# created by lastgreen: keep snapshots out of git\n*\n');
  }

  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.snapDir).filter((f) => f.endsWith('.json'));
    } catch {}
    return files.sort().map((f) => path.join(this.snapDir, f));
  }

  save(snapshot) {
    this.ensure();
    const stamp = snapshot.at.replace(/[:.]/g, '-');
    const file = path.join(this.snapDir, `${stamp}-${snapshot.status}.json`);
    writeJson(file, snapshot);
    this.prune();
    return file;
  }

  prune() {
    const files = this.list();
    const keep = new Set(files.slice(-KEEP));
    const lastGreen = files.filter((f) => f.endsWith('-green.json')).pop();
    const lastRed = files.filter((f) => f.endsWith('-red.json')).pop();
    if (lastGreen) keep.add(lastGreen);
    if (lastRed) keep.add(lastRed);
    for (const f of files) if (!keep.has(f)) rm(f);
  }

  latest(status) {
    const files = this.list().filter((f) => !status || f.endsWith(`-${status}.json`));
    for (let i = files.length - 1; i >= 0; i--) {
      const snap = readJson(files[i]);
      if (snap) return snap;
    }
    return null;
  }

  all() {
    return this.list().map((f) => readJson(f)).filter(Boolean);
  }
}
