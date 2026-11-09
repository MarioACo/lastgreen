// Reproducible sandbox benchmark. It creates synthetic source and node_modules
// trees in the OS temp directory, verifies isolation, prints JSON, then cleans up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandbox } from '../src/sandbox.js';

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? fallback : Number(process.argv[at + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} needs a positive integer`);
  return value;
}

const files = option('files', 50_000);
const fileBytes = option('file-bytes', 1024);
const cacheFiles = Math.min(1000, Math.max(10, Math.floor(files / 20)));
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lastgreen-bench-')));
const root = path.join(base, 'project');
let sandbox;

try {
  const generatedAt = Date.now();
  const body = Buffer.alloc(fileBytes, 120);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sandbox-benchmark', private: true }));
  for (let i = 0; i < files; i++) {
    const group = Math.floor(i / 100);
    const parent = i % 2
      ? path.join(root, 'packages', `workspace-${group}`, 'src')
      : path.join(root, 'node_modules', `package-${group}`, 'lib');
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(path.join(parent, `file-${i}.js`), body);
  }
  const cache = path.join(root, 'node_modules', '.cache', 'benchmark');
  fs.mkdirSync(cache, { recursive: true });
  for (let i = 0; i < cacheFiles; i++) fs.writeFileSync(path.join(cache, `cache-${i}`), body);
  const generationMs = Date.now() - generatedAt;

  sandbox = createSandbox(root);
  const first = path.join(sandbox.root, 'node_modules', 'package-0', 'lib', 'file-0.js');
  const lastIndex = files - 1;
  const lastGroup = Math.floor(lastIndex / 100);
  const last = lastIndex % 2
    ? path.join(sandbox.root, 'packages', `workspace-${lastGroup}`, 'src', `file-${lastIndex}.js`)
    : path.join(sandbox.root, 'node_modules', `package-${lastGroup}`, 'lib', `file-${lastIndex}.js`);
  if (!fs.existsSync(first) || !fs.existsSync(last)) throw new Error('sandbox copy is incomplete');
  if (fs.existsSync(path.join(sandbox.root, 'node_modules', '.cache'))) throw new Error('disposable cache was copied');

  process.stdout.write(`${JSON.stringify({
    platform: process.platform,
    node: process.version,
    requestedFiles: files,
    fileBytes,
    generatedBytes: files * fileBytes,
    generationMs,
    files: sandbox.files,
    bytes: sandbox.bytes,
    excludedPaths: sandbox.excludedPaths,
    strategy: sandbox.strategy,
    scanMs: sandbox.scanMs,
    copyMs: sandbox.copyMs,
    availableBytes: sandbox.availableBytes,
    requiredBytes: sandbox.requiredBytes,
  }, null, 2)}\n`);
} finally {
  sandbox?.cleanup();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
