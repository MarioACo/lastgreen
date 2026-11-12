// "What to change": once the culprit is confirmed, explain it so it can be
// fixed for real instead of only pinned back.
//   - where it breaks in YOUR code (first stack frame outside node_modules)
//   - what changed: the package's CHANGELOG (shipped in node_modules) or its
//     GitHub release notes; for Node.js, the official deprecations doc
//     (DEP codes, replacement, automated migration if there is one)
//   - for env vars, where your code reads them
// Only public data is downloaded (release notes, Node docs); nothing about the
// project is sent. Every network failure is silent: this part is a bonus.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirp, readJson } from './fsx.js';
import { keyToPath } from './packages.js';
import { getJson as httpGetJson, getText as httpGetText } from './http.js';

const TIMEOUT = 8000;

// ------------------------------------------------------------------ versions

function parse(v) {
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3] < b[3] ? -1 : 1;
}

/** from < v <= to (either direction of change). */
function inRange(v, from, to) {
  const x = parse(v);
  const a = parse(from);
  const b = parse(to);
  if (!x || !a || !b) return false;
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
  return compare(x, lo) > 0 && compare(x, hi) <= 0;
}

// ------------------------------------------------------------------ where

/**
 * First frames of the failure that point into the project (not node_modules).
 * Understands Node stack traces (absolute paths and file:// URLs) and test
 * runners that print paths relative to the project (vitest "❯ src/a.js:8:5",
 * jest "at fn (src/a.js:8:5)").
 */
export function failingLocations(output, root, limit = 2, cwd = root) {
  const out = [];
  const seen = new Set();
  const patterns = [
    /\(((?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\/)[^()\n]+?):(\d+):(\d+)\)/g,
    /\bat ((?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\/)[^()\n]+?):(\d+):(\d+)\s*$/gm,
    /^((?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\/)[^\n:]*?):(\d+)\s*$/gm,
    /(?:❯|›|>|\bat\s+(?:[^(\n]*\()?|\()\s*((?:\.{1,2}[\\/])?[\w@][\w@.\\/-]*\.(?:[cm]?[jt]sx?|vue|svelte|astro)):(\d+):(\d+)/g,
  ];
  const hits = [];
  for (const re of patterns) for (const m of String(output ?? '').matchAll(re)) hits.push({ index: m.index, file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : null });
  hits.sort((a, b) => a.index - b.index);
  for (const h of hits) {
    let file = h.file;
    if (file.startsWith('file:')) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(cwd, file);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('node_modules')) continue;
    const key = `${rel}:${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let code;
    try {
      code = fs.readFileSync(abs, 'utf8').split(/\r?\n/)[h.line - 1];
    } catch {
      continue;
    }
    if (code == null) continue;
    out.push({ file: rel.split(path.sep).join('/'), line: h.line, column: h.column, code: code.trim().slice(0, 160) });
    if (out.length >= limit) break;
  }
  return out;
}

// ------------------------------------------------------------------ release notes

const BREAKING_RE = /\b(BREAKING|breaking change|removed?|drop(?:ped|s)?|no longer|pure ESM|ESM[- ]only|now requires?|require[sd]? Node|renamed?|replaced? by)\b/i;

export function cleanNote(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\s+\(#\d+\)/g, '')
    .replace(/\s+\b[0-9a-f]{7,40}\b\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

/** Bullet points of one release, flagged as breaking when they look like it. */
export function noteItems(body, version) {
  const items = [];
  let inBreaking = false;
  let inFence = false;
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || /^(---|\||<)/.test(line) || /^https?:\/\/\S+$/.test(line)) continue;
    const h = /^#{1,6}\s*(.+)$/.exec(line);
    if (h) {
      inBreaking = /break|major|incompatib/i.test(h[1]);
      continue;
    }
    const bullet = /^[-*+]\s+/.test(line);
    const nested = /^(\s{2,}|\t)/.test(raw);
    if (!bullet && !inBreaking) continue;
    const text = cleanNote(line.replace(/^[-*+]\s+/, ''));
    if (text.length < 4) continue;
    items.push({ version, text, breaking: inBreaking || BREAKING_RE.test(text), nested });
  }
  return items;
}

/** Sections of a CHANGELOG.md whose version is in the range. */
export function changelogItems(text, from, to) {
  const lines = String(text ?? '').split(/\r?\n/);
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const atx = /^#{1,4}\s.*?\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(line);
    const setext = !atx && /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(line) && /^[=-]{3,}\s*$/.test(lines[i + 1] ?? '')
      ? /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(line)
      : null;
    const m = atx ?? setext;
    if (m) {
      current = { version: m[1], body: [] };
      sections.push(current);
      if (setext) i++;
      continue;
    }
    current?.body.push(line);
  }
  return sections.filter((s) => inRange(s.version, from, to)).flatMap((s) => noteItems(s.body.join('\n'), s.version));
}

/** Words from the failure and the failing line, to rank the notes that talk about them first. */
export function clues(output, where = []) {
  // Only the error message itself and the user's own code lines: test-runner
  // summaries ("Test Files 1 failed") would add noise words.
  const errorLines = String(output ?? '')
    .split(/\r?\n/)
    .filter((l) => !/^\s+at\s/.test(l) && /\w*(Error|Exception)\b|is not a|Cannot |not defined|undefined|expected|ERR_/.test(l));
  const text = `${errorLines.join(' ')} ${where.map((w) => w.code).join(' ')}`;
  const words = new Set();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]{3,}/g)) words.add(m[0].toLowerCase());
  for (const common of ['error', 'typeerror', 'function', 'undefined', 'cannot', 'expected', 'const', 'with', 'from', 'this', 'that', 'test', 'tests', 'failed']) words.delete(common);
  return words;
}

/**
 * Pick the lines worth showing: breaking first, those mentioning what failed
 * first among them, top-level bullets, at most `max`.
 */
export function pickNotes(items, max = 6, words = new Set(), boost = () => 0) {
  const top = items.filter((i) => !i.nested);
  const pool = top.length ? top : items;
  const breaking = pool.filter((i) => i.breaking);
  const relevance = (i) => [...new Set(i.text.toLowerCase().match(/[a-z_$][\w$]{3,}/g) ?? [])].filter((w) => words.has(w)).length + boost(i.text);
  const chosen = (breaking.length ? breaking : pool)
    .map((i, index) => ({ i, index, score: relevance(i) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .map(({ i }) => i);
  return chosen.map(({ version, text, breaking: b }) => ({ version, text, breaking: b }));
}

export function githubRepo(pkg) {
  const r = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  if (!r) return null;
  const full = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/.exec(r);
  if (full) return { owner: full[1], repo: full[2] };
  const short = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(r);
  return short ? { owner: short[1], repo: short[2] } : null;
}

async function getJson(url, headers = {}) {
  return httpGetJson(url, { headers, timeoutMs: TIMEOUT });
}

function getText(url) {
  return httpGetText(url, { timeoutMs: TIMEOUT });
}

function cached(cacheDir, name, maxAgeMs) {
  const file = path.join(cacheDir, 'notes', name);
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < maxAgeMs) return fs.readFileSync(file, 'utf8');
  } catch {}
  return null;
}

function store(cacheDir, name, text) {
  try {
    mkdirp(path.join(cacheDir, 'notes'));
    fs.writeFileSync(path.join(cacheDir, 'notes', name), text);
  } catch {}
}

async function githubReleases({ owner, repo }, name, from, to, { cacheDir, env }) {
  const cacheName = `gh-${owner}-${repo}.json`.replace(/[^\w.-]/g, '_');
  let releases = null;
  const hit = cacheDir && cached(cacheDir, cacheName, 24 * 3600_000);
  if (hit) releases = JSON.parse(hit);
  if (!releases) {
    const token = env.LASTGREEN_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN;
    releases = await getJson(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`, {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    });
    releases = releases.map((r) => ({ tag: r.tag_name, body: r.body ?? '' }));
    if (cacheDir) store(cacheDir, cacheName, JSON.stringify(releases));
  }
  // Monorepos tag as "name@1.2.3": only keep this package's tags then.
  const scoped = releases.some((r) => /^[@\w][\w./-]*@\d/.test(r.tag));
  const items = [];
  for (const r of releases) {
    if (scoped && !r.tag.startsWith(`${name}@`)) continue;
    const version = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(r.tag)?.[1];
    if (version && inRange(version, from, to)) items.push(...noteItems(r.body, version));
  }
  return items;
}

/** Where the new version of a package factor lives on disk. */
function packageDir(factor, root, current) {
  if (factor.pnpm) {
    const rootLinks = current.pnpm?.importers?.['.'] ?? {};
    const dir = rootLinks[factor.name] ?? factor.pnpm.current[0];
    return dir ? path.join(root, 'node_modules', '.pnpm', dir, 'node_modules', ...factor.name.split('/')) : null;
  }
  return factor.key ? keyToPath(root, factor.key) : null;
}

export async function packageNotes(factor, { root, current, cacheDir, offline, env = process.env, words = new Set(), boost = () => 0 }) {
  if (factor.change !== 'changed' || !factor.from || !factor.to) return null;
  const dir = packageDir(factor, root, current);
  const pkg = dir ? readJson(path.join(dir, 'package.json')) : factor.yarn?.manifest ?? null;
  // 1. A changelog shipped inside the package.
  if (dir) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^(changelog|changes|history|releases?)(\.(md|markdown|txt))?$/i.test(f));
    } catch {}
    for (const f of files) {
      const items = changelogItems(fs.readFileSync(path.join(dir, f), 'utf8'), factor.from, factor.to);
      if (items.length) return { source: 'changelog', file: f, url: null, items: pickNotes(items, 6, words, boost) };
    }
  }
  // 2. GitHub release notes.
  const gh = githubRepo(pkg);
  if (gh && !offline) {
    try {
      const items = await githubReleases(gh, factor.name, factor.from, factor.to, { cacheDir, env });
      const url = `https://github.com/${gh.owner}/${gh.repo}/releases`;
      if (items.length) return { source: 'github', url, items: pickNotes(items, 6, words, boost) };
      return { source: 'github', url, items: [] };
    } catch {}
  }
  return gh ? { source: 'github', url: `https://github.com/${gh.owner}/${gh.repo}/releases`, items: [] } : null;
}

/**
 * What an experienced developer would read first, given how the code uses the
 * package and how it failed: CommonJS code + an "ESM only" release, or a
 * "not a function" error + a release that moved the default export.
 */
export function noteBoost(output, imports = []) {
  const usesRequire = imports.some((i) => /\brequire\s*\(/.test(i.code));
  const usesImport = imports.some((i) => /\bimport\b/.test(i.code));
  const err = String(output ?? '');
  const notCallable = /is not a (function|constructor)|is undefined|Cannot read propert|does not provide an export|has no exported member|Cannot find module|ERR_REQUIRE_ESM|ERR_PACKAGE_PATH_NOT_EXPORTED/.test(err);
  return (text) => {
    let score = 0;
    if (usesRequire && /pure ESM|ESM[- ]only|\bESM\b|ES ?modules?|CommonJS|\brequire\(|\.mjs\b/i.test(text)) score += 3;
    if (usesImport && /CommonJS|\bexports?\b|default export/i.test(text)) score += 1;
    if (notCallable && /default export|named exports?|export(ed)? (as|via)|no longer (exported|available)/i.test(text)) score += 2;
    else if (notCallable && /renamed|removed|moved/i.test(text)) score += 1;
    if (/ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module/.test(err) && /exports field|"exports"|subpath|deep imports?|flat structure/i.test(text)) score += 3;
    return score;
  };
}

/** Lines that import the package in the files where the failure happens (and the rest of the project). */
export function importSites(name, root, where = [], limit = 3) {
  const out = [];
  const re = new RegExp(`(['"\`])${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\1|/)`);
  const scan = (rel) => {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      if (out.length < limit && re.test(line) && !out.some((o) => o.file === rel && o.line === i + 1)) {
        out.push({ file: rel, line: i + 1, code: line.trim().slice(0, 160) });
      }
    });
  };
  for (const w of where) scan(w.file);
  return out;
}

/** Which installed packages ask for this one (so a transitive change has an owner). */
export function requiredBy(factor, current) {
  const out = [];
  for (const [key, entry] of Object.entries(current.packages ?? {})) {
    const range = entry.deps?.[factor.name];
    if (!range) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 13);
    out.push({ name, version: entry.version, range });
    if (out.length >= 3) break;
  }
  return out;
}

// ------------------------------------------------------------------ Node.js

/** Sections of Node's doc/api/deprecations.md. */
export function parseDeprecations(text) {
  const out = [];
  const parts = String(text ?? '').split(/^### (DEP\d{4}): (.+)$/m);
  for (let i = 1; i + 1 < parts.length; i += 3) {
    const id = parts[i];
    const title = (parts[i + 1] ?? '').replace(/`/g, '').trim();
    const body = parts[i + 2] ?? '';
    const type = /^Type: (.+)$/m.exec(body)?.[1]?.trim() ?? null;
    const afterType = body.split(/^Type: .+$/m)[1] ?? '';
    const paragraph = afterType.trim().split(/\n\s*\n/)[0] ?? '';
    const migration = /automated migration[\s\S]*?```(?:bash|sh)?\s*\n([^\n]+)\n/i.exec(afterType)?.[1]?.trim() ?? null;
    out.push({ id, title, type, text: cleanNote(paragraph.replace(/\n/g, ' ')).slice(0, 220), migration });
  }
  return out;
}

/** Things the failure says are missing: "util.isDate is not a function", DEP codes. */
export function missingSymbols(output) {
  const out = new Set();
  const text = String(output ?? '');
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+) is not a (?:function|constructor)/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b(DEP\d{4})\b/g)) out.add(m[1]);
  return [...out];
}

export async function nodeNotes(factor, output, { cacheDir, offline }) {
  const from = parse(factor.from);
  const to = parse(factor.to);
  if (!from || !to) return null;
  const [lo, hi] = compare(from, to) <= 0 ? [from[0], to[0]] : [to[0], from[0]];
  const majors = [];
  for (let m = lo + 1; m <= hi; m++) majors.push(m);
  const changelogs = majors.map((m) => `https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V${m}.md`);
  const symbols = missingSymbols(output);
  let deprecations = [];
  if (symbols.length && !offline) {
    const newer = compare(from, to) <= 0 ? factor.to : factor.from;
    const name = `node-deprecations-${newer}.md`;
    let doc = cacheDir ? cached(cacheDir, name, 30 * 24 * 3600_000) : null;
    if (!doc) {
      try {
        doc = await getText(`https://raw.githubusercontent.com/nodejs/node/${newer}/doc/api/deprecations.md`);
        if (cacheDir) store(cacheDir, name, doc);
      } catch {}
    }
    if (doc) {
      const all = parseDeprecations(doc);
      const norm = (s) => s.replace(/\(\)$/, '').replace(/^new /, '').trim();
      deprecations = all
        .filter((d) => symbols.some((s) => s === d.id || norm(d.title) === s || norm(d.title).endsWith(`.${s}`) || d.title.split(/[\s,]+/).map(norm).includes(s)))
        .slice(0, 3)
        .map((d) => ({ ...d, url: `https://nodejs.org/api/deprecations.html#${d.id}` }));
    }
  }
  return { majors, changelogs, deprecations };
}

// ------------------------------------------------------------------ env vars

const SOURCE_EXT = /\.(c|m)?(j|t)sx?$|\.(vue|svelte|astro)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.lastgreen', 'dist', 'build', 'coverage', '.next', '.nuxt', 'out', '.turbo', '.cache']);

/** Where the project's own code reads a variable. */
export function envUsages(name, root, limit = 4) {
  const out = [];
  const re = new RegExp(`\\b${name.replace(/[^\w]/g, '')}\\b`);
  let files = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit || files > 4000) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name));
      } else if (SOURCE_EXT.test(e.name)) {
        files++;
        let text = '';
        try {
          text = fs.readFileSync(path.join(dir, e.name), 'utf8');
        } catch {
          continue;
        }
        if (!re.test(text)) continue;
        text.split(/\r?\n/).forEach((line, i) => {
          if (out.length < limit && re.test(line)) {
            out.push({ file: path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'), line: i + 1, code: line.trim().slice(0, 160) });
          }
        });
      }
    }
  };
  walk(root);
  return out;
}

// ------------------------------------------------------------------ all together

/**
 * @returns {Promise<Array<{id: string, name: string, kind: string, where: object[], notes?: object, node?: object, usages?: object[], requiredBy?: object[]}>>}
 */
export async function explainCulprits(culprits, { root, current, output, cacheDir, offline, env = process.env, cwd = root }) {
  const where = failingLocations(output, root, 2, cwd);
  const words = clues(output, where);
  const out = [];
  for (const f of culprits) {
    const item = { id: f.id, name: f.name, kind: f.kind, where };
    if (f.kind === 'package') {
      item.imports = importSites(f.name, root, where);
      const pkgWords = new Set([...words, ...clues('', item.imports)]);
      // The package's own name is in every note; "require" alone mostly means "requires Node X".
      for (const part of f.name.toLowerCase().split(/[^a-z0-9_$]+/)) pkgWords.delete(part);
      pkgWords.delete('require');
      item.notes = await packageNotes(f, { root, current, cacheDir, offline, env, words: pkgWords, boost: noteBoost(output, item.imports) });
      if (!f.direct) item.requiredBy = requiredBy(f, current);
    } else if (f.kind === 'node') {
      item.node = await nodeNotes(f, output, { cacheDir, offline });
    } else if (f.kind === 'env') {
      item.usages = envUsages(f.name, root);
    }
    out.push(item);
  }
  return out;
}

