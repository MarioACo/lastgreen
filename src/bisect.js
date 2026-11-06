// Delta debugging (Zeller & Hildebrandt, "Simplifying and Isolating
// Failure-Inducing Input", 2002) applied to environment changes.
//
// A configuration is the set of factors left in their *current* state; every
// other factor is put back as it was in the last green run.
//   test(all)  -> must fail (the bug reproduces)
//   test(none) -> must pass (the old environment fixes it)
//   ddmin      -> smallest set of current changes that still fails
//   confirm    -> reverting only that set makes it pass

/**
 * @param {string[]} ids testable factor ids, most suspicious first
 * @param {(current: Set<string>) => Promise<'pass'|'fail'>} test
 * @param {{maxRuns?: number, firstGuess?: string|null, normalize?: (s: Set<string>) => Set<string>}} options
 *   normalize turns a requested configuration into a consistent one (dependency coupling)
 */
export async function findCulprit(ids, test, { maxRuns = 60, firstGuess = null, normalize = null } = {}) {
  const cache = new Map();
  let runs = 0;
  const keyOf = (set) => [...set].sort().join('\n');

  class Budget extends Error {}
  const t = async (subset) => {
    const set = normalize ? normalize(new Set(subset)) : new Set(subset);
    const key = keyOf(set);
    if (cache.has(key)) return cache.get(key);
    if (runs >= maxRuns) throw new Budget();
    runs++;
    const result = await test(set);
    cache.set(key, result);
    return result;
  };

  try {
    if ((await t(ids)) === 'pass') return { status: 'not-reproduced', runs };
    if ((await t([])) === 'fail') return { status: 'not-in-env', runs };

    let c = ids;
    // Cheap first guess: a single, strongly suspected factor (named in the error output).
    if (firstGuess && ids.includes(firstGuess) && ids.length > 2 && (await t([firstGuess])) === 'fail') c = [firstGuess];

    let n = 2;
    while (c.length >= 2) {
      const size = Math.ceil(c.length / n);
      const chunks = [];
      for (let i = 0; i < c.length; i += size) chunks.push(c.slice(i, i + size));
      let reduced = false;
      for (const chunk of chunks) {
        if ((await t(chunk)) === 'fail') {
          c = chunk;
          n = 2;
          reduced = true;
          break;
        }
      }
      if (!reduced && chunks.length > 2) {
        for (const chunk of chunks) {
          const complement = c.filter((id) => !chunk.includes(id));
          if ((await t(complement)) === 'fail') {
            c = complement;
            n = Math.max(n - 1, 2);
            reduced = true;
            break;
          }
        }
      }
      if (!reduced) {
        if (n >= c.length) break;
        n = Math.min(c.length, n * 2);
      }
    }

    // Confirm from the other side: current environment minus the culprit must pass.
    const rest = ids.filter((id) => !c.includes(id));
    const confirmed = (await t(rest)) === 'pass';
    return { status: 'found', culprit: c, confirmed, runs };
  } catch (err) {
    if (err instanceof Budget) return { status: 'budget', runs };
    throw err;
  }
}
