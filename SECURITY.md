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
- Nothing is sent anywhere; snapshots stay in the project's `.lastgreen/` folder.

## Supported versions

The latest minor release receives security fixes.
