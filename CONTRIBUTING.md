# Contributing to lastgreen

Thanks for helping. lastgreen touches people's `node_modules`, so correctness and
safety come before features.

## Setup

```bash
git clone https://github.com/MarioACo/lastgreen
cd lastgreen
node --test          # the whole suite, offline, ~10 s
```

No dependencies to install. Node.js 20+.

## Ground rules

- **Zero runtime dependencies.** Everything ships in `src/`.
- **Never lose user state.** Anything that changes `node_modules` must be written
  to the journal *before* it happens, and `restore()` must stay synchronous and
  idempotent. Add a crash test (`LASTGREEN_DEBUG_CRASH_AFTER`) for new engines.
- **Never guess.** If a result is not confirmed in both directions, say so.
- **Never store secrets.** Environment values are hashed unless the variable is
  on the behavioural allowlist in `src/env.js`.
- **Every user-facing message exists in English and Spanish** (`src/i18n.js`).
- **Windows is a first-class platform.** CI runs Windows, macOS and Linux with
  Node 20, 22 and 24.

## Layout

| File | What it does |
| --- | --- |
| `src/snapshot.js` | the fingerprint of a run |
| `src/packages.js`, `src/pnpm.js` | what is really installed (npm hidden lockfile / pnpm link graph) |
| `src/diff.js`, `src/semver.js` | factors, ranking, dependency coupling |
| `src/bisect.js` | delta debugging (ddmin) |
| `src/workspace.js`, `src/pnpm.js` | applying old states safely, journal and restore |
| `src/fetch.js`, `src/tar.js`, `src/runtime.js` | verified tarballs, extraction, Node.js versions |
| `src/commands.js`, `bin/lastgreen.js` | the CLI |
| `src/mcp.js`, `action.yml` | MCP server and GitHub Action |

## Pull requests

Keep them focused, add a test that fails without your change, and run
`node --test` before pushing. The demo in the README is generated with
`node scripts/demo.mjs`.
