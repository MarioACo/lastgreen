// Turn two snapshots into a ranked list of "factors": every difference that
// could explain why the same command passed then and fails now. Factors are
// either testable (we can put the old state back and re-run) or info-only.
import { isBehavioural, isCritical } from './env.js';
import { nameFromKey } from './packages.js';
import { instancesByName } from './pnpm.js';
import { satisfies } from './semver.js';

const PKG_SEP = '/node_modules/';

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionLevel(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return 'other';
  if (a[0] !== b[0]) return 'major';
  if (a[0] === 0 && a[1] !== b[1]) return 'major';
  if (a[1] !== b[1]) return 'minor';
  if (a[2] !== b[2]) return 'patch';
  return 'prerelease';
}

const moduleRoot = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/** Package names that show up in a failure's output (stack traces, "Cannot find module"...). */
export function mentionedPackages(text) {
  const names = new Set();
  if (!text) return names;
  const norm = text.replace(/\\+/g, '/');
  for (const m of norm.matchAll(/node_modules\/((?:@[^/\s'"`)]+\/)?[^/\s'"`):]+)/g)) names.add(m[1]);
  for (const m of norm.matchAll(/Cannot find (?:module|package) ['"]([^'"]+)['"]/g)) names.add(moduleRoot(m[1]));
  for (const m of norm.matchAll(/\bfrom ['"]([^'"./][^'"]*)['"]/g)) names.add(moduleRoot(m[1]));
  for (const m of norm.matchAll(/\brequire\(['"]([^'"./][^'"]*)['"]\)/g)) names.add(moduleRoot(m[1]));
  return names;
}

function parentKey(key) {
  const i = key.lastIndexOf(PKG_SEP);
  return i === -1 ? null : key.slice(0, i);
}

function depth(key) {
  return key.split(PKG_SEP).length;
}

function platformBound(entry) {
  return Boolean(entry && (entry.os || entry.cpu));
}

const LEVEL_SCORE = { major: 40, minor: 15, patch: 5, prerelease: 5, other: 10 };

function scorePackage(factor, { level, change, direct, mentioned }) {
  if (level) {
    factor.score += LEVEL_SCORE[level];
    factor.tags.push(level);
  } else if (change === 'changed') {
    factor.score += 10;
    factor.tags.push('peers');
  } else {
    factor.score += 20;
    factor.tags.push(change);
  }
  if (direct) {
    factor.score += 15;
    factor.tags.push('direct');
  }
  if (mentioned.has(factor.name)) {
    factor.score += 100;
    factor.tags.push('in-output');
  }
  if (factor.script) factor.tags.push('install-script');
}

/** pnpm: one factor per package name, covering every installed copy of it. */
function pnpmFactors(green, current, { mentioned, crossPlatform }) {
  const gBy = instancesByName(green);
  const cBy = instancesByName(current);
  const gRoot = green.pnpm?.importers?.['.'] ?? {};
  const cRoot = current.pnpm?.importers?.['.'] ?? {};
  const factors = [];
  for (const name of [...new Set([...gBy.keys(), ...cBy.keys()])].sort()) {
    const g = [...(gBy.get(name) ?? [])].sort();
    const c = [...(cBy.get(name) ?? [])].sort();
    if (g.join('\n') === c.join('\n')) continue;
    const entriesG = g.map((d) => green.packages[`pnpm:${d}`]);
    const entriesC = c.map((d) => current.packages[`pnpm:${d}`]);
    const versions = (list) => [...new Set(list.map((e) => e.version))].sort().join(' | ');
    const change = g.length && c.length ? 'changed' : c.length ? 'added' : 'removed';
    const from = g.length ? green.packages[`pnpm:${gRoot[name]}`]?.version ?? versions(entriesG) : null;
    const to = c.length ? current.packages[`pnpm:${cRoot[name]}`]?.version ?? versions(entriesC) : null;
    const level = change === 'changed' && from !== to ? versionLevel(from, to) : null;
    const direct = current.packages[`pnpm:${cRoot[name]}`]?.direct ?? green.packages[`pnpm:${gRoot[name]}`]?.direct ?? null;
    const factor = {
      id: `pnpm:${name}`,
      kind: 'package',
      name,
      key: `pnpm:${name}`,
      parent: null,
      change,
      from,
      to,
      level,
      direct,
      script: [...entriesG, ...entriesC].some((e) => e?.script),
      paths: [],
      pnpm: { green: g, current: c },
      testable: true,
      reason: null,
      tags: [],
      score: 10,
    };
    if (crossPlatform && [...entriesG, ...entriesC].some(platformBound)) [factor.testable, factor.reason] = [false, 'platform'];
    scorePackage(factor, { level, change, direct, mentioned });
    factors.push(factor);
  }
  return factors;
}

function yarnGroups(snapshot) {
  const out = new Map();
  for (const [key, entry] of Object.entries(snapshot.packages ?? {})) {
    if (!key.startsWith('yarn:')) continue;
    if (!out.has(entry.name)) out.set(entry.name, []);
    out.get(entry.name).push({ key, entry });
  }
  return out;
}

/** Yarn PnP: one factor per package name, materialized through resolutions. */
function yarnFactors(green, current, { mentioned, crossPlatform }) {
  const gb = yarnGroups(green);
  const cb = yarnGroups(current);
  const factors = [];
  for (const name of [...new Set([...gb.keys(), ...cb.keys()])].sort()) {
    const g = gb.get(name) ?? [];
    const c = cb.get(name) ?? [];
    const signature = (items) => [...new Set(items.map(({ entry }) => `${entry.version}\0${entry.reference}`))].sort();
    const gs = signature(g);
    const cs = signature(c);
    if (gs.join('\n') === cs.join('\n')) continue;
    const versions = (items) => [...new Set(items.map(({ entry }) => entry.version))].sort();
    const gv = versions(g);
    const cv = versions(c);
    const change = g.length && c.length ? 'changed' : c.length ? 'added' : 'removed';
    const greenDirect = g.flatMap(({ entry }) => entry.directLocations ?? []);
    const currentDirect = c.flatMap(({ entry }) => entry.directLocations ?? []);
    const direct = c.find(({ entry }) => entry.direct)?.entry.direct ?? g.find(({ entry }) => entry.direct)?.entry.direct ?? null;
    const directRanges = [...new Set(greenDirect.map((loc) => loc.range))];
    const npmReferences = [...new Set(g.map(({ entry }) => entry.reference).filter((ref) => /^npm:/.test(ref)))];
    const resolution = npmReferences.length === 1 ? npmReferences[0] : directRanges.length === 1 ? directRanges[0] : null;
    const factor = {
      id: `yarn:${name}`,
      kind: 'package',
      name,
      key: null,
      parent: null,
      change,
      from: gv.join(' | ') || null,
      to: cv.join(' | ') || null,
      level: change === 'changed' && gv.length === 1 && cv.length === 1 ? versionLevel(gv[0], cv[0]) : null,
      direct,
      script: [...g, ...c].some(({ entry }) => entry.script),
      yarn: {
        green: g.map(({ key }) => key),
        current: c.map(({ key }) => key),
        greenDirect,
        currentDirect,
        resolution,
        manifest: c[0]?.entry ?? g[0]?.entry ?? null,
      },
      testable: true,
      reason: null,
      tags: [],
      score: 10,
    };
    if (crossPlatform && [...g, ...c].some(({ entry }) => platformBound(entry))) [factor.testable, factor.reason] = [false, 'platform'];
    else if (change === 'changed' && (gv.length !== 1 || cv.length !== 1)) [factor.testable, factor.reason] = [false, 'yarn-multiple'];
    else if (change === 'changed' && !resolution) [factor.testable, factor.reason] = [false, 'yarn-resolution'];
    else if (change === 'added' && !currentDirect.length) [factor.testable, factor.reason] = [false, 'yarn-transitive'];
    else if (change === 'removed' && !greenDirect.length) [factor.testable, factor.reason] = [false, 'yarn-transitive'];
    scorePackage(factor, { level: factor.level, change, direct, mentioned });
    factors.push(factor);
  }
  return factors;
}

function packageFactors(green, current, { mentioned, crossPlatform }) {
  if (green.layout === 'pnpm' && current.layout === 'pnpm') return pnpmFactors(green, current, { mentioned, crossPlatform });
  if (green.layout === 'pnp' && current.layout === 'pnp' && green.manager === 'yarn' && current.manager === 'yarn') {
    return yarnFactors(green, current, { mentioned, crossPlatform });
  }
  const gp = green.packages ?? {};
  const cp = current.packages ?? {};
  const pnpm = current.layout === 'pnpm' || green.layout === 'pnpm';
  const layoutChanged = green.layout !== current.layout && green.layout !== 'none' && current.layout !== 'none';
  const keys = [...new Set([...Object.keys(gp), ...Object.keys(cp)])].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const groups = new Map();
  const factors = [];
  for (const key of keys) {
    const g = gp[key];
    const c = cp[key];
    if (g && c && g.version === c.version && (g.name ?? null) === (c.name ?? null)) continue;
    const change = g && c ? 'changed' : c ? 'added' : 'removed';
    if (change !== 'changed') {
      // A package inside a folder that was itself added/removed moves with it.
      let parent = parentKey(key);
      while (parent) {
        const group = groups.get(parent);
        if (group && group.change === change) {
          group.paths.push({ key, green: g ?? null, current: c ?? null });
          groups.set(key, group);
          break;
        }
        parent = parentKey(parent);
      }
      if (parent) continue;
    }
    const entry = c ?? g;
    const name = entry.name ?? nameFromKey(key);
    const level = change === 'changed' ? versionLevel(g.version, c.version) : null;
    const direct = (c ?? g).direct ?? null;
    const factor = {
      id: `pkg:${key}`,
      kind: 'package',
      name,
      key,
      parent: !pnpm && parentKey(key) ? nameFromKey(parentKey(key)) : null,
      change,
      from: g?.version ?? null,
      to: c?.version ?? null,
      level,
      direct,
      script: Boolean(g?.script || c?.script),
      paths: [{ key, green: g ?? null, current: c ?? null }],
      testable: true,
      reason: null,
      tags: [],
      score: 10,
    };
    if (layoutChanged || pnpm) [factor.testable, factor.reason] = [false, 'layout'];
    else if (crossPlatform && (platformBound(g) || platformBound(c))) [factor.testable, factor.reason] = [false, 'platform'];
    if (level) {
      factor.score += LEVEL_SCORE[level];
      factor.tags.push(level);
    } else {
      factor.score += 20;
      factor.tags.push(change);
    }
    if (direct) {
      factor.score += 15;
      factor.tags.push('direct');
    }
    if (mentioned.has(name)) {
      factor.score += 100;
      factor.tags.push('in-output');
    }
    if (factor.script) factor.tags.push('install-script');
    groups.set(key, factor);
    factors.push(factor);
  }
  return factors;
}

function envFactors(green, current, { sameMachine }) {
  const ge = green.env ?? {};
  const ce = current.env ?? {};
  const out = [];
  for (const name of [...new Set([...Object.keys(ge), ...Object.keys(ce)])].sort()) {
    const g = ge[name];
    const c = ce[name];
    if (g && c && g.h === c.h) continue;
    const change = g && c ? 'changed' : c ? 'added' : 'removed';
    const behavioural = isBehavioural(name);
    const factor = {
      id: `env:${name}`,
      kind: 'env',
      name,
      change,
      from: g?.v ?? null,
      to: c?.v ?? null,
      testable: true,
      reason: null,
      tags: [change],
      score: name === 'NODE_OPTIONS' ? 45 : behavioural ? 30 : 10,
    };
    if (isCritical(name)) [factor.testable, factor.reason] = [false, 'critical'];
    else if (!sameMachine && !behavioural) [factor.testable, factor.reason] = [false, 'other-machine'];
    else if (change !== 'added' && g.v === undefined) [factor.testable, factor.reason] = [false, 'value-not-stored'];
    if (behavioural) factor.tags.push('behavioural');
    out.push(factor);
  }
  return out;
}

function mapDiff(kind, gm = {}, cm = {}, score) {
  const out = [];
  for (const name of [...new Set([...Object.keys(gm), ...Object.keys(cm)])].sort()) {
    if (gm[name] === cm[name]) continue;
    const change = gm[name] && cm[name] ? 'changed' : cm[name] ? 'added' : 'removed';
    const isEnvFile = name === '.env' || name.startsWith('.env.');
    out.push({
      id: `${kind}:${name}`,
      kind,
      name,
      change,
      from: kind === 'tool' ? gm[name] ?? null : null,
      to: kind === 'tool' ? cm[name] ?? null : null,
      testable: false,
      reason: kind === 'tool' ? 'tool' : 'content-not-stored',
      tags: [change],
      score: isEnvFile ? score + 6 : score,
    });
  }
  return out;
}

function codeFactor(green, current) {
  const g = green.git;
  const c = current.git;
  if (!g || !c) return null;
  const headChanged = g.head !== c.head;
  const gd = JSON.stringify(Object.entries(g.dirty ?? {}).sort());
  const cd = JSON.stringify(Object.entries(c.dirty ?? {}).sort());
  if (!headChanged && gd === cd) return null;
  const changedFiles = new Set();
  for (const [f, h] of Object.entries(c.dirty ?? {})) if ((g.dirty ?? {})[f] !== h) changedFiles.add(f);
  for (const f of Object.keys(g.dirty ?? {})) if (!(f in (c.dirty ?? {}))) changedFiles.add(f);
  return {
    id: 'code',
    kind: 'code',
    name: 'git',
    change: 'changed',
    from: g.head,
    to: c.head,
    headChanged,
    files: [...changedFiles].slice(0, 20),
    fileCount: changedFiles.size,
    testable: false,
    reason: 'code',
    tags: [],
    score: 50,
  };
}

/**
 * @param {object} green snapshot of the last passing run (or a teammate's export)
 * @param {object} current snapshot of now
 * @param {{output?: string}} options failure output used to rank suspects
 */
export function computeDiff(green, current, { output = '' } = {}) {
  const sameMachine = green.system?.machine === current.system?.machine;
  const crossPlatform = green.system?.platform !== current.system?.platform || green.system?.arch !== current.system?.arch;
  const mentioned = mentionedPackages(output);
  const factors = [];

  if (green.node?.version && current.node?.version && green.node.version !== current.node.version) {
    const level = versionLevel(green.node.version, current.node.version);
    factors.push({
      id: 'node',
      kind: 'node',
      name: 'node',
      change: 'changed',
      from: green.node.version,
      to: current.node.version,
      level,
      testable: true,
      reason: null,
      tags: [level],
      score: 30 + LEVEL_SCORE[level],
    });
  }
  factors.push(...packageFactors(green, current, { mentioned, crossPlatform }));
  factors.push(...envFactors(green, current, { sameMachine }));
  factors.push(...mapDiff('tool', green.tools, current.tools, 6));
  factors.push(...mapDiff('file', green.files, current.files, 4));
  factors.push(...mapDiff('file', green.home, current.home, 3));
  if (green.system?.release !== current.system?.release || crossPlatform) {
    factors.push({
      id: 'system',
      kind: 'system',
      name: 'os',
      change: 'changed',
      from: `${green.system?.platform} ${green.system?.release}`,
      to: `${current.system?.platform} ${current.system?.release}`,
      testable: false,
      reason: 'system',
      tags: [],
      score: 3,
    });
  }
  const code = codeFactor(green, current);
  if (code) factors.push(code);

  factors.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    factors,
    testable: factors.filter((f) => f.testable),
    info: factors.filter((f) => !f.testable),
    sameMachine,
    crossPlatform,
    code,
    coupling: computeCoupling(green, current, factors),
  };
}

/** Where Node would find `name` when required from the package at `fromKey`. */
export function resolveDep(tree, fromKey, name) {
  let base = fromKey;
  for (;;) {
    const key = `${base}/node_modules/${name}`;
    if (tree[key]) return key;
    const i = base.lastIndexOf(PKG_SEP);
    if (i === -1) break;
    base = base.slice(0, i);
  }
  return tree[`node_modules/${name}`] ? `node_modules/${name}` : null;
}

/**
 * Package changes are not independent: chalk@4 needs the ansi-styles that the
 * upgrade to chalk@5 removed. For every package factor, record which other
 * factors must be in their old state when it is old (greenNeeds) and in their
 * new state when it is new (currentNeeds), using the real dependency ranges.
 */
export function computeCoupling(green, current, factors) {
  const byKey = new Map();
  for (const f of factors) if (f.kind === 'package' && f.paths) for (const p of f.paths) byKey.set(p.key, f);
  const greenNeeds = new Map();
  const currentNeeds = new Map();
  const add = (map, from, to) => {
    if (!map.has(from)) map.set(from, new Set());
    map.get(from).add(to);
  };
  // pnpm: links say exactly which copy of each dependency a package uses.
  const pnpmByName = new Map(factors.filter((f) => f.pnpm && f.testable).map((f) => [f.name, f]));
  for (const f of pnpmByName.values()) {
    for (const d of f.pnpm.green) {
      for (const t of Object.values(green.packages?.[`pnpm:${d}`]?.links ?? {})) {
        const target = pnpmByName.get(green.packages?.[`pnpm:${t}`]?.name);
        if (target && target !== f && !current.packages?.[`pnpm:${t}`]) add(greenNeeds, f.id, target.id);
      }
    }
    for (const d of f.pnpm.current) {
      for (const t of Object.values(current.packages?.[`pnpm:${d}`]?.links ?? {})) {
        const target = pnpmByName.get(current.packages?.[`pnpm:${t}`]?.name);
        if (target && target !== f && !green.packages?.[`pnpm:${t}`]) add(currentNeeds, f.id, target.id);
      }
    }
  }
  for (const f of factors) {
    if (f.kind !== 'package' || !f.paths || !f.testable) continue;
    for (const p of f.paths) {
      for (const [name, range] of Object.entries(p.green?.deps ?? {})) {
        const key = resolveDep(green.packages ?? {}, p.key, name);
        const target = key && byKey.get(key);
        if (!target || target === f || !target.testable) continue;
        const now = current.packages?.[key];
        if (!now || !satisfies(now.version, range)) add(greenNeeds, f.id, target.id);
      }
      for (const [name, range] of Object.entries(p.current?.deps ?? {})) {
        const key = resolveDep(current.packages ?? {}, p.key, name);
        const target = key && byKey.get(key);
        if (!target || target === f || !target.testable) continue;
        const before = green.packages?.[key];
        if (!before || !satisfies(before.version, range)) add(currentNeeds, f.id, target.id);
      }
    }
  }
  return { greenNeeds, currentNeeds };
}

/**
 * Make a requested configuration consistent. Factors kept new pull in what
 * they need new; then factors put back pull in what they need old (old wins:
 * the old environment is the one known to work, and this always terminates).
 * @param {Set<string>} requested factors to keep in their current state
 * @param {string[]} ids all testable factor ids
 */
export function couple(requested, ids, { greenNeeds, currentNeeds }) {
  const cur = new Set(requested);
  const queue = [...cur];
  while (queue.length) {
    for (const need of currentNeeds.get(queue.shift()) ?? []) {
      if (!cur.has(need)) {
        cur.add(need);
        queue.push(need);
      }
    }
  }
  const back = ids.filter((id) => !cur.has(id));
  while (back.length) {
    for (const need of greenNeeds.get(back.shift()) ?? []) {
      if (cur.has(need)) {
        cur.delete(need);
        back.push(need);
      }
    }
  }
  return cur;
}

/** Everything that goes back together with `ids` when they are put back. */
export function greenClosure(ids, { greenNeeds }) {
  const out = new Set();
  const queue = [...ids];
  while (queue.length) {
    for (const need of greenNeeds.get(queue.shift()) ?? []) {
      if (!out.has(need) && !ids.includes(need)) {
        out.add(need);
        queue.push(need);
      }
    }
  }
  return out;
}
