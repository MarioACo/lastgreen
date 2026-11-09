// An isolated copy for `why`. Tests and the bisector can write here; the
// user's project and node_modules remain byte-for-byte untouched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'lastgreen-sandbox-';
const META = '.lastgreen-sandbox.json';
const MIN_FREE = 64 * 1024 * 1024;

function skip(relative) {
  const rel = relative.split(path.sep).join('/');
  return rel === '.lastgreen' || rel.startsWith('.lastgreen/')
    || rel === 'node_modules/.lastgreen-stash' || rel.startsWith('node_modules/.lastgreen-stash/')
    || rel === '.cache' || rel.startsWith('.cache/')
    || rel === '.turbo' || rel.startsWith('.turbo/')
    || rel === '.nx' || rel.startsWith('.nx/')
    || rel === '.parcel-cache' || rel.startsWith('.parcel-cache/')
    || rel === '.next/cache' || rel.startsWith('.next/cache/')
    || rel === 'node_modules/.cache' || rel.startsWith('node_modules/.cache/')
    || rel === '.eslintcache' || rel === '.stylelintcache';
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function copyTree(sourceRoot, sandboxRoot, { copyFile } = {}) {
  let files = 0;
  let bytes = 0;
  let cloneSupported = copyFile ? false : null;
  let strategy = copyFile ? 'custom' : 'copy';
  const copyOne = (source, dest) => {
    if (copyFile) return copyFile(source, dest);
    if (cloneSupported !== false && fs.constants.COPYFILE_FICLONE_FORCE != null) {
      try {
        fs.copyFileSync(source, dest, fs.constants.COPYFILE_FICLONE_FORCE);
        cloneSupported = true;
        if (strategy === 'copy') strategy = 'copy-on-write';
        return;
      } catch {
        if (cloneSupported) strategy = 'mixed';
        cloneSupported = false;
      }
    }
    fs.copyFileSync(source, dest);
  };
  const copy = (source, dest, top = false) => {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      const raw = fs.readlinkSync(source);
      const absolute = path.resolve(path.dirname(source), raw);
      let target = raw;
      if (inside(sourceRoot, absolute)) {
        const mapped = path.join(sandboxRoot, path.relative(sourceRoot, absolute));
        target = process.platform === 'win32' ? mapped : path.relative(path.dirname(dest), mapped) || '.';
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let type;
      try {
        type = fs.statSync(source).isDirectory() && process.platform === 'win32' ? 'junction' : undefined;
      } catch {}
      fs.symlinkSync(target, dest, type);
      return;
    }
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true, mode: stat.mode });
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const child = path.join(source, entry.name);
        if (skip(path.relative(sourceRoot, child))) continue;
        // A normal .git directory is safe to copy. A worktree's .git file points
        // at the original repository and must not be followed or copied.
        if (top && entry.name === '.git' && !entry.isDirectory()) continue;
        copy(child, path.join(dest, entry.name));
      }
      return;
    }
    if (!stat.isFile()) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyOne(source, dest);
    try {
      fs.chmodSync(dest, stat.mode);
    } catch {}
    files++;
    bytes += stat.size;
  };
  copy(sourceRoot, sandboxRoot, true);
  return { files, bytes, strategy };
}

function projectSize(root) {
  let files = 0;
  let bytes = 0;
  let excludedPaths = 0;
  const visit = (source, top = false) => {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const child = path.join(source, entry.name);
        if (skip(path.relative(root, child))) {
          excludedPaths++;
          continue;
        }
        if (top && entry.name === '.git' && !entry.isDirectory()) continue;
        visit(child);
      }
    } else if (stat.isFile()) {
      files++;
      bytes += stat.size;
    }
  };
  visit(root, true);
  return { files, bytes, excludedPaths };
}

function freeBytes(at) {
  if (typeof fs.statfsSync !== 'function') return null; // Node 16 before 16.18
  try {
    const stat = fs.statfsSync(at);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Remove temporary copies left by processes that are no longer running. */
export function cleanupStaleSandboxes({ tempRoot = os.tmpdir(), maxUnknownAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(tempRoot, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const base = path.join(tempRoot, entry.name);
    let stale = false;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(base, META), 'utf8'));
      stale = !alive(meta.pid);
    } catch {
      try {
        stale = Date.now() - fs.statSync(base).mtimeMs > maxUnknownAgeMs;
      } catch {}
    }
    if (!stale) continue;
    try {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      removed++;
    } catch {}
  }
  return removed;
}

/** Copy a project into an owned temporary directory. Cleanup is idempotent. */
export function createSandbox(root, { tempRoot = os.tmpdir(), availableBytes, copyFile } = {}) {
  const started = Date.now();
  const estimate = projectSize(root);
  const scanMs = Date.now() - started;
  const available = availableBytes === undefined ? freeBytes(tempRoot) : availableBytes;
  const required = estimate.bytes + Math.max(MIN_FREE, Math.ceil(estimate.bytes * 0.1));
  if (available != null && available < required) {
    const err = new Error(`need ${(required / 1024 / 1024).toFixed(0)} MB free, but only ${(available / 1024 / 1024).toFixed(0)} MB is available`);
    err.code = 'ENOSPC';
    err.details = { ...estimate, scanMs, availableBytes: available, requiredBytes: required };
    throw err;
  }
  const resolvedTemp = path.resolve(tempRoot);
  const base = fs.mkdtempSync(path.join(resolvedTemp, PREFIX));
  const sandboxRoot = path.join(base, 'project');
  let live = true;
  const cleanup = () => {
    if (!live) return;
    live = false;
    // Only remove the exact directory returned by mkdtemp above.
    if (path.dirname(base) !== resolvedTemp || !path.basename(base).startsWith(PREFIX)) return;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    fs.writeFileSync(path.join(base, META), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const copyStarted = Date.now();
    const stats = copyTree(root, sandboxRoot, { copyFile });
    return {
      base,
      root: sandboxRoot,
      ...stats,
      estimatedFiles: estimate.files,
      estimatedBytes: estimate.bytes,
      excludedPaths: estimate.excludedPaths,
      availableBytes: available,
      requiredBytes: required,
      scanMs,
      copyMs: Date.now() - copyStarted,
      cleanup,
    };
  } catch (err) {
    err.details ??= {
      ...estimate,
      scanMs,
      availableBytes: available,
      requiredBytes: required,
    };
    try {
      cleanup();
    } catch {}
    throw err;
  }
}
