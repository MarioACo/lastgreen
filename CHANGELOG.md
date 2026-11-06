# Changelog

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
