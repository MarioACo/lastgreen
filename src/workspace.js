// Puts parts of the old environment back, temporarily, inside the user's own
// node_modules, and guarantees they come back exactly as they were.
//
// Every step is written to .lastgreen/journal.json *before* it happens, and
// restore() is synchronous and idempotent, so it can run from Ctrl+C, a crash
// handler, or the next lastgreen command after a power cut.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { exists, mkdirp, readJson, rename, rm, writeJson } from './fsx.js';
import { keyToPath, nameFromKey } from './packages.js';
import { npmCliFor } from './runtime.js';
import { extractTarball } from './tar.js';
import { prependPath, setEnv } from './env.js';

export class Workspace {
  /** @param {{rebuild?: boolean, nodePath?: string|null}} options rebuild: run install scripts of freshly restored packages */
  constructor(root, journalPath, { rebuild = false, nodePath = null } = {}) {
    this.root = root;
    this.journalPath = journalPath;
    this.stashRoot = path.join(root, 'node_modules', '.lastgreen-stash');
    this.hiddenLock = path.join(root, 'node_modules', '.package-lock.json');
    this.hiddenLockBackup = path.join(this.stashRoot, 'hidden-lockfile.json');
    this.records = new Map();
    this.tarballs = new Map(); // path key -> tarball file
    this.nodeDir = null;
    this.applied = 0;
    this.rebuild = rebuild;
    this.nodePath = nodePath;
    this.rebuilds = 0;
  }

  static pending(journalPath) {
    return exists(journalPath);
  }

  /** Recover from an interrupted bisect described by a journal on disk. */
  static recover(root, journalPath) {
    const journal = readJson(journalPath);
    if (!journal) {
      rm(journalPath);
      return { restored: 0 };
    }
    const ws = new Workspace(root, journalPath);
    for (const rec of journal.records ?? []) ws.records.set(rec.id, rec);
    return ws.restore();
  }

  save() {
    writeJson(this.journalPath, {
      v: 1,
      pid: process.pid,
      startedAt: this.startedAt,
      root: this.root,
      records: [...this.records.values()],
    });
  }

  /** Check node_modules still matches the snapshot, then open the journal. */
  begin(factors) {
    this.startedAt = new Date().toISOString();
    let i = 0;
    for (const f of factors) {
      if (f.kind !== 'package') continue;
      i++;
      const top = f.paths[0].key;
      const there = exists(keyToPath(this.root, top));
      if (f.change === 'removed' ? there : !there) {
        throw Object.assign(new Error(`node_modules changed while lastgreen was running (${top})`), { code: 'ESTATE' });
      }
      this.records.set(f.id, {
        id: f.id,
        change: f.change,
        keys: f.paths.map((p) => p.key),
        state: 'current',
        stash: path.join(this.stashRoot, `s${i}`),
        tmp: path.join(this.stashRoot, `t${i}`),
        cache: path.join(this.stashRoot, `g${i}`), // old version kept ready for the next run
        script: Boolean(f.script),
        names: [...new Set(f.paths.map((p) => (p.green ?? p.current)?.name ?? nameFromKey(p.key)))],
      });
    }
    mkdirp(this.stashRoot);
    if (this.rebuild && exists(this.hiddenLock)) fs.copyFileSync(this.hiddenLock, this.hiddenLockBackup);
    this.save();
  }

  /** Run the install scripts (native builds) of packages that were just put back. */
  rebuildPackages(names) {
    const cli = npmCliFor(this.nodePath);
    if (!cli) return Promise.resolve(false);
    this.rebuilds++;
    return new Promise((resolve) => {
      const child = spawn(this.nodePath, [cli, 'rebuild', ...names, '--loglevel=error'], {
        cwd: this.root,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  setTarball(key, file) {
    this.tarballs.set(key, file);
  }

  async extractGreen(key, dest) {
    rm(dest);
    await extractTarball(this.tarballs.get(key), dest, { strip: 1 });
    // Nested dependencies are separate factors; never take them from the tarball.
    rm(path.join(dest, 'node_modules'));
  }

  async toGreen(rec) {
    const P = keyToPath(this.root, rec.keys[0]);
    rec.state = 'to-green';
    this.save();
    let fresh = false;
    if (rec.change === 'changed') {
      if (exists(rec.cache)) {
        rm(rec.tmp);
        rename(rec.cache, rec.tmp);
      } else {
        await this.extractGreen(rec.keys[0], rec.tmp);
        fresh = true;
      }
      if (exists(path.join(P, 'node_modules'))) rename(path.join(P, 'node_modules'), path.join(rec.tmp, 'node_modules'));
      rename(P, rec.stash);
      rename(rec.tmp, P);
    } else if (rec.change === 'added') {
      rename(P, rec.stash);
    } else if (exists(rec.cache)) {
      mkdirp(path.dirname(P));
      rename(rec.cache, P);
    } else {
      for (const key of rec.keys) {
        const target = keyToPath(this.root, key);
        await this.extractGreen(key, rec.tmp);
        mkdirp(path.dirname(target));
        rename(rec.tmp, target);
      }
      fresh = true;
    }
    if (fresh && rec.script && this.rebuild) await this.rebuildPackages(rec.names);
    rec.state = 'green';
    this.save();
  }

  toCurrent(rec) {
    rec.state = 'to-current';
    this.save();
    const P = keyToPath(this.root, rec.keys[0]);
    if (rec.change === 'changed' && exists(rec.stash)) {
      // Keep the old version (already extracted, maybe rebuilt) for the next run.
      if (exists(path.join(P, 'node_modules'))) rename(path.join(P, 'node_modules'), path.join(rec.stash, 'node_modules'));
      rm(rec.cache);
      if (exists(P)) rename(P, rec.cache);
      rename(rec.stash, P);
    } else if (rec.change === 'removed' && exists(P)) {
      rm(rec.cache);
      rename(P, rec.cache);
    } else {
      this.recoverRecord(rec);
    }
    rec.state = 'current';
    this.save();
  }

  /** Bring one record back to the current state, whatever step it stopped at. */
  recoverRecord(rec) {
    const P = keyToPath(this.root, rec.keys[0]);
    if (rec.change === 'changed') {
      if (exists(rec.stash)) {
        const nested = exists(path.join(P, 'node_modules'))
          ? path.join(P, 'node_modules')
          : exists(path.join(rec.tmp, 'node_modules'))
            ? path.join(rec.tmp, 'node_modules')
            : null;
        if (nested && !exists(path.join(rec.stash, 'node_modules'))) rename(nested, path.join(rec.stash, 'node_modules'));
        rm(P);
        rm(rec.tmp);
        rename(rec.stash, P);
      } else {
        if (exists(path.join(rec.tmp, 'node_modules')) && !exists(path.join(P, 'node_modules'))) {
          rename(path.join(rec.tmp, 'node_modules'), path.join(P, 'node_modules'));
        }
        rm(rec.tmp);
      }
    } else if (rec.change === 'added') {
      if (exists(rec.stash) && !exists(P)) rename(rec.stash, P);
    } else {
      rm(rec.tmp);
      rm(P);
    }
  }

  /** @param {Set<string>} currentIds factors that stay as they are now; all others go back to green */
  async apply(currentIds) {
    this.applied++;
    for (const rec of this.records.values()) {
      const want = currentIds.has(rec.id) ? 'current' : 'green';
      if (rec.state === want) continue;
      if (want === 'green') await this.toGreen(rec);
      else this.toCurrent(rec);
    }
    if (process.env.LASTGREEN_DEBUG_CRASH_AFTER && this.applied >= Number(process.env.LASTGREEN_DEBUG_CRASH_AFTER)) {
      process.kill(process.pid, 'SIGKILL'); // test hook: simulate a hard crash mid-bisect
    }
  }

  /** Environment for a run: env vars and Node version per the chosen configuration. */
  envFor(currentIds, factors, baseEnv = process.env) {
    const env = { ...baseEnv };
    for (const f of factors) {
      if (currentIds.has(f.id)) continue;
      if (f.kind === 'env') setEnv(env, f.name, f.change === 'added' ? null : f.from);
      if (f.kind === 'node' && this.nodeDir) prependPath(env, this.nodeDir);
    }
    return env;
  }

  /** Synchronous, idempotent. Safe to call from signal handlers. */
  restore() {
    let restored = 0;
    for (const rec of this.records.values()) {
      if (rec.state === 'current') continue;
      this.recoverRecord(rec);
      rec.state = 'current';
      restored++;
      try {
        this.save();
      } catch {}
    }
    if (exists(this.hiddenLockBackup)) {
      try {
        fs.copyFileSync(this.hiddenLockBackup, this.hiddenLock);
      } catch {}
    }
    rm(this.stashRoot);
    rm(this.journalPath);
    return { restored };
  }

  /** Compare node_modules after restore with the snapshot taken before bisecting. */
  verify(current) {
    // Read package.json on disk: the hidden lockfile never changes during a bisect.
    const wrong = [];
    for (const rec of this.records.values()) {
      for (const key of rec.keys) {
        const onDisk = readJson(path.join(keyToPath(this.root, key), 'package.json'))?.version ?? null;
        if (onDisk !== (current.packages[key]?.version ?? null)) wrong.push(key);
      }
    }
    if (exists(this.stashRoot)) wrong.push('node_modules/.lastgreen-stash');
    return wrong;
  }
}
