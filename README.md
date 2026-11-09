<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img alt="lastgreen" src="assets/logo-light.svg" width="380">
</picture>

### `git bisect` for your environment

Your tests passed yesterday. Today they fail and nobody touched the code.<br>
lastgreen finds the dependency, Node version or env var that broke them, **proves it**,<br>
and shows the line to change.

[![CI](https://github.com/MarioACo/lastgreen/actions/workflows/ci.yml/badge.svg)](https://github.com/MarioACo/lastgreen/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/lastgreen?color=2da44e&label=npm)](https://www.npmjs.com/package/lastgreen)
[![node](https://img.shields.io/badge/node-%E2%89%A516-2da44e)](#support)
[![dependencies](https://img.shields.io/badge/dependencies-0-2da44e)](package.json)
[![license](https://img.shields.io/badge/license-MIT-2da44e)](LICENSE)

[Quick start](#quick-start) · [How it works](#how-it-works) · [CI](#in-ci) · [AI agents](#ai-agents-mcp) · [Teams](#lastgreen-for-teams) · [Español](README.es.md)

<img src="assets/demo.svg" alt="lastgreen why: 13 changes after an npm install, 7 runs, culprit confirmed: chalk 4.1.2 → 5.3.0" width="900">

<sub>A real session, abridged: real npm registry packages, real output.</sub>

</div>

## The problem

Code that didn't change starts failing because something *around* it changed:

- someone ran `npm update`, or a `^` range picked up a new patch release
- CI moved to a new Node.js version, or a teammate is on a different one
- an AI agent installed a package or set a variable while "fixing" something else
- a `.env`, `NODE_OPTIONS` or `TZ` is different on that one machine

The usual fix is an afternoon of reading lockfile diffs, reinstalling, and asking
"works on my machine?" on Slack. lastgreen does the experiment for you.

## Quick start

```bash
npx lastgreen init --ci   # once: records every green run, adds the CI workflow
npm test                  # as usual; green runs are remembered
npx lastgreen why         # the day they break
```

`init` wraps your test script (`"test": "lastgreen run -- \"vitest run\""`), adds
lastgreen as a devDependency, writes `.github/workflows/lastgreen.yml` and shows
how to connect your AI agent. Prefer no setup? `npx lastgreen run -- npm test`
once while tests pass is enough. `lastgreen run` passes your command's output
and exit code through untouched and adds one line at the end.

Already broken, with no saved green? `npx lastgreen why --from-git` uses the
npm lockfile from `HEAD` when it has uncommitted changes, otherwise from
`HEAD^`. Pass a commit, branch or tag to choose explicitly:
`npx lastgreen why --from-git main`.

| You say | You run |
| --- | --- |
| "It worked yesterday." | `lastgreen why` |
| "What changed since it last passed?" (runs nothing) | `lastgreen diff` |
| "It works on my machine." | they run `lastgreen export`, you run `lastgreen why --against lastgreen-export.json` |
| "CI is red and nobody changed anything." | the [GitHub Action](#in-ci) |
| "The Dependabot / Renovate PR is red." | the [GitHub Action](#with-dependabot-and-renovate): which bump, which line, which release note |
| "It only fails sometimes." | `lastgreen why --repeat 3` |
| "The project is on Node 18 and I'm on 22." | `lastgreen why`: uses `.nvmrc` / `engines`, even with no green run |
| "Agent, why did the tests break?" | the [MCP server](#ai-agents-mcp) |

## How it works

1. **A fingerprint of every run.** `lastgreen run` records what is *really*
   installed (npm's hidden lockfile cross-checked against disk, or pnpm's link
   graph), the Node version your command actually gets, the package manager,
   behavioural env vars, config files and the git state. It runs in parallel
   with your command and takes 60–180 ms.
2. **A ranked diff.** When it fails, `why` compares now with the last green run.
   Major bumps, direct dependencies and packages named in the error go first.
3. **Delta debugging.** It re-runs your command with subsets of the old
   environment put back (Zeller & Hildebrandt's *ddmin*), so one culprit among
   hundreds of changes takes a handful of runs: 7 runs for the 13 changes above.
4. **Dependency-aware.** Putting `chalk@4` back also puts back the
   `ansi-styles` it needs; keeping `debug@4.4` keeps the `ms` it requires.
   Ranges are checked with semver, so every tested combination is one npm or
   pnpm could have installed.
5. **Proved in both directions.** Undoing only the culprit must make it pass and
   keeping only the culprit must make it fail. If not, it says so instead of guessing.
6. **What to change, not only what to pin.** It shows the line where your code
   breaks and the line that imports the package. Then it shows what changed
   upstream, read from the package's CHANGELOG or its GitHub release notes,
   with the notes that match your error first. For Node.js it shows the
   official deprecation (DEP code, replacement and automated codemod when there
   is one). You get two fixes: go back now, or move forward.

```text
  Where it breaks in your code
    src/report.js:7  const byDay = _.groupBy(valid, (o) => format(o.date, 'yyyy-MM-dd'));

  How your code uses date-fns
    src/report.js:1  const format = require('date-fns/format');

  What changed in date-fns 2.30.0 → 3.6.0 (its CHANGELOG)
    3.0.0  ⚠ BREAKING: Now all file content's exported via named exports instead of
             `export default`, which will require change direct imports i.e.
             `const addDays = require('date-fns/addDays')` to `const { addDays } = require(...)`

Fix
    to go back now:     npm install --save-exact date-fns@2.30.0
    or to move forward: update src/report.js:7 for date-fns 3.6.0
```

<sub>Real output from a vitest project after an `npm update` that changed 61 packages (6 runs, 30 s).</sub>

## Why not just…

- **…`git bisect`?** It searches commits. Here no commit is bad: the code is the
  same and the environment moved. lastgreen tells you when it *is* the code and
  prints the `git bisect` command to run.
- **…diff the lockfile?** You get 200 changed lines and no answer. Which one
  matters, and does reverting it actually fix it?
- **…ask my AI agent?** It reads the error and guesses. lastgreen runs the
  experiment and confirms. Better: give the agent lastgreen as a
  [tool](#ai-agents-mcp). With the confirmed culprit, the failing line and the
  breaking-change note, the agent can make the right fix instead of a plausible one.
- **…use Docker/Nix so nothing drifts?** Great if you can. Most projects can't
  pin everything, and when they do, CI images and Node versions still move.

## In CI

The GitHub Action keeps the green fingerprint of your default branch. When a run
fails, it compares with it, finds the culprit and writes the report on the job
summary page.

```yaml
permissions:
  contents: read
  actions: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - uses: MarioACo/lastgreen@v0
        with:
          command: npm test
```

It fails the job exactly when your tests fail. Outputs: `result` (`green`, `found`,
`not-in-env`…), `exit-code`, and `report`. A failed run uploads a reproducible
Markdown diagnosis with the culprit, confidence, evidence, every configuration
tested and exact fixes. Outside GitHub, create the same report with:

```bash
npx lastgreen why --report lastgreen-report.md
```

`npx lastgreen why --json` exposes the same configuration trace as structured data.

## With Dependabot and Renovate

Update PRs are where the environment changes on purpose, and where it breaks
most often. With the Action in the workflow (`npx lastgreen init --ci` adds it),
a red update PR is compared with the green baseline of your default branch:

- **One bump:** confirmed, with the line in your code to change and the release
  note that explains it.
- **A grouped Renovate PR** (five updates at once): it tells you which one broke
  the build, so the other four can be merged.
- **Two bumps that only fail together:** it says so, instead of blaming one.

It needs no secrets: the Action only reads the baseline artifact (`actions: read`),
so it works on Dependabot PRs as they are.

<sub>Real example: a Dependabot-style `date-fns` 2 → 3 bump in a vitest project, run like CI (`npm ci`, then the Action's steps). Culprit confirmed in 5 runs, with `src/report.js:7`, the `require('date-fns/format')` line and the changelog entry about named exports, all in the job summary.</sub>

## AI agents (MCP)

`lastgreen mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server with three tools: `lastgreen_record`, `lastgreen_diff` and
`lastgreen_why`. Your agent stops guessing from stack traces and gets a
confirmed culprit plus the exact fix command.

```bash
# Claude Code
claude mcp add lastgreen -- npx -y lastgreen mcp
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.lastgreen]
command = "npx"
args = ["-y", "lastgreen", "mcp"]
```

```json
// Cursor: .cursor/mcp.json
{ "mcpServers": { "lastgreen": { "command": "npx", "args": ["-y", "lastgreen", "mcp"] } } }
```

## Safety

- **Setup is transactional.** If the package manager fails during `lastgreen
  init`, `package.json` and the lockfiles are restored byte-for-byte and no CI
  workflow is left behind.
- **Isolation is automatic.** `lastgreen why` measures the project and free
  space, copies it and `node_modules` to a temporary folder, and runs the full
  search there. Disposable caches are skipped and abandoned copies are removed
  on the next run. Use `--sandbox` to require isolation or `--no-sandbox` to
  explicitly use the original tree with journal-based restoration.
- **Your code is never touched.**
- **`node_modules` is restored, always.** Every change is written to
  `.lastgreen/journal.json` *before* it happens. Ctrl+C, a crash or a power cut
  is repaired by the next lastgreen command (or `lastgreen restore`), and the
  result is verified against disk. Tested with a real Ctrl+C on Windows and a
  killed process on every OS.
- **Verified downloads.** Old package versions are checked against the integrity
  hash recorded when they were installed. Old Node.js versions come from your
  version manager (nvm, nvm-windows, fnm, volta, mise, asdf, n) or from
  nodejs.org, checked against the official SHA-256 sums.
- **No install scripts run** unless you pass `--rebuild` (for native addons).

Sandbox telemetry is included in `why --json` under `isolation`: mode, whether
isolation was used, file/byte counts, cache paths skipped, scan/copy time,
copy strategy, disk budget and the exact fallback reason when isolation was not
possible. To benchmark a large synthetic monorepo without keeping fixtures:

```text
npm run bench:sandbox -- --files 50000 --file-bytes 1024
node scripts/bench-sandbox.mjs --files 200000 --file-bytes 16384
```

The benchmark verifies the copy and cache exclusions, prints JSON, and removes
all generated data. CI runs a smaller version on Windows, macOS and Linux.

## Privacy

Snapshots stay in `.lastgreen/`, which git ignores automatically. Nothing about
your project is sent anywhere: lastgreen only downloads public data (old package
tarballs from your registry, Node.js builds, release notes from GitHub and
Node's deprecation list), and `--offline` turns all of it off. Environment
variables are stored as a short SHA-256 hash. Clear values
are kept only for a short allowlist of non-secret behavioural variables
(`NODE_OPTIONS`, `NODE_ENV`, `TZ`, `LANG`, `CI`…), and never for anything whose
name looks like a secret. `.env` files are hashed, never copied. `lastgreen
export` also strips local paths and test output.

## Support

| | Finds the culprit | Notes |
| --- | :---: | --- |
| npm | ✅ | real-registry tested |
| pnpm | ✅ | real-registry tested, including versions pnpm already deleted |
| yarn classic, bun | ✅ | hoisted `node_modules`; less tested |
| Yarn Plug'n'Play | — | diff only |
| Node.js version | ✅ | downloads and verifies old versions if needed; `.nvmrc`, `.node-version`, `.tool-versions`, Volta and `engines` count as the expected version |
| Environment variables | ✅ | when the old value is non-secret, or the variable is new |
| Package manager, OS, `.env` / config files, source code | — | shown in the diff; for code it prints the `git bisect` command |

Windows, macOS and Linux, Node.js 16+. Zero dependencies. English and Spanish
(automatic, or `--lang`).

Flaky tests: with `--repeat 3` every configuration runs three times, and one
whose runs disagree is reported as flaky instead of being blamed on the
environment. Causes outside the machine (a remote API, the date) can't be
put back, and then `why` tells you the environment is *not* the cause, which is
also an answer.

<details>
<summary><b>All commands and options</b></summary>

```text
lastgreen init [--ci]          set up: wrap the test script, add the CI workflow, show MCP setup
                               (--no-install, --dry-run)
lastgreen run -- <command>     run and record a snapshot (green or red)
lastgreen why                  find and confirm the culprit
lastgreen why --from-git [ref] use an npm lockfile from Git when no green was saved
lastgreen diff                 list changes since the last green, run nothing
lastgreen export [-o file]     share your last green environment
lastgreen log                  list saved snapshots
lastgreen restore              repair node_modules after an interrupted bisect
lastgreen mcp                  MCP server for AI agents

  -c, --command <cmd>   command to re-run (default: the one from the last green)
  --against <file>      compare with an exported snapshot
  --from-git [ref]      use npm lockfile from Git (HEAD if dirty, otherwise HEAD^)
  --max-runs <n>        give up after n runs (default 60)
  --timeout <seconds>   per run (default: 5x the green run, at least 120)
  --offline             never download packages or Node versions
  --sandbox             require the automatic temporary copy
  --no-sandbox          modify and restore the original node_modules instead
  --rebuild             run install scripts (native addons) of restored packages
  --repeat <n>          run each configuration n times; disagreeing runs are flaky
  --node <version>      compare with another Node.js version (18, lts/hydrogen, ^20)
  --show-output         print the end of each run's output
  --report <file.md>    write a reproducible Markdown diagnosis
  --json                machine-readable result on stdout
  --lang en|es          language (also LASTGREEN_LANG)
```

Project config (optional) in `.lastgreenrc.json` or a `"lastgreen"` key in
`package.json`:

```json
{ "command": "npm test", "ignoreEnv": ["MY_NOISY_*"], "timeout": 300, "repeat": 2 }
```

</details>

## lastgreen for teams

The CLI, the GitHub Action and the MCP server are free and MIT, forever. One
developer has everything they need.

A team has problems one person doesn't: ten laptops and a CI drifting apart, the
same breaking upgrade hitting five repos, nobody knowing what all of it costs.
That's what the hosted version is for:

- **Stop it before it breaks.** Laptops and CI runners report their fingerprint
  (opt-in). You see who is on another Node, whose `node_modules` no longer matches
  the lockfile, and which upgrade is about to land, before anyone loses an afternoon.
- **Fix it once for every repo.** When an upgrade is confirmed to break something,
  every other repo that uses that package is warned, with the line to change and
  the release note.
- **The answer inside the pull request.** When CI goes red without a code change,
  the confirmed culprit, the failing line and both fixes appear as a comment.
  Nobody has to run anything.
- **Know what it costs.** A monthly report: how often the environment broke the
  build, how long it took to fix, how much time lastgreen saved.

**Example:** 10 developers. The environment breaks the build twice a month and
finding the cause takes 2 hours each time: 4 developer-hours a month, every month.
lastgreen Team for those 10 people: $80 a month.

Free for open source and individuals. For private repositories of organizations
it's planned at **$8 per active committer per month** (counted like GitHub: people
who pushed in the last 90 days). Early-access teams use it free during the beta.

**[→ Request early access](https://github.com/MarioACo/lastgreen/issues/new?template=team-interest.yml)**

## Roadmap

- [x] npm, pnpm, Node.js versions, environment variables
- [x] GitHub Action, MCP server, `--json`, reproducible Markdown reports
- [x] `lastgreen init`, flaky tests (`--repeat`), Dependabot and Renovate PRs
- [x] Node.js 16+, the declared Node version as a baseline, `--node`
- [ ] Python (uv, pip) and lockfile-only reproduction in CI
- [ ] "What did the agent change on my machine?": snapshots around AI agent sessions
- [ ] lastgreen for teams (hosted)

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). To
report a security problem, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © MarioACo
