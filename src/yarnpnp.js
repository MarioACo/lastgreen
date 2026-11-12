// Yarn Berry Plug'n'Play support. The generated loader is inspected in a
// separate Node process, then candidate dependency sets are materialized by
// Yarn inside lastgreen's mandatory sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exists, mkdirp, readJson } from './fsx.js';
import { prependPath, setEnv } from './env.js';
import { runCommand } from './exec.js';

const INSPECT = String.raw`
const fs = require('fs');
const path = require('path');
const pnp = require('pnpapi');
const root = process.argv[1];
const locatorKey = locator => JSON.stringify([locator.name, locator.reference]);
const getLocators = () => {
  if (typeof pnp.getAllLocators === 'function') return pnp.getAllLocators();
  const out = [], queue = [...pnp.getDependencyTreeRoots()], seen = new Set();
  while (queue.length) {
    const locator = queue.shift(), key = locatorKey(locator);
    if (seen.has(key)) continue;
    seen.add(key); out.push(locator);
    const info = pnp.getPackageInformation(locator);
    for (const [name, target] of info?.packageDependencies || []) {
      if (target !== null) queue.push(pnp.getLocator(name, target));
    }
  }
  return out;
};
const physical = locator => {
  const info = pnp.getPackageInformation(locator);
  if (!info || !String(locator.reference).startsWith('virtual:') || typeof pnp.resolveVirtual !== 'function') return locator;
  return pnp.findPackageLocator(pnp.resolveVirtual(info.packageLocation)) || locator;
};
const keyOf = locator => {
  const p = physical(locator);
  return 'yarn:' + p.name + '@' + p.reference;
};
const packages = {};
for (const raw of getLocators()) {
  const locator = physical(raw);
  if (!locator?.name || !locator.reference || /^(workspace|portal|link):/.test(locator.reference)) continue;
  const info = pnp.getPackageInformation(locator);
  if (!info || info.linkType === 'SOFT') continue;
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(info.packageLocation, 'package.json'), 'utf8')); } catch {}
  if (!manifest.version) continue;
  const key = keyOf(locator);
  packages[key] ||= {
    name: locator.name,
    version: manifest.version,
    reference: locator.reference,
    script: Boolean(manifest.scripts?.install || manifest.scripts?.preinstall || manifest.scripts?.postinstall) || undefined,
    os: manifest.os,
    cpu: manifest.cpu,
    deps: Object.keys({...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.dependencies}).length
      ? {...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.dependencies} : undefined,
    repository: manifest.repository,
    homepage: manifest.homepage,
    directLocations: [],
  };
}
for (const rootLocator of pnp.getDependencyTreeRoots()) {
  const info = pnp.getPackageInformation(rootLocator);
  if (!info) continue;
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(info.packageLocation, 'package.json'), 'utf8')); } catch {}
  const manifestPath = path.relative(root, path.join(info.packageLocation, 'package.json')).split(path.sep).join('/');
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] || {})) {
      const target = info.packageDependencies.get(name);
      if (target == null) continue;
      const key = keyOf(pnp.getLocator(name, target));
      if (!packages[key]) continue;
      packages[key].directLocations.push({ manifest: manifestPath || 'package.json', field, range, request: name });
      packages[key].direct ||= field === 'devDependencies' ? 'dev' : 'prod';
    }
  }
}
process.stdout.write(JSON.stringify({packages}));
`;

export function pnpLoader(root) {
  for (const name of ['.pnp.cjs', '.pnp.js']) {
    const file = path.join(root, name);
    if (exists(file)) return file;
  }
  return null;
}

/** Read the exact installed PnP graph through Yarn's public PnP API. */
export function readYarnPnp(root) {
  const loader = pnpLoader(root);
  if (!loader) return null;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['--require', loader, '-e', INSPECT, root], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return { packages: {}, error: String(result.stderr || 'could not inspect .pnp.cjs').trim() };
  try {
    const parsed = JSON.parse(result.stdout);
    parsed.packages = Object.fromEntries(Object.entries(parsed.packages ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    return parsed;
  } catch {
    return { packages: {}, error: 'invalid PnP inspector output' };
  }
}

const MANIFEST_FIELDS = ['dependencies', 'optionalDependencies', 'devDependencies'];

export class YarnPnpWorkspace {
  constructor(root, journalPath, { offline = false, version = null, rebuild = false } = {}) {
    this.root = root;
    this.journalPath = journalPath;
    this.offline = offline;
    this.version = version;
    this.rebuild = rebuild;
    this.nodeDir = null;
    this.originals = new Map();
    this.manifests = new Map();
    this.lastSignature = '';
    this.onChild = null;
  }

  remember(relative) {
    if (this.originals.has(relative)) return;
    const file = path.join(this.root, ...relative.split('/'));
    this.originals.set(relative, exists(file) ? fs.readFileSync(file) : null);
  }

  begin(factors) {
    const manifests = new Set(['package.json']);
    for (const factor of factors) {
      for (const loc of [...(factor.yarn?.greenDirect ?? []), ...(factor.yarn?.currentDirect ?? [])]) manifests.add(loc.manifest);
    }
    for (const relative of manifests) {
      this.remember(relative);
      const value = readJson(path.join(this.root, ...relative.split('/')));
      if (value) this.manifests.set(relative, value);
    }
    for (const relative of ['yarn.lock', '.pnp.cjs', '.pnp.js', '.pnp.loader.mjs', '.yarn/install-state.gz']) this.remember(relative);
    this.factors = factors;
  }

  writeManifests(currentIds) {
    const values = new Map([...this.manifests].map(([file, value]) => [file, JSON.parse(JSON.stringify(value))]));
    const root = values.get('package.json');
    for (const factor of this.factors) {
      if (factor.kind !== 'package' || !factor.yarn || currentIds.has(factor.id)) continue;
      if (factor.change === 'changed') {
        root.resolutions = { ...(root.resolutions ?? {}), [factor.name]: factor.yarn.resolution };
      } else if (factor.change === 'added') {
        for (const loc of factor.yarn.currentDirect) {
          const manifest = values.get(loc.manifest);
          for (const field of MANIFEST_FIELDS) if (manifest?.[field]) delete manifest[field][loc.request ?? factor.name];
        }
      } else if (factor.change === 'removed') {
        for (const loc of factor.yarn.greenDirect) {
          const manifest = values.get(loc.manifest);
          if (!manifest) continue;
          manifest[loc.field] = { ...(manifest[loc.field] ?? {}), [loc.request ?? factor.name]: loc.range };
        }
      }
    }
    for (const [relative, value] of values) {
      const file = path.join(this.root, ...relative.split('/'));
      mkdirp(path.dirname(file));
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    }
  }

  async apply(currentIds) {
    const old = this.factors.filter((f) => f.kind === 'package' && f.yarn && !currentIds.has(f.id)).map((f) => f.id).sort();
    const signature = old.join('\n');
    if (signature === this.lastSignature) return;
    this.writeManifests(currentIds);
    const env = {
      ...process.env,
      YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
      YARN_ENABLE_SCRIPTS: this.rebuild ? 'true' : 'false',
      YARN_ENABLE_GLOBAL_CACHE: 'false',
      YARN_GLOBAL_FOLDER: path.join(this.root, '.lastgreen', 'yarn-global'),
      ...(/^4\./.test(this.version ?? '') ? { YARN_ENABLE_HARDENED_MODE: 'false' } : {}),
      ...(this.offline ? { YARN_ENABLE_NETWORK: 'false' } : {}),
    };
    const command = this.rebuild ? 'yarn install' : 'yarn install --mode=skip-build';
    const result = await runCommand(command, { cwd: this.root, env, timeoutMs: 120_000, onChild: this.onChild });
    if (result.code !== 0) {
      const detail = result.tail.trim().split(/\r?\n/).slice(-6).join('\n');
      throw Object.assign(new Error(`Yarn could not materialize a PnP candidate${detail ? `:\n${detail}` : ''}`), { code: 'ESTATE' });
    }
    this.lastSignature = signature;
  }

  envFor(currentIds, factors, baseEnv = process.env) {
    const env = { ...baseEnv };
    for (const factor of factors) {
      if (currentIds.has(factor.id)) continue;
      if (factor.kind === 'env') setEnv(env, factor.name, factor.change === 'added' ? null : factor.from);
      if (factor.kind === 'node' && this.nodeDir) prependPath(env, this.nodeDir);
    }
    return env;
  }

  restore() {
    for (const [relative, contents] of this.originals) {
      const file = path.join(this.root, ...relative.split('/'));
      if (contents === null) fs.rmSync(file, { recursive: true, force: true });
      else {
        mkdirp(path.dirname(file));
        fs.writeFileSync(file, contents);
      }
    }
    this.lastSignature = '';
    return { restored: this.originals.size };
  }

  verify() {
    const wrong = [];
    for (const [relative, contents] of this.originals) {
      const file = path.join(this.root, ...relative.split('/'));
      if (contents === null ? exists(file) : !exists(file) || !fs.readFileSync(file).equals(contents)) wrong.push(relative);
    }
    return wrong;
  }

  setTarball() {}
}
