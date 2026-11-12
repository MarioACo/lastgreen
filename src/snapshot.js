// A snapshot is the fingerprint of everything outside your source code that
// can make the same code pass or fail: installed packages, Node, package
// manager, behavioural env vars, config files and the git state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureEnv } from './env.js';
import { capture } from './exec.js';
import { hashFile, hashText, readJson, real } from './fsx.js';
import { packagesFromNpmLock, readInstalled } from './packages.js';
import { managerVersion, npmVersionFor, probeNode } from './runtime.js';

export const VERSION = readJson(new URL('../package.json', import.meta.url), {})?.version ?? '0.0.0';

const PROJECT_FILES = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'yarn.lock', 'bun.lock', 'bun.lockb', '.npmrc', '.nvmrc', '.node-version', '.tool-versions',
  '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs',
];
const HOME_FILES = ['.npmrc', '.yarnrc', '.yarnrc.yml'];

export function machineId() {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {}
  return hashText(`${os.hostname()}\0${user}`, 12);
}

function projectFiles(root) {
  const names = new Set(PROJECT_FILES);
  try {
    for (const f of fs.readdirSync(root)) if (f === '.env' || f.startsWith('.env.')) names.add(f);
  } catch {}
  const out = {};
  for (const name of [...names].sort()) {
    const h = hashFile(path.join(root, name));
    if (h) out[name] = h;
  }
  return out;
}

function homeFiles() {
  const out = {};
  for (const name of HOME_FILES) {
    const h = hashFile(path.join(os.homedir(), name));
    if (h) out[`~/${name}`] = h;
  }
  return out;
}

export async function gitInfo(root) {
  const out = await capture('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], {
    cwd: root,
    timeoutMs: 15_000,
  });
  if (out == null) return null;
  let head = null;
  let branch = null;
  const dirty = {};
  let count = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) head = line.slice(13).trim();
    else if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
    else if (line && !line.startsWith('#')) {
      const fields = line.split(' ');
      let file = null;
      if (line[0] === '1') file = fields.slice(8).join(' ');
      else if (line[0] === '2') file = fields.slice(9).join(' ').split('\t')[0];
      else if (line[0] === 'u') file = fields.slice(10).join(' ');
      else if (line[0] === '?') file = line.slice(2);
      if (!file) continue;
      count++;
      if (count > 300) continue;
      dirty[file] = file.endsWith('/') ? 'dir' : hashFile(path.join(root, file)) ?? 'deleted';
    }
  }
  if (head === '(initial)') head = null;
  return { head, branch, dirty, dirtyCount: count };
}

/**
 * @param {string} root project root (folder with package.json)
 * @param {NodeJS.ProcessEnv} env environment the command runs with
 */
export async function takeSnapshot(root, env, { ignoreEnv = [] } = {}) {
  const installed = readInstalled(root);
  const [node, git, managerVer] = await Promise.all([
    probeNode(env, root),
    gitInfo(root),
    managerVersion(installed.manager, env, root),
  ]);
  const tools = {};
  const npm = npmVersionFor(node?.path);
  if (npm) tools.npm = npm;
  if (managerVer && installed.manager) tools[installed.manager] = managerVer;
  return {
    v: 1,
    at: new Date().toISOString(),
    tool: `lastgreen@${VERSION}`,
    system: { platform: process.platform, arch: process.arch, release: os.release(), machine: machineId() },
    node: node ? { version: node.version, arch: node.arch, path: node.path } : null,
    tools,
    manager: installed.manager,
    layout: installed.layout,
    ...(installed.error ? { packageError: installed.error } : {}),
    ...(installed.pnpm ? { pnpm: installed.pnpm } : {}),
    packages: installed.packages,
    files: projectFiles(root),
    home: homeFiles(),
    env: captureEnv(env, { ignore: ignoreEnv }),
    git,
  };
}

/** Build an npm baseline from a package-lock/shrinkwrap stored in Git. */
export async function takeGitSnapshot(root, current, requestedRef = null) {
  const repo = await capture('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  if (!repo) return { error: 'repo' };
  // Compare canonical paths: Git may print a long path while the project path is a
  // Windows 8.3 short name (RUNNER~1), and macOS mixes /var and /private/var.
  const relRoot = path.relative(real(repo), real(root));
  if (relRoot.startsWith('..') || path.isAbsolute(relRoot)) return { error: 'repo' };
  const gitPath = (name) => (relRoot && relRoot !== '.' ? `${relRoot.split(path.sep).join('/')}/${name}` : name);
  const showAt = (commit, name) => capture('git', ['show', `${commit}:${gitPath(name)}`], { cwd: repo, timeoutMs: 15_000 });

  let ref = requestedRef;
  if (!ref) {
    const trackedLock = ['npm-shrinkwrap.json', 'package-lock.json'].find((name) => fs.existsSync(path.join(root, name)));
    const changed = trackedLock
      ? await capture('git', ['diff', '--name-only', 'HEAD', '--', gitPath(trackedLock)], { cwd: repo, timeoutMs: 15_000 })
      : '';
    ref = changed ? 'HEAD' : 'HEAD^';
  }
  const commit = await capture('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repo, timeoutMs: 15_000 });
  if (!commit) return { error: 'ref', ref };

  const packageText = await showAt(commit, 'package.json');
  if (!packageText) return { error: 'package', ref };
  let pkg;
  try {
    pkg = JSON.parse(packageText);
  } catch {
    return { error: 'package', ref };
  }
  let lockName = 'npm-shrinkwrap.json';
  let lockText = await showAt(commit, lockName);
  if (!lockText) {
    lockName = 'package-lock.json';
    lockText = await showAt(commit, lockName);
  }
  if (!lockText) return { error: 'lock', ref };
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return { error: 'lock', ref };
  }
  const packages = packagesFromNpmLock(lock, pkg);
  if (!packages) return { error: 'lock', ref };
  const at = (await capture('git', ['show', '-s', '--format=%cI', commit], { cwd: repo, timeoutMs: 15_000 })) || new Date().toISOString();
  const snapshot = JSON.parse(JSON.stringify(current));
  snapshot.at = at;
  snapshot.status = 'git';
  snapshot.manager = 'npm';
  snapshot.layout = 'hoisted';
  snapshot.packages = packages;
  snapshot.git = { head: commit, branch: null, dirty: {}, dirtyCount: 0 };
  snapshot.gitBaseline = { ref, commit };
  snapshot.files = { ...(current.files ?? {}) };
  delete snapshot.files['package-lock.json'];
  delete snapshot.files['npm-shrinkwrap.json'];
  snapshot.files['package.json'] = hashText(packageText);
  snapshot.files[lockName] = hashText(lockText);
  return { snapshot };
}

/** Copy that is safe to send to a teammate: no output, no local paths. */
export function redact(snapshot) {
  const copy = JSON.parse(JSON.stringify(snapshot));
  delete copy.output;
  if (copy.node) delete copy.node.path;
  delete copy.cwd;
  if (copy.git) copy.git.dirty = Object.fromEntries(Object.keys(copy.git.dirty ?? {}).map((f) => [f, 'redacted']));
  copy.exported = true;
  return copy;
}
