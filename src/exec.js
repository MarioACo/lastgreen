// Running the user's command: live (tee) for `run`, captured for bisect runs.
import { spawn, spawnSync } from 'node:child_process';

const TAIL_BYTES = 12_000;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

/** Join argv into one shell command line, quoting for cmd.exe or POSIX sh. */
export function shellJoin(args, platform = process.platform) {
  if (args.length === 1) return args[0];
  return args
    .map((arg) => {
      if (arg !== '' && /^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
      if (platform === 'win32') return `"${arg.replace(/"/g, '""')}"`;
      return `'${arg.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

export function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

/**
 * The one place lastgreen uses a shell, on purpose: it runs the test command
 * the user configured (`npm test`, `vitest run && eslint .`) exactly as their own
 * shell would. That command comes from the user's own package.json, CLI flag or
 * snapshot, never from downloaded data. Everything else (npm, git, node, package
 * managers) is spawned without a shell.
 * @param {string} command shell command line
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, tee?: boolean, timeoutMs?: number, onChild?: (child: import('node:child_process').ChildProcess|null) => void}} options
 * @returns {Promise<{code: number|null, signal: string|null, durationMs: number, tail: string, timedOut: boolean, error?: string}>}
 */
export function runCommand(command, { cwd, env = process.env, tee = false, timeoutMs = 0, onChild } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let tail = '';
    let timedOut = false;
    const keep = (chunk) => {
      tail += chunk.toString('utf8');
      if (tail.length > TAIL_BYTES * 2) tail = tail.slice(-TAIL_BYTES);
    };
    let child;
    try {
      child = spawn(command, {
        cwd,
        env,
        shell: true,
        stdio: [tee ? 'inherit' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !tee && process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ code: null, signal: null, durationMs: 0, tail: '', timedOut: false, error: err.message });
      return;
    }
    child.stdout.on('data', (chunk) => {
      keep(chunk);
      if (tee) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      keep(chunk);
      if (tee) process.stderr.write(chunk);
    });
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeoutMs)
        : null;
    onChild?.(child);
    let settled = false;
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      onChild?.(null);
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        durationMs: Date.now() - started,
        tail: stripAnsi(tail).slice(-TAIL_BYTES),
        timedOut,
        error,
      });
    };
    child.on('error', (err) => finish(null, null, err.message));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** Run a short helper process and return trimmed stdout, or null. */
export function capture(file, args, { cwd, env = process.env, timeoutMs = 10_000, shell = false } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(file, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
    child.stdout.on('data', (c) => (out += c));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
  });
}

/** Run an executable with arguments, no shell, output shown live. */
export function runFile(file, args, { cwd, env = process.env, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    } catch (err) {
      resolve({ code: null, error: err.message });
      return;
    }
    const timer = timeoutMs > 0 ? setTimeout(() => killTree(child), timeoutMs) : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, error: err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code });
    });
  });
}
