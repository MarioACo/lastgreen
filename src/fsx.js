// Small filesystem helpers. Everything that moves directories around goes
// through here so Windows lock retries (antivirus, indexers, OneDrive) live in
// one place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EMFILE']);

export function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rename with retries: on Windows a freshly written folder is often locked for a moment. */
export function rename(from, to) {
  let delay = 20;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt >= 14) throw err;
      sleepSync(delay);
      delay = Math.min(delay * 2, 500);
    }
  }
}

export function rm(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically (temp file + rename) so a crash never leaves half a file. */
export function writeJson(p, value, { pretty = false } = {}) {
  mkdirp(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0) + '\n');
  rename(tmp, p);
}

export function hashText(text, length = 16) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length);
}

export function hashFile(p, length = 16) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, length);
  } catch {
    return null;
  }
}

/** Verify an npm-style SRI string ("sha512-<base64>") against a file. */
export function checkIntegrity(file, integrity) {
  if (!integrity) return true;
  const data = fs.readFileSync(file);
  return integrity.split(/\s+/).filter(Boolean).some((sri) => {
    const dash = sri.indexOf('-');
    const algo = sri.slice(0, dash);
    if (!['sha512', 'sha384', 'sha256', 'sha1'].includes(algo)) return false;
    return crypto.createHash(algo).update(data).digest('base64') === sri.slice(dash + 1);
  });
}

export function sriOf(file, algo = 'sha512') {
  return `${algo}-${crypto.createHash(algo).update(fs.readFileSync(file)).digest('base64')}`;
}
