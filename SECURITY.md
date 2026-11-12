# Security policy

lastgreen downloads package tarballs and Node.js binaries and temporarily
changes `node_modules`, so security reports get priority.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub security advisories](https://github.com/MarioACo/lastgreen/security/advisories/new).
You will get an answer within 72 hours, and a fix or a mitigation plan within 14 days.

## What lastgreen guarantees

- Package tarballs are verified against the integrity hash recorded at install
  time before they are used; a mismatch makes that change untestable.
- Node.js binaries are verified against the official `SHASUMS256.txt` of the release.
- Tar extraction refuses absolute paths, `..` and links.
- Install scripts never run unless `--rebuild` is passed.
- Environment variable values are stored only as hashes, except a short
  allowlist of non-secret behavioural variables.
- Nothing about your project is sent anywhere; snapshots stay in the project's
  `.lastgreen/` folder. Only public data is downloaded: package tarballs from
  your registry, official Node.js builds, release notes (GitHub) and Node's
  deprecation list. `--offline` turns all of it off.
- Releases are published from GitHub Actions with npm provenance, so the package
  on npm is verifiably built from this repository.

## Use of a shell

lastgreen runs **your test command** through a shell, exactly as you would type
it (`npm test`, `vitest run && eslint .`). That is the purpose of the tool, and
the command only ever comes from you: the CLI arguments, your `package.json`, or
a snapshot you recorded. Nothing downloaded is ever executed as a command, and
every other process (npm, git, node, package managers) is started without a
shell. The MCP tools run the same command on behalf of your AI agent, which can
already run shell commands in your project.

## MCP tools

| Tool | Reads | Writes | Network |
| --- | --- | --- | --- |
| `lastgreen_diff` | project, `node_modules` | nothing | no |
| `lastgreen_record` | project | `.lastgreen/` | no |
| `lastgreen_why` | project | `node_modules` temporarily, always restored and verified | public tarballs, Node builds, release notes |

## Supported versions

The latest minor release receives security fixes.
