import fs from 'node:fs';
import path from 'node:path';
import { computeCoupling, computeDiff, couple, greenClosure } from './diff.js';
import { capture, killTree, runCommand, shellJoin } from './exec.js';
import { ensureTarballs } from './fetch.js';
import { readJson, writeJson } from './fsx.js';
import { findCulprit } from './bisect.js';
import { explainCulprits, failingLocations } from './explain.js';
import { ago, factorLabel, reasonText, t } from './i18n.js';
import { downloadNode, findNodeDir, probeNode } from './runtime.js';
import { redact, takeSnapshot, VERSION } from './snapshot.js';
import { Store, cacheDir, findRoot, loadConfig } from './store.js';
import { c, configureFor, createWriter, pad, seconds, sym } from './ui.js';
import { prependPath } from './env.js';
import { detectManager } from './packages.js';
import { Workspace } from './workspace.js';
import { PnpmWorkspace } from './pnpm.js';

class UserError extends Error {}

function requireRoot() {
  const root = findRoot(process.cwd());
  if (!root) throw new UserError(t('noProject'));
  return root;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** If a previous bisect was interrupted, put node_modules back before doing anything else. */
function recoverIfNeeded(root, store, say) {
  if (!Workspace.pending(store.journal)) return;
  const journal = readJson(store.journal);
  if (journal?.pid && journal.pid !== process.pid && alive(journal.pid)) {
    throw new UserError(t('busy', journal.pid));
  }
  const { restored } = Workspace.recover(root, store.journal);
  say(c.yellow(`${sym.warn} ${t('recovered', restored)}`));
}

function defaultCommand(root, manager) {
  const test = readJson(path.join(root, 'package.json'), {})?.scripts?.test;
  if (!test || /no test specified/.test(test)) return null;
  return manager === 'bun' ? 'bun run test' : `${manager ?? 'npm'} test`;
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function countPackages(snap) {
  return Object.keys(snap.packages ?? {}).length;
}

// ---------------------------------------------------------------- run

export async function cmdRun(rest) {
  const say = createWriter(process.stderr);
  configureFor(process.stderr);
  const root = requireRoot();
  const store = new Store(root);
  recoverIfNeeded(root, store, say);
  const config = loadConfig(root);
  const command = rest.length ? shellJoin(rest) : config.command ?? defaultCommand(root, detectManager(root));
  if (!command) throw new UserError(t('noCommand'));

  const hidden = path.join(root, 'node_modules', '.package-lock.json');
  const before = mtime(hidden);
  const snapPromise = takeSnapshot(root, process.env, { ignoreEnv: config.ignoreEnv });
  const result = await runCommand(command, { cwd: process.cwd(), tee: true });
  let snap = await snapPromise;
  if (mtime(hidden) !== before) snap = await takeSnapshot(root, process.env, { ignoreEnv: config.ignoreEnv });

  const green = result.code === 0;
  Object.assign(snap, {
    status: green ? 'green' : 'red',
    command,
    cwd: path.relative(root, process.cwd()).split(path.sep).join('/'),
    exitCode: result.code,
    durationMs: result.durationMs,
  });
  if (!green) snap.output = result.tail;
  const previousGreen = store.latest('green');
  store.save(snap);

  const tag = c.dim('lastgreen');
  if (green) {
    say(`${tag} ${c.green(sym.ok)} ${t('greenSaved', countPackages(snap), snap.node?.version)}`);
  } else if (previousGreen) {
    const diff = computeDiff(previousGreen, snap, { output: result.tail });
    const suspects = groupForDisplay(diff.factors, diff.coupling).filter((g) => g.factor.kind !== 'file' || g.factor.name.startsWith('.env'));
    if (!suspects.length) {
      say(`${tag} ${c.red(sym.fail)} ${t('redNoChanges', ago(previousGreen.at))}`);
    } else {
      const top = suspects.slice(0, 3).map((g) => factorLabel(g.factor)).join(', ');
      const more = suspects.length > 3 ? ` ${t('andMore', suspects.length - 3)}` : '';
      say(`${tag} ${c.red(sym.fail)} ${t('redSummary', diff.factors.length, ago(previousGreen.at))}: ${top}${more}`);
      say(`${' '.repeat(10)}${sym.arrow} ${t('runWhy')} ${c.cyan('npx lastgreen why')}`);
    }
  } else {
    say(`${tag} ${c.red(sym.fail)} ${t('redNoGreen')}`);
  }
  process.exitCode = result.code ?? 1;
}

// ---------------------------------------------------------------- why / diff

function loadSnapshotFile(file) {
  const snap = readJson(path.resolve(file));
  if (!snap?.packages) throw new UserError(t('badSnapshot', file));
  return snap;
}

async function countCommits(root, from, to) {
  if (!from || !to) return null;
  const out = await capture('git', ['rev-list', '--count', `${from}..${to}`], { cwd: root });
  return out == null ? null : Number(out);
}

/**
 * For display only: transitive packages that changed *because* a direct
 * dependency changed are listed under it ("chalk 4 → 5 (+5 of its deps)").
 */
function groupForDisplay(factors, coupling) {
  const owner = new Map();
  const groups = [];
  for (const f of factors) {
    if (owner.has(f.id)) continue;
    const members = [];
    if (f.kind === 'package' && f.direct && coupling) {
      const related = new Set([...greenClosure([f.id], coupling), ...couple(new Set([f.id]), [], coupling)]);
      related.delete(f.id);
      for (const id of related) {
        const m = factors.find((x) => x.id === id);
        if (m && !m.direct && !owner.has(id)) {
          owner.set(id, f.id);
          members.push(m);
        }
      }
    }
    groups.push({ factor: f, members });
  }
  return groups.filter((g) => !owner.has(g.factor.id) || g.members.length);
}

function printDiff(say, diff, green) {
  const when = green.exported ? t('exportedFrom', ago(green.at)) : ago(green.at);
  say(`${c.bold(t('lastGreen'))}  ${when}${green.command ? ` ${sym.dot} ${green.command}` : ''}${green.durationMs ? ` ${sym.dot} ${seconds(green.durationMs)}` : ''}`);
  if (!diff.factors.length) return;
  const groups = groupForDisplay(diff.factors, diff.coupling);
  const testable = groups.filter((g) => g.factor.testable);
  const info = groups.filter((g) => !g.factor.testable);
  say('');
  say(c.bold(t('changesSince', diff.factors.length)));
  const show = (list, limit) => {
    for (const { factor: f, members } of list.slice(0, limit)) {
      const kind = c.dim(pad(t(`kind.${f.kind}`), 13));
      const tags = f.tags.filter((x) => !['changed', 'added', 'removed'].includes(x)).map((x) => t(`tag.${x}`));
      const note = f.testable ? '' : c.dim(` (${reasonText(f)})`);
      const deps = members.length ? c.dim(` ${t('withItsDeps', members.length)}`) : '';
      say(`  ${kind}${factorLabel(f, { long: true })}${deps}${tags.length ? c.dim(`  ${tags.join(', ')}`) : ''}${note}`);
    }
    if (list.length > limit) say(c.dim(`  ${t('andMore', list.length - limit)}`));
  };
  show(testable, 15);
  if (info.length) {
    // Comparing with another machine: its PATH-like variables are noise, one line is enough.
    const otherMachine = info.filter((g) => g.factor.kind === 'env' && g.factor.reason === 'other-machine');
    const rest = info.filter((g) => !otherMachine.includes(g));
    say('');
    say(c.bold(t('untestable', info.reduce((n, g) => n + 1 + g.members.length, 0))));
    show(rest, 8);
    if (otherMachine.length) say(c.dim(`  ${pad(t('kind.env'), 13)}${t('otherMachineEnv', otherMachine.length)}`));
  }
}

/** The most useful lines of a failure: the error message, not the stack frames. */
function errorLines(text, root, count = 3) {
  const lines = lastLines(text, 200, root);
  const isFrame = (l) => /^\s+at\s/.test(l) || /^Node\.js v\d/.test(l.trim()) || /^\s*\^+\s*$/.test(l);
  const key = lines.filter(
    (l) => !isFrame(l) && /(\b\w*(Error|Exception)\b|\bERR_[A-Z_]+|\bFAIL\b|✗|×|AssertionError|[Ee]xpected|is not a function|Cannot find|not ok\b)/.test(l),
  );
  const picked = [...new Set(key)].slice(0, count);
  return picked.length ? picked : lines.filter((l) => !isFrame(l)).slice(-count);
}

function fixLines(f, manager) {
  const m = manager ?? 'npm';
  if (f.kind === 'package') {
    const explain = { npm: 'npm explain', pnpm: 'pnpm why', yarn: 'yarn why', bun: 'npm explain' }[m];
    if (f.change === 'added') {
      const remove = { npm: 'npm uninstall', pnpm: 'pnpm remove', yarn: 'yarn remove', bun: 'bun remove' }[m];
      return f.direct && !f.parent ? [`${remove} ${f.name}`] : [t('fixExplain', `${explain} ${f.name}`)];
    }
    if (f.direct && !f.parent) {
      const dev = f.direct === 'dev';
      const cmd = {
        npm: `npm install --save-exact ${dev ? '--save-dev ' : ''}`,
        pnpm: `pnpm add --save-exact ${dev ? '--save-dev ' : ''}`,
        yarn: `yarn add --exact ${dev ? '--dev ' : ''}`,
        bun: `bun add --exact ${dev ? '--dev ' : ''}`,
      }[m];
      return [`${cmd}${f.name}@${f.from}`];
    }
    const field = { npm: 'overrides', bun: 'overrides', pnpm: 'pnpm.overrides', yarn: 'resolutions' }[m];
    return [t('fixOverride', field, `"${f.name}": "${f.from}"`), t('fixExplain', `${explain} ${f.name}`)];
  }
  if (f.kind === 'node') {
    const v = f.from.replace(/^v/, '');
    const env = process.env;
    const use = env.VOLTA_HOME ? `volta pin node@${v}` : env.FNM_DIR || env.FNM_MULTISHELL_PATH ? `fnm use ${v}` : env.NVM_HOME || env.NVM_DIR ? `nvm use ${v}` : null;
    return [use ? t('fixNodeUse', use) : t('fixNodeInstall', v), t('fixNodePin', v)];
  }
  if (f.kind === 'env') {
    if (f.change === 'added') return [t('fixEnvUnset', f.name)];
    return [t('fixEnvSet', f.name, f.from)];
  }
  return [];
}

function configLabel(set, factors, coupling) {
  const n = factors.length;
  if (set.size === n) return t('cfgCurrent');
  if (set.size === 0) return t('cfgGreen');
  const kept = factors.filter((f) => set.has(f.id));
  const undone = factors.filter((f) => !set.has(f.id));
  // "only X" / "all except X", where X may drag its own dependencies along.
  const covers = (f, group, closure) => group.every((g) => g.id === f.id || closure.has(g.id));
  if (coupling) {
    const only = kept.find((f) => covers(f, kept, couple(new Set([f.id]), [], coupling)));
    if (only) return t('cfgOnly', factorLabel(only));
    const except = undone.find((f) => covers(f, undone, greenClosure([f.id], coupling)));
    if (except) return t('cfgAllBut', factorLabel(except, { short: true }));
  }
  if (kept.length === 1) return t('cfgOnly', factorLabel(kept[0]));
  if (undone.length === 1) return t('cfgAllBut', factorLabel(undone[0], { short: true }));
  return t('cfgSome', set.size, n);
}

/** Last meaningful lines of a run's output, with the project path shortened to "." */
function lastLines(text, count = 4, root = null) {
  let body = String(text ?? '');
  if (root) {
    for (const variant of new Set([root, root.replace(/\\/g, '/')])) body = body.split(variant).join('.');
  }
  return body
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^> /.test(l) && !/^npm (error|ERR!) (code|path|command|workspace|location|Lifecycle)/.test(l))
    .slice(-count);
}

export async function cmdWhy(opts, { dryRun = false } = {}) {
  const json = Boolean(opts.json);
  const say = createWriter(json ? process.stderr : process.stdout);
  configureFor(json ? process.stderr : process.stdout);
  const started = Date.now();
  const root = requireRoot();
  const store = new Store(root);
  recoverIfNeeded(root, store, say);
  const config = loadConfig(root);

  const green = opts.against ? loadSnapshotFile(opts.against) : store.latest('green');
  if (!green) throw new UserError(t('noGreen'));
  const current = await takeSnapshot(root, process.env, { ignoreEnv: config.ignoreEnv });
  const lastRed = store.latest('red');
  const output = lastRed && lastRed.at > green.at ? lastRed.output ?? '' : '';
  const diff = computeDiff(green, current, { output });
  if (diff.code?.headChanged) diff.code.commits = await countCommits(root, green.git?.head, current.git?.head);

  printDiff(say, diff, green);
  const summary = (extra) => ({
    version: VERSION,
    lastGreen: green.at,
    changes: diff.factors.map((f) => ({ kind: f.kind, name: f.name, change: f.change, from: f.from, to: f.to, testable: f.testable, reason: f.reason })),
    ...extra,
  });

  if (!diff.factors.length) {
    say('');
    say(c.green(t('noChanges')));
    if (json) process.stdout.write(`${JSON.stringify(summary({ status: 'no-changes' }), null, 2)}\n`);
    return;
  }
  if (dryRun) {
    say('');
    say(c.dim(t('dryRunHint')));
    if (json) process.stdout.write(`${JSON.stringify(summary({ status: 'diff' }), null, 2)}\n`);
    return;
  }

  const command = opts.command ?? green.command ?? config.command;
  if (!command) throw new UserError(t('noCommandWhy'));
  const cwd = !green.exported && green.cwd != null ? path.join(root, ...green.cwd.split('/').filter(Boolean)) : process.cwd();
  // Like `npm run`: local binaries (vitest, jest, tsc...) resolve without npx.
  const runEnv = { ...process.env };
  prependPath(runEnv, path.join(root, 'node_modules', '.bin'));
  if (cwd !== root) prependPath(runEnv, path.join(cwd, 'node_modules', '.bin'));
  const cache = cacheDir();
  const pnpmMode = green.layout === 'pnpm' && current.layout === 'pnpm';
  const ws = pnpmMode
    ? new PnpmWorkspace(root, store.journal)
    : new Workspace(root, store.journal, { rebuild: Boolean(opts.rebuild), nodePath: current.node?.path });

  // Prepare: old package versions and the old Node binary.
  const needs = [];
  if (pnpmMode) {
    // Every old copy pnpm already deleted, owned by the package factor of its name.
    const byName = new Map(diff.factors.filter((f) => f.pnpm && f.testable).map((f) => [f.name, f]));
    for (const [key, entry] of Object.entries(green.packages)) {
      const factor = key.startsWith('pnpm:') && !current.packages[key] ? byName.get(entry.name) : null;
      if (factor) needs.push({ id: `${factor.id}|${key}`, key: key.slice(5), entry: { name: entry.name, version: entry.version, integrity: entry.integrity, resolved: entry.resolved }, factor });
    }
  } else {
    for (const f of diff.factors.filter((x) => x.testable && x.kind === 'package')) {
      for (const p of f.paths) if (p.green) needs.push({ id: `${f.id}|${p.key}`, key: p.key, entry: p.green, factor: f });
    }
  }
  if (needs.length) {
    say('');
    say(c.dim(t('fetching', needs.length)));
    const got = await ensureTarballs(needs, { root, cacheDir: cache, nodePath: current.node?.path, offline: opts.offline });
    for (const need of needs) {
      const r = got.get(need.id);
      if (r?.file) ws.setTarball(need.key, r.file);
      else if (need.factor.testable) [need.factor.testable, need.factor.reason] = [false, `fetch:${r?.error ?? 'unknown'}`];
    }
  }
  if (pnpmMode) {
    // An old copy can only come back if everything it links to can come back too.
    const can = (dir, seen = new Set()) => {
      if (current.packages[`pnpm:${dir}`] || seen.has(dir)) return true;
      seen.add(dir);
      if (!ws.tarballs.has(dir)) return false;
      return Object.values(green.packages[`pnpm:${dir}`]?.links ?? {}).every((t2) => can(t2, seen));
    };
    for (const f of diff.factors.filter((x) => x.pnpm && x.testable)) {
      if (!f.pnpm.green.every((d) => can(d))) [f.testable, f.reason] = [false, 'fetch:npm-pack'];
    }
  }
  const nodeFactor = diff.factors.find((f) => f.kind === 'node' && f.testable);
  if (nodeFactor) {
    let dir = findNodeDir(nodeFactor.from, process.env, cache);
    if (!dir && !opts.offline) {
      say(c.dim(t('downloadingNode', nodeFactor.from)));
      try {
        dir = await downloadNode(nodeFactor.from, cache);
      } catch (err) {
        [nodeFactor.testable, nodeFactor.reason, nodeFactor.detail] = [false, 'node-download', err.message];
      }
    } else if (!dir) {
      [nodeFactor.testable, nodeFactor.reason] = [false, 'fetch:offline'];
    }
    if (dir) {
      const env = { ...process.env };
      prependPath(env, dir);
      const probe = await probeNode(env, cwd);
      if (probe?.version === nodeFactor.from) ws.nodeDir = dir;
      else [nodeFactor.testable, nodeFactor.reason] = [false, 'node-mismatch'];
    }
  }

  const testable = diff.factors.filter((f) => f.testable);
  const coupling = computeCoupling(green, current, diff.factors);
  // Say plainly what could not be put back (download, integrity, Node version...).
  const lost = diff.testable.filter((f) => !f.testable);
  if (lost.length) {
    say('');
    say(c.yellow(`${sym.warn} ${t('lostFactors', lost.length)}`));
    for (const f of lost.slice(0, 6)) say(c.yellow(`    ${factorLabel(f)}  (${reasonText(f)})`));
    if (lost.length > 6) say(c.yellow(`    ${t('andMore', lost.length - 6)}`));
  }
  if (!testable.length) {
    say('');
    say(c.yellow(t('nothingTestable')));
    printCodeHint(say, diff, green, command);
    if (json) process.stdout.write(`${JSON.stringify(summary({ status: 'nothing-testable' }), null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const timeoutMs = ((opts.timeout ?? config.timeout) || 0) * 1000 || Math.max(120_000, (green.durationMs ?? 0) * 5);
  say('');
  say(c.bold(t('bisecting', testable.length, command)));
  say(c.dim(t('safety')));

  let child = null;
  const restoreNow = () => {
    try {
      ws.restore();
    } catch {}
  };
  const onSignal = () => {
    if (child) killTree(child);
    restoreNow();
    process.stderr.write(`\n${t('interrupted')}\n`);
    process.exit(130);
  };
  // Ctrl+C, kill, closing the terminal, and Ctrl+Break on Windows.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
  for (const sig of signals) process.on(sig, onSignal);
  process.on('exit', restoreNow);

  const ids = testable.map((f) => f.id);
  const normalize = (set) => couple(set, ids, coupling);
  const keyOf = (set) => [...set].sort().join('|');
  const outputs = new Map();
  let runNo = 0;
  let result;
  try {
    ws.begin(testable, green, current);
    const firstGuess = testable[0].tags.includes('in-output') ? testable[0].id : null;
    result = await findCulprit(
      ids,
      async (set) => {
        await ws.apply(set);
        const env = ws.envFor(set, testable, runEnv);
        const r = await runCommand(command, { cwd, env, timeoutMs, onChild: (ch) => (child = ch) });
        const outcome = r.code === 0 ? 'pass' : 'fail';
        outputs.set(keyOf(set), r.tail);
        runNo++;
        const mark = outcome === 'pass' ? c.green(`${sym.ok} ${t('pass')}`) : c.red(`${sym.fail} ${t('fail')}`);
        const extra = r.timedOut ? c.yellow(` (${t('timedOut')})`) : '';
        say(`  ${c.dim(pad(`#${runNo}`, 4))} ${pad(mark, 12)} ${c.dim(pad(seconds(r.durationMs), 9))} ${configLabel(set, testable, coupling)}${extra}`);
        if (opts.showOutput) for (const line of lastLines(r.tail, 6, root)) say(c.dim(`        ${line}`));
        return outcome;
      },
      { maxRuns: opts.maxRuns ?? 60, firstGuess, normalize },
    );
  } finally {
    restoreNow();
    for (const sig of signals) process.off(sig, onSignal);
    process.off('exit', restoreNow);
  }
  const wrong = ws.verify(current);

  say('');
  const culprit = (result.culprit ?? []).map((id) => testable.find((f) => f.id === id));
  const fixes = [];
  const forward = [];
  let explained = [];
  if (result.status === 'found') {
    const head = result.confirmed ? c.green(`${sym.ok} ${t(culprit.length > 1 ? 'culpritsConfirmed' : 'culpritConfirmed')}`) : c.yellow(`${sym.warn} ${t('culpritProbable')}`);
    say(c.bold(head));
    for (const f of culprit) say(`    ${c.bold(factorLabel(f, { long: true }))}`);
    const nameOf = (id) => factorLabel(testable.find((f) => f.id === id), { short: true });
    const listNames = (list) => {
      const names = [...list].map(nameOf);
      return names.length > 4 ? `${names.slice(0, 4).join(', ')} ${t('andMore', names.length - 4)}` : names.join(', ');
    };
    const pulled = [...normalize(new Set(result.culprit))].filter((id) => !result.culprit.includes(id));
    const back = greenClosure(result.culprit, coupling);
    if (pulled.length) say(c.dim(`    ${t('pulls', pulled.length, listNames(pulled))}`));
    if (back.size) say(c.dim(`    ${t('bringsBack', back.size, listNames(back))}`));
    say(c.dim(`    ${result.confirmed ? t('confirmedHow', command) : t('notConfirmedHow')}`));
    const failing = outputs.get(keyOf(normalize(new Set(result.culprit)))) ?? outputs.get(keyOf(new Set(ids)));
    const lines = errorLines(failing, root);
    if (lines.length) {
      say('');
      say(c.dim(`    ${t('errorWas')}`));
      for (const line of lines) say(c.dim(`      ${line.slice(0, 160)}`));
    }
    const scripted = culprit.filter((f) => f.script);
    if (scripted.length && !opts.rebuild) say(c.yellow(`    ${sym.warn} ${t('scriptNote', scripted.map((f) => f.name).join(', '))}`));

    // What to change: where it breaks in the user's code and what changed upstream.
    explained = await explainCulprits(culprit, { root, current, output: failing, cacheDir: cache, offline: opts.offline, cwd });
    printExplain(say, explained, culprit);

    for (const f of culprit) fixes.push(...fixLines(f, current.manager));
    forward.push(...forwardLines(explained, culprit));
    if (fixes.length || forward.length) {
      say('');
      say(c.bold(t('fix')));
      if (fixes.length && forward.length) say(c.dim(`    ${t('fixBack')}`));
      for (const line of fixes) say(`    ${c.cyan(line)}`);
      if (forward.length) {
        say(c.dim(`    ${t('fixForwardLabel')}`));
        for (const line of forward) say(`    ${c.cyan(line)}`);
      }
    }
  } else if (result.status === 'not-reproduced') {
    say(c.yellow(`${sym.warn} ${t('notReproduced')}`));
  } else if (result.status === 'not-in-env') {
    say(c.yellow(`${sym.warn} ${t('notInEnv')}`));
    const where = failingLocations(outputs.get(keyOf(new Set(ids))), root, 2, cwd);
    if (where.length) {
      say(c.bold(`  ${t('whereBreaks')}`));
      for (const w of where) say(`    ${c.cyan(`${w.file}:${w.line}`)}  ${c.dim(w.code)}`);
    }
    const scripted = testable.filter((f) => f.kind === 'package' && f.script);
    if (scripted.length && !opts.rebuild) {
      say(c.yellow(`  ${t('notInEnvScripts', scripted.map((f) => f.name).join(', '))}`));
      say(c.cyan('    npx lastgreen why --rebuild'));
    }
    printCodeHint(say, diff, green, command);
  } else {
    say(c.yellow(`${sym.warn} ${t('budget', result.runs)}`));
  }

  say('');
  const restoredMsg = wrong.length ? c.red(`${sym.fail} ${t('restoreProblem', wrong.join(', '))}`) : c.green(t('restoredOk'));
  say(c.dim(`${t('runs', result.runs)} ${sym.dot} ${seconds(Date.now() - started)} ${sym.dot} `) + restoredMsg);

  writeStepSummary({ result, culprit, fixes, forward, explained, command, green, diff, wrong, started });
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        summary({
          status: result.status,
          confirmed: result.confirmed ?? false,
          culprit: culprit.map((f) => ({ kind: f.kind, name: f.name, change: f.change, from: f.from, to: f.to })),
          fix: fixes,
          fixForward: forward,
          explain: explained,
          runs: result.runs,
          durationMs: Date.now() - started,
          restored: wrong.length === 0,
        }),
        null,
        2,
      )}\n`,
    );
  }
  if (result.status !== 'found' || wrong.length) process.exitCode = 1;
}

/** In GitHub Actions, add a readable report to the job summary page. */
/** Human report of "what to change" under the culprit. */
function printExplain(say, explained, culprit) {
  if (!explained.length) return;
  const where = explained[0].where ?? [];
  if (where.length) {
    say('');
    say(c.bold(`  ${t('whereBreaks')}`));
    for (const w of where) say(`    ${c.cyan(`${w.file}:${w.line}`)}  ${c.dim(w.code)}`);
  }
  for (const e of explained) {
    const f = culprit.find((x) => x.id === e.id);
    if (e.imports?.length) {
      say('');
      say(c.bold(`  ${t('howYouUseIt', f.name)}`));
      for (const u of e.imports) say(`    ${c.cyan(`${u.file}:${u.line}`)}  ${c.dim(u.code)}`);
    }
    if (e.notes?.items?.length) {
      say('');
      say(c.bold(`  ${t('whatChanged', `${f.name} ${f.from} → ${f.to}`, t(`source.${e.notes.source}`))}`));
      for (const n of e.notes.items) say(`    ${c.dim(pad(n.version, 9))}${n.breaking ? c.yellow(`${sym.warn} `) : '  '}${n.text}`);
      if (e.notes.url) say(c.dim(`    ${sym.arrow} ${e.notes.url}`));
    } else if (e.notes?.url) {
      say('');
      say(c.dim(`  ${t('notesAt', f.name, e.notes.url)}`));
    }
    if (e.requiredBy?.length) {
      say(c.dim(`  ${t('requiredBy', f.name, e.requiredBy.map((r) => `${r.name}@${r.version} (${r.range})`).join(', '))}`));
    }
    if (e.node?.deprecations?.length) {
      say('');
      say(c.bold(`  ${t('whatChangedNode', f.from, f.to)}`));
      for (const d of e.node.deprecations) {
        say(`    ${c.yellow(d.id)} ${d.title}${d.type ? c.dim(` · ${d.type}`) : ''}`);
        say(`      ${d.text}`);
        say(c.dim(`      ${sym.arrow} ${d.url}`));
      }
    } else if (e.node?.changelogs?.length) {
      say('');
      say(c.dim(`  ${t('nodeChangelogs', f.from, f.to)}`));
      for (const url of e.node.changelogs.slice(-3)) say(c.dim(`    ${sym.arrow} ${url}`));
    }
    if (e.usages?.length) {
      say('');
      say(c.bold(`  ${t('whereEnvRead', f.name)}`));
      for (const u of e.usages) say(`    ${c.cyan(`${u.file}:${u.line}`)}  ${c.dim(u.code)}`);
    }
  }
}

/** The "move forward" fix: adapt the code to the new version instead of pinning the old one. */
function forwardLines(explained, culprit) {
  const out = [];
  for (const e of explained) {
    const f = culprit.find((x) => x.id === e.id);
    const loc = e.where?.[0] ? `${e.where[0].file}:${e.where[0].line}` : null;
    if (f.kind === 'package' && f.change === 'changed' && (loc || e.notes?.items?.length)) {
      out.push(loc ? t('fwdPackage', loc, f.name, f.to) : t('fwdPackageNoLoc', f.name, f.to));
    }
    if (f.kind === 'node') {
      for (const d of e.node?.deprecations ?? []) if (d.migration) out.push(d.migration);
      if (loc) out.push(t('fwdNode', loc, f.to));
    }
    if (f.kind === 'env' && f.change !== 'added' && e.usages?.length) out.push(t('fwdEnv', `${e.usages[0].file}:${e.usages[0].line}`, f.name));
  }
  return out;
}

function writeStepSummary({ result, culprit, fixes, forward = [], explained = [], command, green, diff, wrong, started }) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const code = (text) => '`' + String(text).replace(/`/g, "'") + '`';
  const md = ['### lastgreen', ''];
  if (result.status === 'found') {
    const title = culprit.length > 1 ? 'culpritsConfirmed' : result.confirmed ? 'culpritConfirmed' : 'culpritProbable';
    md.push(`${result.confirmed ? '✅' : '⚠️'} **${t(title)}** ${culprit.map((f) => code(factorLabel(f))).join(', ')}`);
    const where = explained[0]?.where ?? [];
    if (where.length) md.push('', `**${t('whereBreaks')}**`, '', ...where.map((w) => `- ${code(`${w.file}:${w.line}`)} ${code(w.code)}`));
    for (const e of explained) {
      const f = culprit.find((x) => x.id === e.id);
      if (e.notes?.items?.length) {
        md.push('', `**${t('whatChanged', `${f.name} ${f.from} → ${f.to}`, t(`source.${e.notes.source}`))}**`, '');
        for (const n of e.notes.items) md.push(`- ${n.breaking ? '⚠️ ' : ''}${n.version}: ${n.text}`);
        if (e.notes.url) md.push('', e.notes.url);
      }
      for (const d of e.node?.deprecations ?? []) md.push('', `**${d.id}** ${code(d.title)} (${d.type}): ${d.text} ${d.url}`);
    }
    if (fixes.length) md.push('', `**${t('fix')}:**`, '', '```', ...fixes, ...forward, '```');
  } else if (result.status === 'not-in-env') {
    md.push(`⚠️ ${t('notInEnv')}`);
  } else if (result.status === 'not-reproduced') {
    md.push(`⚠️ ${t('notReproduced')}`);
  } else {
    md.push(`⚠️ ${t('budget', result.runs)}`);
  }
  md.push('', `<details><summary>${t('changesSince', diff.factors.length)}</summary>`, '');
  for (const f of diff.factors.slice(0, 50)) {
    md.push(`- ${t(`kind.${f.kind}`)}: ${code(factorLabel(f, { long: true }))}${f.testable ? '' : ` (${reasonText(f)})`}`);
  }
  md.push('', '</details>', '');
  const tail = wrong.length ? ` · ${t('restoreProblem', wrong.join(', '))}` : '';
  md.push(`${t('lastGreen')}: ${green.at} · ${code(command)} · ${t('runs', result.runs)} · ${seconds(Date.now() - started)}${tail}`);
  try {
    fs.appendFileSync(file, `${md.join('\n')}\n`);
  } catch {}
}

function printCodeHint(say, diff, green, command) {
  const code = diff.code;
  if (!code) return;
  say('');
  const parts = [];
  if (code.headChanged) parts.push(t('codeCommits', code.commits ?? '?', code.from?.slice(0, 7)));
  if (code.fileCount) parts.push(t('codeFiles', code.fileCount));
  say(`  ${t('codeChanged')}: ${parts.join(' + ')}`);
  if (code.headChanged && code.from && !green.exported) {
    say(`  ${t('tryGitBisect')}`);
    say(c.cyan(`    git bisect start HEAD ${code.from.slice(0, 12)} && git bisect run ${command}`));
  }
}

// ---------------------------------------------------------------- export / log / restore

export async function cmdExport(opts) {
  const say = createWriter(process.stdout);
  const root = requireRoot();
  const store = new Store(root);
  const config = loadConfig(root);
  let snap = store.latest('green');
  if (!snap || opts.now) {
    if (!opts.now) say(c.yellow(t('exportNoGreen')));
    snap = await takeSnapshot(root, process.env, { ignoreEnv: config.ignoreEnv });
    snap.status = 'snap';
  }
  const file = path.resolve(opts.out ?? 'lastgreen-export.json');
  writeJson(file, redact(snap), { pretty: true });
  say(`${c.green(sym.ok)} ${t('exported', path.relative(process.cwd(), file) || file)}`);
  say(c.dim(`  ${t('exportHint')}`));
  say(c.cyan(`    npx lastgreen why --against ${path.basename(file)}`));
}

export function cmdLog(opts) {
  const say = createWriter(process.stdout);
  const root = requireRoot();
  const store = new Store(root);
  const all = store.all().slice(-(opts.n ?? 12));
  if (!all.length) {
    say(t('logEmpty'));
    return;
  }
  for (const s of all) {
    const mark = s.status === 'green' ? c.green(`${sym.ok} ${t('green')}`) : s.status === 'red' ? c.red(`${sym.fail} ${t('red')}`) : c.dim(`${sym.dot} snap`);
    const when = new Date(s.at).toLocaleString();
    say(`  ${pad(when, 24)} ${pad(mark, 10)} ${pad(s.command ?? '', 22)} ${c.dim(pad(seconds(s.durationMs), 9))} ${c.dim(`${countPackages(s)} pkgs ${sym.dot} Node ${s.node?.version ?? '?'}`)}`);
  }
}

export function cmdRestore() {
  const say = createWriter(process.stdout);
  const root = requireRoot();
  const store = new Store(root);
  if (!Workspace.pending(store.journal)) {
    say(t('nothingToRestore'));
    return;
  }
  recoverIfNeeded(root, store, say);
}

export { UserError };
