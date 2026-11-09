# Changelog

## Unreleased

- `lastgreen why --from-git [ref]` can reconstruct an npm baseline from a
  package-lock or shrinkwrap in Git when no green run was saved. It supports npm
  lockfiles v1-v3 and automatically chooses `HEAD` for uncommitted lockfile
  changes or `HEAD^` for a committed update.
- `lastgreen init` is transactional: if adding the devDependency fails, it
  restores `package.json` and lockfiles and does not leave a broken CI workflow.
- `lastgreen why --sandbox` runs the complete bisect in an isolated temporary
  copy, including `node_modules`, and removes it afterwards. Test side effects
  and package swaps cannot touch the original project.

## 0.3.0

- **Runs on Node.js 16 and 18 too** (was 20+), so projects that still live on an
  older Node can record their green runs. Downloads no longer need `fetch`.
- **The Node version a project declares is a baseline.** `.nvmrc`,
  `.node-version`, `.tool-versions`, Volta and `engines.node` are read:
  `lastgreen run` warns when the Node in use does not match, and `lastgreen why`
  works even without a green run (a fresh clone on the wrong Node is enough).
- `--node <version>`: compare with any Node.js version (`18`, `lts/hydrogen`,
  `^20`), preferring one already installed, otherwise an official verified build.
- Nested runs are safe: a wrapped test script re-run during a bisect does not
  record snapshots.

## 0.2.0

- `lastgreen init [--ci]`: one command to set a project up. Wraps the test script
  so every green run is recorded, adds lastgreen as a devDependency, writes a
  GitHub Actions workflow that fits the package manager and Node version file,
  and shows how to connect Claude Code, Codex and Cursor (MCP).
- `--repeat <n>` (or `"repeat"` in the config): every configuration runs n times;
  runs that disagree are reported as a flaky test instead of being blamed on the
  environment.
- Dependabot and Renovate PRs: documented and tested; a grouped update PR tells
  you which bump broke the build.
- `lastgreen run` finds local binaries (`vitest`, `jest`…) even when it is not
  called from an npm script, e.g. inside the GitHub Action.
- Clearer reports: changes that could not be put back are listed with the
  reason, and other-machine environment variables are summarized in one line.

## 0.1.0

First public release.

- `lastgreen run` records a fingerprint of every run: installed packages, Node.js
  version, package manager, behavioural env vars, config files and git state.
- `lastgreen why` finds and confirms, in both directions, the change that broke
  the tests, with delta debugging and dependency-aware coupling (semver ranges).
- "What to change": the failing line in your code (Node, vitest and jest stack
  formats), how your code imports the package, what changed upstream (its
  CHANGELOG or GitHub release notes, ranked by relevance to the error), and for
  Node.js the official deprecation with its replacement and codemod.
- npm (hidden lockfile, nested `node_modules`) and pnpm (link graph, recreating
  versions pnpm already deleted).
- Node.js versions from nvm, nvm-windows, fnm, volta, mise, asdf, n, or
  downloaded from nodejs.org and verified with SHA-256.
- Journaled, crash-safe restore; Ctrl+C, Ctrl+Break and closing the terminal handled.
- `--rebuild` for packages with native install scripts.
- `lastgreen diff`, `export`, `why --against` (works-on-my-machine), `log`, `restore`.
- `--json` output, GitHub Actions job summary, a GitHub Action and an MCP server
  for AI agents.
- English and Spanish.
