// What is really installed in node_modules (not what the lockfile wishes).
//
// npm keeps a "hidden lockfile" at node_modules/.package-lock.json with the
// exact tree, resolved URL and integrity of every package: we use it when it
// agrees with disk, and fall back to walking node_modules otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { exists, readJson } from './fsx.js';

const DEFAULT_REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.yarnpkg.com/'];

export function nameFromKey(key) {
  const i = key.lastIndexOf('node_modules/');
  return i === -1 ? key : key.slice(i + 'node_modules/'.length);
}

export function keyToPath(root, key) {
  return path.join(root, ...key.split('/'));
}

export function defaultResolved(name, version) {
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

/** Drop the resolved URL when it is just the public registry default (smaller snapshots). */
function compactResolved(name, version, resolved) {
  if (!resolved) return undefined;
  for (const reg of DEFAULT_REGISTRIES) {
    const base = name.startsWith('@') ? name.split('/')[1] : name;
    if (resolved === `${reg}${name}/-/${base}-${version}.tgz`) return undefined;
  }
  return resolved;
}

/** What a package asks for: name -> range (peer and optional deps included). */
function depsOf(e) {
  const deps = { ...(e?.peerDependencies ?? {}), ...(e?.optionalDependencies ?? {}), ...(e?.dependencies ?? {}) };
  return Object.keys(deps).length ? deps : undefined;
}

function clean(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

export function detectManager(root, pkgJson = readJson(path.join(root, 'package.json'), {})) {
  const pm = typeof pkgJson?.packageManager === 'string' ? pkgJson.packageManager.split('@')[0] : null;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) return pm;
  if (exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(root, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(root, 'bun.lock')) || exists(path.join(root, 'bun.lockb'))) return 'bun';
  if (exists(path.join(root, 'package-lock.json')) || exists(path.join(root, 'npm-shrinkwrap.json'))) return 'npm';
  if (exists(path.join(root, 'node_modules', '.package-lock.json'))) return 'npm';
  return null;
}

export function directDeps(pkgJson) {
  const out = {};
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const name of Object.keys(pkgJson?.[field] ?? {})) out[name] ??= field === 'devDependencies' ? 'dev' : 'prod';
  }
  return out;
}

function readHiddenLockfile(root) {
  const lock = readJson(path.join(root, 'node_modules', '.package-lock.json'));
  if (!lock?.packages) return null;
  const out = {};
  for (const [key, e] of Object.entries(lock.packages)) {
    if (!key.includes('node_modules/') || e.link || !e.version) continue;
    const keyName = nameFromKey(key);
    const name = e.name && e.name !== keyName ? e.name : undefined;
    out[key] = clean({
      name,
      version: e.version,
      resolved: compactResolved(e.name ?? keyName, e.version, e.resolved),
      integrity: e.integrity,
      script: e.hasInstallScript || undefined,
      os: e.os,
      cpu: e.cpu,
      deps: depsOf(e),
    });
  }
  return out;
}

/** The hidden lockfile can go stale (manual edits, other tools). Spot-check direct deps on disk. */
function hiddenLockfileAgrees(root, packages, direct) {
  for (const name of Object.keys(direct).slice(0, 300)) {
    const key = `node_modules/${name}`;
    const onDisk = readJson(path.join(root, 'node_modules', ...name.split('/'), 'package.json'));
    if (!onDisk) {
      if (packages[key] && !packages[key].os && !packages[key].cpu) return false;
      continue;
    }
    if (!packages[key] || packages[key].version !== onDisk.version) return false;
  }
  return true;
}

function hasInstallScript(pj) {
  return Boolean(pj?.scripts?.install || pj?.scripts?.preinstall || pj?.scripts?.postinstall);
}

function walk(root) {
  const out = {};
  const visit = (dir, prefix, depth) => {
    if (depth > 40) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || !ent.isDirectory()) continue;
      if (ent.name.startsWith('@')) {
        let scoped;
        try {
          scoped = fs.readdirSync(path.join(dir, ent.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of scoped) {
          if (sub.isDirectory()) pkg(path.join(dir, ent.name, sub.name), `${prefix}/${ent.name}/${sub.name}`, depth);
        }
      } else {
        pkg(path.join(dir, ent.name), `${prefix}/${ent.name}`, depth);
      }
    }
  };
  const pkg = (abs, key, depth) => {
    const pj = readJson(path.join(abs, 'package.json'));
    if (pj?.version) {
      const keyName = nameFromKey(key);
      out[key] = clean({
        name: pj.name && pj.name !== keyName ? pj.name : undefined,
        version: pj.version,
        script: hasInstallScript(pj) || undefined,
        os: pj.os,
        cpu: pj.cpu,
        deps: depsOf(pj),
      });
    }
    visit(path.join(abs, 'node_modules'), `${key}/node_modules`, depth + 1);
  };
  visit(path.join(root, 'node_modules'), 'node_modules', 0);
  return out;
}

/** pnpm: node_modules/.pnpm/<name>@<version>[_peers]/node_modules/<name> */
export function pnpmName(dir) {
  const at = dir.startsWith('@') ? dir.indexOf('@', 1) : dir.indexOf('@');
  if (at <= 0) return null;
  return dir.slice(0, at).replace('+', '/');
}

function readPnpm(root) {
  const store = path.join(root, 'node_modules', '.pnpm');
  const versions = new Map();
  let dirs = [];
  try {
    dirs = fs.readdirSync(store);
  } catch {}
  for (const dir of dirs) {
    if (dir.startsWith('.') || dir === 'node_modules' || dir === 'lock.yaml') continue;
    const name = pnpmName(dir);
    if (!name) continue;
    const pj = readJson(path.join(store, dir, 'node_modules', ...name.split('/'), 'package.json'));
    if (!pj?.version) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(pj.version);
  }
  const out = {};
  for (const [name, set] of [...versions].sort(([a], [b]) => a.localeCompare(b))) {
    out[`pnpm:${name}`] = { version: [...set].sort().join(' | ') };
  }
  return out;
}

export function readInstalled(root) {
  const pkgJson = readJson(path.join(root, 'package.json'), {});
  const manager = detectManager(root, pkgJson);
  const direct = directDeps(pkgJson);
  if (exists(path.join(root, '.pnp.cjs')) || exists(path.join(root, '.pnp.js'))) {
    return { manager, layout: 'pnp', packages: {} };
  }
  if (!exists(path.join(root, 'node_modules'))) return { manager, layout: 'none', packages: {} };

  if (exists(path.join(root, 'node_modules', '.pnpm'))) {
    const packages = readPnpm(root);
    for (const [key, entry] of Object.entries(packages)) {
      const kind = direct[key.slice('pnpm:'.length)];
      if (kind) entry.direct = kind;
    }
    return { manager: 'pnpm', layout: 'pnpm', packages };
  }

  let packages = readHiddenLockfile(root);
  let source = 'hidden-lockfile';
  if (!packages || !hiddenLockfileAgrees(root, packages, direct)) {
    packages = walk(root);
    source = 'walk';
  }
  for (const [name, kind] of Object.entries(direct)) {
    const entry = packages[`node_modules/${name}`];
    if (entry) entry.direct = kind;
  }
  const sorted = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)));
  return { manager, layout: 'hoisted', source, packages: sorted };
}
