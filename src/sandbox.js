// An isolated copy for `why --sandbox`. Tests and the bisector can write here;
// the user's project and node_modules remain byte-for-byte untouched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'lastgreen-sandbox-';

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function copyTree(sourceRoot, sandboxRoot) {
  let files = 0;
  let bytes = 0;
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
        if (top && entry.name === '.lastgreen') continue;
        if (entry.name === '.lastgreen-stash' && path.basename(source) === 'node_modules') continue;
        // A normal .git directory is safe to copy. A worktree's .git file points
        // at the original repository and must not be followed or copied.
        if (top && entry.name === '.git' && !entry.isDirectory()) continue;
        copy(path.join(source, entry.name), path.join(dest, entry.name));
      }
      return;
    }
    if (!stat.isFile()) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    try {
      fs.chmodSync(dest, stat.mode);
    } catch {}
    files++;
    bytes += stat.size;
  };
  copy(sourceRoot, sandboxRoot, true);
  return { files, bytes };
}

/** Copy a project into an owned temporary directory. Cleanup is idempotent. */
export function createSandbox(root) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const sandboxRoot = path.join(base, 'project');
  let live = true;
  const cleanup = () => {
    if (!live) return;
    live = false;
    // Only remove the exact directory returned by mkdtemp above.
    if (path.dirname(base) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith(PREFIX)) return;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    const stats = copyTree(root, sandboxRoot);
    return { base, root: sandboxRoot, ...stats, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
