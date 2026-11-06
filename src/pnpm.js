// pnpm support.
//
// pnpm keeps every package version in its own folder
//   node_modules/.pnpm/<instance>/node_modules/<name>
// and wires everything with symlinks (junctions on Windows):
//   node_modules/<dep>                         -> the version the project uses
//   node_modules/.pnpm/<instance>/node_modules/<dep>  -> the version that package uses
//   node_modules/.pnpm/node_modules/<dep>      -> hoisted fallbacks
// So instead of moving folders around, lastgreen re-points those links to the
// old versions, recreating from verified tarballs any version pnpm already
// deleted. Every link it touches and every folder it creates is journaled first.
import fs from 'node:fs';
import path from 'node:path';
import { exists, mkdirp, readJson, rm, writeJson } from './fsx.js';
import { extractTarball } from './tar.js';
import { prependPath, setEnv } from './env.js';

const isWin = process.platform === 'win32';

function readdir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function rawLink(abs) {
  try {
    return fs.readlinkSync(abs);
  } catch {
    return null;
  }
}

function resolveRaw(abs, raw) {
  if (raw == null) return null;
  const clean = raw.startsWith('\\\\?\\') ? raw.slice(4) : raw;
  return path.resolve(path.dirname(abs), clean);
}

/** Instance folder name that an absolute path points into, or null. */
function instanceOf(store, target) {
  if (!target) return null;
  const rel = path.relative(store, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep)[0];
}

/** Entries of a node_modules folder, scopes expanded; dot entries skipped. */
function listModules(dir) {
  const out = [];
  for (const e of readdir(dir)) {
    if (e.name.startsWith('.')) continue;
    if (e.name.startsWith('@') && e.isDirectory() && !e.isSymbolicLink()) {
      for (const s of readdir(path.join(dir, e.name))) {
        out.push({ name: `${e.name}/${s.name}`, abs: path.join(dir, e.name, s.name), link: s.isSymbolicLink() });
      }
    } else {
      out.push({ name: e.name, abs: path.join(dir, e.name), link: e.isSymbolicLink() });
    }
  }
  return out;
}

/** "chalk@4.1.2", "/chalk@4.1.2(peer)", "/@scope/x/1.0.0" (lockfile v5) -> "name@version" */
export function lockKey(key) {
  const k = key.replace(/^\//, '');
  const at = k.startsWith('@') ? k.indexOf('@', 1) : k.indexOf('@');
  if (at > 0) return `${k.slice(0, at)}@${k.slice(at + 1).split(/[(_]/)[0]}`;
  const v5 = /^((?:@[^/]+\/)?[^/]+)\/(\d[^/_(]*)/.exec(k);
  return v5 ? `${v5[1]}@${v5[2]}` : k;
}

/** Just what we need from pnpm's lockfile: integrity per name@version and the importer folders. */
export function parseLock(text) {
  const out = { integrity: {}, tarball: {}, importers: [] };
  let section = null;
  let key = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, '').trim();
      key = null;
      continue;
    }
    const k = /^ {2}(['"]?)(.+?)\1:\s*$/.exec(line);
    if (k) {
      key = k[2];
      if (section === 'importers') out.importers.push(key);
      continue;
    }
    if (section === 'packages' && key) {
      const r = /^\s+resolution:\s*\{(.*)\}/.exec(line);
      if (r) {
        const integrity = /integrity:\s*([^,}\s]+)/.exec(r[1])?.[1];
        const tarball = /tarball:\s*([^,}\s]+)/.exec(r[1])?.[1];
        if (integrity) out.integrity[lockKey(key)] = integrity;
        if (tarball) out.tarball[lockKey(key)] = tarball;
      }
    }
  }
  return out;
}

function hasInstallScript(pj) {
  return Boolean(pj?.scripts?.install || pj?.scripts?.preinstall || pj?.scripts?.postinstall);
}

function linksOf(store, dir) {
  const links = {};
  for (const m of listModules(dir)) {
    if (!m.link) continue;
    const target = instanceOf(store, resolveRaw(m.abs, rawLink(m.abs)));
    if (target) links[m.name] = target;
  }
  return Object.fromEntries(Object.entries(links).sort(([a], [b]) => a.localeCompare(b)));
}

/** Read the real pnpm graph from disk. */
export function readPnpm(root) {
  const store = path.join(root, 'node_modules', '.pnpm');
  let lockText = '';
  try {
    lockText = fs.readFileSync(path.join(store, 'lock.yaml'), 'utf8');
  } catch {}
  const lock = parseLock(lockText);
  const packages = {};
  for (const d of readdir(store)) {
    if (!d.isDirectory() || d.name === 'node_modules' || d.name.startsWith('.')) continue;
    const inner = path.join(store, d.name, 'node_modules');
    const mods = listModules(inner);
    const self = mods.find((m) => !m.link);
    if (!self) continue;
    const pj = readJson(path.join(self.abs, 'package.json'));
    if (!pj?.version) continue;
    const entry = { name: self.name, version: pj.version };
    const integrity = lock.integrity[`${self.name}@${pj.version}`];
    if (integrity) entry.integrity = integrity;
    const tarball = lock.tarball[`${self.name}@${pj.version}`];
    if (tarball) entry.resolved = tarball;
    const deps = { ...(pj.peerDependencies ?? {}), ...(pj.optionalDependencies ?? {}), ...(pj.dependencies ?? {}) };
    if (Object.keys(deps).length) entry.deps = deps;
    const links = linksOf(store, inner);
    if (Object.keys(links).length) entry.links = links;
    if (hasInstallScript(pj)) entry.script = true;
    if (pj.os) entry.os = pj.os;
    if (pj.cpu) entry.cpu = pj.cpu;
    packages[`pnpm:${d.name}`] = entry;
  }
  const importers = {};
  for (const imp of lock.importers.length ? lock.importers : ['.']) {
    const parts = imp.split('/').filter((p) => p && p !== '.');
    importers[imp] = linksOf(store, path.join(root, ...parts, 'node_modules'));
  }
  const hoisted = linksOf(store, path.join(store, 'node_modules'));
  const sorted = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)));
  return { packages: sorted, pnpm: { importers, hoisted } };
}

/** Group pnpm instances by package name: name -> Set(instance dirs). */
export function instancesByName(snapshot) {
  const out = new Map();
  for (const [key, entry] of Object.entries(snapshot.packages ?? {})) {
    if (!key.startsWith('pnpm:')) continue;
    if (!out.has(entry.name)) out.set(entry.name, new Set());
    out.get(entry.name).add(key.slice(5));
  }
  return out;
}

/** The pnpm counterpart of the npm Workspace: same interface, links instead of folders. */
export class PnpmWorkspace {
  constructor(root, journalPath) {
    this.root = root;
    this.journalPath = journalPath;
    this.store = path.join(root, 'node_modules', '.pnpm');
    this.ops = [];
    this.links = [];
    this.touched = new Set();
    this.tarballs = new Map(); // instance dir -> tarball
    this.nodeDir = null;
    this.applied = 0;
    this.engine = 'pnpm';
  }

  static recover(root, journalPath, journal) {
    const ws = new PnpmWorkspace(root, journalPath);
    ws.ops = journal.ops ?? [];
    return ws.restore();
  }

  save() {
    writeJson(this.journalPath, { v: 1, engine: 'pnpm', pid: process.pid, startedAt: this.startedAt, root: this.root, ops: this.ops });
  }

  record(op) {
    this.ops.push(op);
    this.save();
  }

  setTarball(dir, file) {
    this.tarballs.set(dir, file);
  }

  nameOf(dir) {
    return this.current.packages[`pnpm:${dir}`]?.name ?? this.green.packages[`pnpm:${dir}`]?.name ?? null;
  }

  targetOf(abs) {
    return instanceOf(this.store, resolveRaw(abs, rawLink(abs)));
  }

  /** Work out every link whose target differs between green and now, owned by a testable factor. */
  begin(factors, green, current) {
    this.startedAt = new Date().toISOString();
    this.green = green;
    this.current = current;
    const idByName = new Map(factors.filter((f) => f.kind === 'package' && f.pnpm).map((f) => [f.name, f.id]));
    const managed = [];
    const add = (abs, g, c) => {
      if ((g ?? null) === (c ?? null)) return;
      const gName = g ? green.packages[`pnpm:${g}`]?.name : null;
      const cName = c ? current.packages[`pnpm:${c}`]?.name : null;
      const id = idByName.get(gName) ?? idByName.get(cName);
      if (id) managed.push({ abs, g: g ?? null, c: c ?? null, id });
    };
    const both = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const gi = green.pnpm?.importers ?? {};
    const ci = current.pnpm?.importers ?? {};
    for (const imp of both(gi, ci)) {
      const base = path.join(this.root, ...imp.split('/').filter((p) => p && p !== '.'), 'node_modules');
      for (const name of both(gi[imp], ci[imp])) add(path.join(base, ...name.split('/')), gi[imp]?.[name], ci[imp]?.[name]);
    }
    const gh = green.pnpm?.hoisted ?? {};
    const ch = current.pnpm?.hoisted ?? {};
    for (const name of both(gh, ch)) add(path.join(this.store, 'node_modules', ...name.split('/')), gh[name], ch[name]);
    for (const [key, entry] of Object.entries(current.packages)) {
      const gEntry = green.packages[key];
      if (!key.startsWith('pnpm:') || !gEntry) continue;
      const base = path.join(this.store, key.slice(5), 'node_modules');
      for (const dep of both(gEntry.links, entry.links)) add(path.join(base, ...dep.split('/')), gEntry.links?.[dep], entry.links?.[dep]);
    }
    for (const l of managed) {
      if (this.targetOf(l.abs) !== l.c) {
        throw Object.assign(new Error(`node_modules changed while lastgreen was running (${path.relative(this.root, l.abs)})`), { code: 'ESTATE' });
      }
    }
    this.links = managed;
    this.save();
  }

  makeLink(abs, dir) {
    const name = this.nameOf(dir);
    const target = path.join(this.store, dir, 'node_modules', ...name.split('/'));
    mkdirp(path.dirname(abs));
    if (isWin) fs.symlinkSync(target, abs, 'junction');
    else fs.symlinkSync(path.relative(path.dirname(abs), target), abs);
  }

  removeLink(abs) {
    try {
      fs.unlinkSync(abs);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      if (err.code === 'EPERM' || err.code === 'EISDIR') fs.rmdirSync(abs);
      else throw err;
    }
  }

  /** Recreate a version pnpm already deleted, with its own links, from a verified tarball. */
  async materialize(dir) {
    if (exists(path.join(this.store, dir))) return;
    const entry = this.green.packages[`pnpm:${dir}`];
    const file = this.tarballs.get(dir);
    if (!entry || !file) throw Object.assign(new Error(`cannot restore ${dir}`), { code: 'EMISSING' });
    const base = path.join(this.store, dir);
    this.record({ type: 'dir', abs: base });
    const pkgDir = path.join(base, 'node_modules', ...entry.name.split('/'));
    await extractTarball(file, pkgDir, { strip: 1 });
    rm(path.join(pkgDir, 'node_modules'));
    for (const [dep, target] of Object.entries(entry.links ?? {})) {
      await this.materialize(target);
      this.makeLink(path.join(base, 'node_modules', ...dep.split('/')), target);
    }
  }

  setLink(abs, dir) {
    if (this.targetOf(abs) === dir) return;
    if (!this.touched.has(abs)) {
      this.touched.add(abs);
      this.record({ type: 'link', abs, raw: rawLink(abs) });
    }
    this.removeLink(abs);
    if (dir) this.makeLink(abs, dir);
  }

  /** @param {Set<string>} currentIds factors that stay as they are now */
  async apply(currentIds) {
    this.applied++;
    for (const l of this.links) {
      const want = currentIds.has(l.id) ? l.c : l.g;
      if (want) await this.materialize(want);
      this.setLink(l.abs, want);
    }
    if (process.env.LASTGREEN_DEBUG_CRASH_AFTER && this.applied >= Number(process.env.LASTGREEN_DEBUG_CRASH_AFTER)) {
      process.kill(process.pid, 'SIGKILL');
    }
  }

  envFor(currentIds, factors, baseEnv = process.env) {
    const env = { ...baseEnv };
    for (const f of factors) {
      if (currentIds.has(f.id)) continue;
      if (f.kind === 'env') setEnv(env, f.name, f.change === 'added' ? null : f.from);
      if (f.kind === 'node' && this.nodeDir) prependPath(env, this.nodeDir);
    }
    return env;
  }

  /** Synchronous and idempotent: put every link back and delete recreated folders. */
  restore() {
    let restored = 0;
    for (const op of [...this.ops].reverse()) {
      if (op.type === 'link') {
        if (rawLink(op.abs) === op.raw) continue;
        this.removeLink(op.abs);
        if (op.raw != null) {
          mkdirp(path.dirname(op.abs));
          if (isWin) fs.symlinkSync(op.raw, op.abs, 'junction');
          else fs.symlinkSync(op.raw, op.abs);
        }
        restored++;
      } else if (op.type === 'dir') {
        rm(op.abs);
      }
    }
    this.ops = [];
    rm(this.journalPath);
    return { restored };
  }

  verify() {
    const wrong = [];
    for (const l of this.links) if (this.targetOf(l.abs) !== l.c) wrong.push(path.relative(this.root, l.abs));
    return wrong;
  }
}
