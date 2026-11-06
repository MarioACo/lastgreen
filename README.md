# lastgreen

**`git bisect` for your environment.**

Your tests passed yesterday. Today they fail, and you didn't touch the code.
Somebody ran `npm update`, an AI agent installed something, Node got upgraded,
an env var appeared... `lastgreen` remembers the environment of every passing
run, and when the same code starts failing it puts the old pieces back one by
one until it finds — and **confirms** — the change that broke it.

> [Leer en español](README.es.md)

```text
$ npx lastgreen why
Last green  2 h ago · npm test · 436 ms

13 changes since then
  package      chalk 4.1.2 → 5.3.0 (+5 of its dependencies)  major, direct dependency
  package      debug 4.3.4 → 4.4.0  minor, direct dependency
  package      semver 7.5.4 → 7.6.3 (+2 of its dependencies)  minor, direct dependency
  package      ms 2.1.2 → 2.1.3  patch, direct dependency

Finding the culprit among 11 changes with `npm test`
  #1   ✗ fail       447 ms    current environment
  #2   ✓ pass       434 ms    last green environment
  #3   ✗ fail       450 ms    7 of 11 changes
  #4   ✗ fail       435 ms    4 of 11 changes
  #5   ✗ fail       459 ms    3 of 11 changes
  #6   ✗ fail       430 ms    only: chalk 4.1.2 → 5.3.0
  #7   ✓ pass       447 ms    all except: chalk

✓ Culprit confirmed:
    chalk 4.1.2 → 5.3.0
    undoing it also puts back 5 dependencies the old version needs: ansi-styles, supports-color, color-convert, has-flag and 1 more
    undoing only this makes `npm test` pass; keeping only this makes it fail

    Failure with this change:
      TypeError: chalk.green is not a function

Fix
    npm install --save-exact chalk@4.1.2

7 runs · 3.6 s · node_modules restored and verified
```

That is real output from a real `npm install` of real registry packages.

## Quick start

```bash
# 1. Once, while your tests pass (or always: see below)
npx lastgreen run -- npm test

# 2. The day they break
npx lastgreen why
```

To record every green run automatically, wrap your test script:

```json
{
  "scripts": { "test": "lastgreen run -- vitest run" },
  "devDependencies": { "lastgreen": "^0.1.0" }
}
```

`lastgreen run` passes your command's output and exit code through untouched,
and adds one line at the end.

## What it answers

| You say | Command |
| --- | --- |
| "It worked yesterday." | `lastgreen why` |
| "What changed since it last passed?" (runs nothing) | `lastgreen diff` |
| "It works on my machine." | they run `lastgreen export`, you run `lastgreen why --against lastgreen-export.json` |
| CI / AI agents | `lastgreen why --json` |

## How it works

1. **Fingerprint on every run.** `lastgreen run` records what is *really*
   installed in `node_modules` (from npm's hidden lockfile, cross-checked against
   disk), the Node version your command actually gets, the package manager,
   behavioural env vars, config files and the git state. It runs in parallel
   with your command and takes about 60–180 ms (a 200-package project gives a
   ~45 KB snapshot).
2. **Diff.** When it fails, `why` compares now against the last green run and
   ranks suspects: major bumps, direct dependencies and packages named in the
   error output go first.
3. **Delta debugging.** It re-runs your command with subsets of the old
   environment put back (Zeller & Hildebrandt's *ddmin* algorithm), so a single
   culprit among hundreds of changes takes a handful of runs. If it is in the
   error message, it usually takes 4.
4. **Dependency-aware.** Putting `chalk@4` back also puts back the
   `ansi-styles` it needs; keeping `debug@4.4` new keeps the `ms` it requires.
   Ranges are checked with semver, so every tested configuration is coherent.
5. **Confirmed in both directions.** Undoing only the culprit must make it pass,
   and keeping only the culprit must make it fail. Otherwise it says so.

## Safety

- `node_modules` is modified **temporarily** and restored at the end. Every
  step is written to `.lastgreen/journal.json` *before* it happens: Ctrl+C,
  a crash or a power cut is repaired by the next `lastgreen` command (or
  `lastgreen restore`), and the result is verified against disk.
- Old package versions are fetched as tarballs and checked against the
  **integrity hash recorded when they were installed**. Install scripts are never run.
- Old Node versions come from your version manager (nvm, nvm-windows, fnm,
  volta, mise, asdf, n) or from nodejs.org, **verified against the official
  SHA-256 sums**.
- Your source code is never touched.

## Privacy

Snapshots stay in `.lastgreen/` (git-ignored automatically). Environment
variables are stored as a short SHA-256 hash; clear values are kept only for a
short allowlist of non-secret behavioural variables (`NODE_OPTIONS`, `NODE_ENV`,
`TZ`, `LANG`, `CI`...) and never for anything whose name looks like a secret.
`.env` files are hashed, never copied. `lastgreen export` also strips local
paths and test output. Nothing is sent anywhere.

## Options

```text
lastgreen run -- <command>         run and record a snapshot (green or red)
lastgreen why                      find and confirm the culprit
lastgreen diff                     list changes since the last green, run nothing
lastgreen export [-o file]         share your last green environment
lastgreen log                      list saved snapshots
lastgreen restore                  repair node_modules after an interrupted bisect

  -c, --command <cmd>   command to re-run (default: the one from the last green)
  --against <file>      compare with an exported snapshot
  --max-runs <n>        give up after n runs (default 60)
  --timeout <seconds>   per run (default: 5x the green run, at least 120)
  --offline             never download packages or Node versions
  --rebuild             run install scripts (native addons) of restored packages
  --show-output         print the end of each run's output
  --json                machine-readable result on stdout
  --lang en|es          language (also LASTGREEN_LANG)
```

Project config (optional) in `.lastgreenrc.json` or a `"lastgreen"` key in
`package.json`: `{ "command": "npm test", "ignoreEnv": ["MY_NOISY_*"], "timeout": 300 }`.

## Support and limits (v0.1)

- **Bisects:** npm `node_modules` (and any hoisted layout: yarn classic, bun),
  Node.js version, environment variables. Windows, macOS and Linux, Node 20+.
- **Diff only (for now):** pnpm, Yarn PnP, package-manager versions, OS
  updates, `.env` and config file contents, source code (it prints the
  `git bisect` command to use instead).
- Packages with install scripts (native addons) are swapped without rebuilding
  unless you pass `--rebuild`, which runs `npm rebuild` for the restored ones.
  `why` tells you when that matters.
- It needs a test command that reliably passes or fails. Flaky tests show up as
  "not confirmed".
- Causes outside the machine (a remote API, the date) cannot be put back. In
  that case `why` tells you that the environment is *not* the cause, which is
  also an answer.

## In CI

In GitHub Actions, `why` also writes its report to the job summary page.
For "red in CI, green on my laptop", save the green fingerprint of `main`:

```yaml
- run: npx lastgreen run -- npm test
- if: success() && github.ref == 'refs/heads/main'
  run: npx lastgreen export -o lastgreen-main.json
- if: success() && github.ref == 'refs/heads/main'
  uses: actions/upload-artifact@v4
  with: { name: lastgreen-main, path: lastgreen-main.json }
```

Then, on any machine: `npx lastgreen why --against lastgreen-main.json`.

## Roadmap

- pnpm bisect, then Python (uv / pip)
- Hooks and an MCP server for AI coding agents: "what did the agent change
  on my machine?", plus `why` as a tool
- **lastgreen for teams** (hosted, paid for private repos of organizations):
  the green baseline of `main` kept for you, a PR comment with the confirmed
  culprit when CI breaks without code changes, and a view of whose machine
  drifted from CI. If your team wants it, [tell us here](https://github.com/MarioACo/lastgreen/issues/new?template=team-interest.yml).

## License

[MIT](LICENSE). The CLI is and stays free and open source.
