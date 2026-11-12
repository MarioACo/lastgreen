// Get the exact tarball of a package version that used to be installed.
// Order: local cache -> file: tarball -> public registry URL -> `npm pack`
// (which honours the user's .npmrc, private registries and auth).
// Every tarball is checked against the integrity recorded at install time.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkIntegrity, exists, hashText, mkdirp, rename, rm } from './fsx.js';
import { download as httpDownload } from './http.js';
import { defaultResolved, nameFromKey } from './packages.js';
import { npmCliFor } from './runtime.js';

const SPEC_RE = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9~][\w.~-]*@[0-9A-Za-z.+-]+$/i;
const PUBLIC = /^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//;

function cacheFile(cacheDir, name, version, integrity) {
  const safe = name.replace(/^@/, '').replace(/[\\/]/g, '+');
  return path.join(cacheDir, 'pkgs', `${safe}-${version}-${integrity ? hashText(integrity, 10) : 'noint'}.tgz`);
}

function runNpmPack(specs, { cwd, env, nodePath, dest }) {
  return new Promise((resolve) => {
    const cli = npmCliFor(nodePath);
    const args = ['pack', ...specs, '--pack-destination', dest, '--json', '--ignore-scripts', '--loglevel=error'];
    // npm's own JS entry point, run by node directly: no shell, so nothing in a
    // spec can ever be interpreted as a command.
    if (!cli) return resolve({ ok: false, error: 'npm not found' });
    if (!specs.every((s) => SPEC_RE.test(s) || /^(git\+|git:|github:|https?:\/\/)\S+$/.test(s))) return resolve({ ok: false, error: 'unexpected package spec' });
    const child = spawn(nodePath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: err.trim().split('\n').slice(-3).join(' ') || `npm pack exited ${code}` });
      try {
        const start = out.indexOf('[');
        resolve({ ok: true, items: JSON.parse(out.slice(start)) });
      } catch {
        resolve({ ok: false, error: 'could not read npm pack output' });
      }
    });
  });
}

async function download(url, file) {
  const tmp = `${file}.${process.pid}.part`;
  try {
    await httpDownload(url, tmp, { timeoutMs: 120_000 });
    rename(tmp, file);
  } finally {
    rm(tmp);
  }
}

/**
 * @param {{id: string, key: string, entry: {name?: string, version: string, resolved?: string, integrity?: string}}[]} items
 * @returns {Promise<Map<string, {file?: string, error?: string}>>} by item id
 */
export async function ensureTarballs(items, { root, cacheDir, env = process.env, nodePath, offline = false, onProgress } = {}) {
  const results = new Map();
  const pending = [];
  mkdirp(path.join(cacheDir, 'pkgs'));

  for (const item of items) {
    const { entry } = item;
    const name = entry.name ?? nameFromKey(item.key);
    const file = cacheFile(cacheDir, name, entry.version, entry.integrity);
    if (exists(file) && checkIntegrity(file, entry.integrity)) {
      results.set(item.id, { file });
      continue;
    }
    rm(file);
    if (entry.resolved?.startsWith('file:')) {
      const local = path.resolve(root, entry.resolved.slice(5));
      if (!local.endsWith('.tgz') || !exists(local)) {
        results.set(item.id, { error: 'local-package' });
      } else if (!checkIntegrity(local, entry.integrity)) {
        results.set(item.id, { error: 'integrity' });
      } else {
        fs.copyFileSync(local, file);
        results.set(item.id, { file });
      }
      continue;
    }
    pending.push({ item, name, file });
  }

  if (offline) {
    for (const p of pending) results.set(p.item.id, { error: 'offline' });
    return results;
  }

  // 1) Public registry: plain HTTPS download, verified by integrity.
  const viaNpm = [];
  let done = 0;
  const queue = [...pending];
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      const url = p.item.entry.resolved ?? defaultResolved(p.name, p.item.entry.version);
      if (!PUBLIC.test(url)) {
        viaNpm.push(p);
        continue;
      }
      try {
        await download(url, p.file);
        if (!checkIntegrity(p.file, p.item.entry.integrity)) {
          rm(p.file);
          results.set(p.item.id, { error: 'integrity' });
        } else {
          results.set(p.item.id, { file: p.file });
        }
      } catch {
        viaNpm.push(p);
      }
      onProgress?.(++done, pending.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));

  // 2) Everything else through `npm pack` (private registries, git, auth).
  if (viaNpm.length) {
    const dest = path.join(cacheDir, 'pkgs', `.pack-${process.pid}`);
    mkdirp(dest);
    try {
      const specOf = (p) => {
        const r = p.item.entry.resolved;
        return r && /^(git\+|git:|github:|https?:\/\/(?!registry\.))/.test(r) && !r.endsWith('.tgz') ? r : `${p.name}@${p.item.entry.version}`;
      };
      const packOne = async (batch) => {
        const res = await runNpmPack(batch.map(specOf), { cwd: root, env, nodePath, dest });
        if (!res.ok) return false;
        batch.forEach((p, i) => {
          const got = res.items[i];
          const src = got && path.join(dest, got.filename);
          if (!got || !exists(src)) return results.set(p.item.id, { error: 'npm-pack' });
          if (!checkIntegrity(src, p.item.entry.integrity)) {
            rm(src);
            return results.set(p.item.id, { error: 'integrity' });
          }
          rename(src, p.file);
          results.set(p.item.id, { file: p.file });
        });
        return true;
      };
      if (!(await packOne(viaNpm))) {
        for (const p of viaNpm) {
          if (!(await packOne([p]))) results.set(p.item.id, { error: 'npm-pack' });
        }
      }
    } finally {
      rm(dest);
    }
  }
  return results;
}
