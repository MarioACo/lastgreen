// Minimal semver range matching (npm flavour) for deciding whether a package
// version still satisfies what its dependent asked for. Supports exact, x-ranges,
// ^, ~, comparators, hyphen ranges and ||. Anything it cannot read counts as
// "not satisfied", which only makes lastgreen restore more, never less.

function parseVersion(v) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []] : null;
}

function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]);
    const nb = /^\d+$/.test(b[i]);
    if (na && nb && Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return comparePre(a[3], b[3]);
}

/** "1", "1.2", "1.x", "*" -> [major|null, minor|null, patch|null, pre] */
function parsePartial(text) {
  const m = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!m) return null;
  const num = (s) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));
  return [num(m[1]), num(m[2]), num(m[3]), m[4] ? m[4].split('.') : []];
}

const lowerOf = (p) => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3]];

/** Comparator list ([op, version]) for one space-separated set. */
function desugar(set) {
  const out = [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
  if (hyphen) {
    const a = parsePartial(hyphen[1]);
    const b = parsePartial(hyphen[2]);
    if (!a || !b) return null;
    out.push(['>=', lowerOf(a)]);
    if (b[0] === null) return out;
    if (b[1] === null) out.push(['<', [b[0] + 1, 0, 0, ['0']]]);
    else if (b[2] === null) out.push(['<', [b[0], b[1] + 1, 0, ['0']]]);
    else out.push(['<=', b]);
    return out;
  }
  for (const token of set.split(/\s+/).filter(Boolean)) {
    const m = /^(<=|>=|<|>|=|\^|~>?)?\s*(.+)$/.exec(token);
    const op = m[1] ?? '';
    const p = parsePartial(m[2]);
    if (!p) return null;
    const [M, m2, pt] = p;
    if (M === null) {
      if (op === '<' || op === '>') out.push(['<', [0, 0, 0, ['0']]]);
      continue; // "*" or ">=*" matches everything
    }
    if (op === '^') {
      out.push(['>=', lowerOf(p)]);
      if (M > 0 || m2 === null) out.push(['<', [M + 1, 0, 0, ['0']]]);
      else if (m2 > 0 || pt === null) out.push(['<', [0, m2 + 1, 0, ['0']]]);
      else out.push(['<', [0, 0, pt + 1, ['0']]]);
    } else if (op === '~' || op === '~>') {
      out.push(['>=', lowerOf(p)]);
      out.push(['<', m2 === null ? [M + 1, 0, 0, ['0']] : [M, m2 + 1, 0, ['0']]]);
    } else if (op === '' || op === '=') {
      if (m2 === null) out.push(['>=', [M, 0, 0, []]], ['<', [M + 1, 0, 0, ['0']]]);
      else if (pt === null) out.push(['>=', [M, m2, 0, []]], ['<', [M, m2 + 1, 0, ['0']]]);
      else out.push(['=', p]);
    } else if (op === '>') {
      if (m2 === null) out.push(['>=', [M + 1, 0, 0, []]]);
      else if (pt === null) out.push(['>=', [M, m2 + 1, 0, []]]);
      else out.push(['>', p]);
    } else if (op === '<=') {
      if (m2 === null) out.push(['<', [M + 1, 0, 0, ['0']]]);
      else if (pt === null) out.push(['<', [M, m2 + 1, 0, ['0']]]);
      else out.push(['<=', p]);
    } else {
      out.push([op, lowerOf(p)]);
    }
  }
  return out;
}

function test(v, [op, w]) {
  const c = compare(v, w);
  if (op === '=') return c === 0;
  if (op === '>') return c > 0;
  if (op === '>=') return c >= 0;
  if (op === '<') return c < 0;
  if (op === '<=') return c <= 0;
  return false;
}

export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  let r = String(range ?? '').trim();
  if (r.startsWith('npm:')) r = r.slice(r.lastIndexOf('@') + 1);
  if (r === '' || r === '*' || r === 'latest' || /^[xX]$/.test(r)) return v[3].length === 0;
  if (/^[a-z+]+:/i.test(r) || r.includes('/')) return false;
  return r.split('||').some((set) => {
    const comparators = desugar(set.trim().replace(/(<=|>=|<|>|=|\^|~>?)\s+/g, '$1'));
    if (!comparators) return false;
    if (!comparators.every((cmp) => test(v, cmp))) return false;
    // Pre-releases only match comparators that mention the same [major, minor, patch].
    if (v[3].length) {
      return comparators.some(([, w]) => w[3].length && w[3][0] !== '0' && w[0] === v[0] && w[1] === v[1] && w[2] === v[2]);
    }
    return true;
  });
}
