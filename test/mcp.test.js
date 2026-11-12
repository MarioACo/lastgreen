// The MCP server, spoken to exactly like an AI agent would: JSON-RPC lines over stdio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BIN, cli, install, packageTarball, tmpDir, writeProject } from './helpers.js';

function client(cwd) {
  const env = { ...process.env, LASTGREEN_CACHE_DIR: path.join(cwd, '..', 'lg-cache') };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  let nextId = 1;
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise((resolve) => pending.set(id, resolve));
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    close() {
      if (child.exitCode !== null) return Promise.resolve();
      child.stdin.end();
      return new Promise((r) => child.on('close', r));
    },
  };
}

test('MCP: handshake, tool list, and lastgreen_why finds the culprit for an agent', { timeout: 120_000 }, async () => {
  const dir = tmpDir();
  const root = path.join(dir, 'proj');
  const tars = path.join(dir, 'tars');
  writeProject(root, {
    dependencies: { alpha: '^1.0.0' },
    testFile: "if (require('alpha').add(2, 3) !== 5) { console.error('add is broken'); process.exit(1); }\n",
  });
  const alpha = (v, src) => packageTarball(tars, 'alpha', v, { 'index.js': src });
  await install(root, { 'node_modules/alpha': alpha('1.0.0', 'exports.add = (a, b) => a + b;') });

  const mcp = client(root);
  try {
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'lastgreen');
  assert.ok(init.result.capabilities.tools);
  mcp.notify('notifications/initialized');

  const list = await mcp.request('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['lastgreen_record', 'lastgreen_diff', 'lastgreen_why']);
  assert.equal(list.result.tools.find((t) => t.name === 'lastgreen_diff').annotations.readOnlyHint, true);
  assert.ok(list.result.tools.every((t) => t.annotations && t.annotations.destructiveHint === false));

  const rec = await mcp.request('tools/call', { name: 'lastgreen_record', arguments: { command: 'node test.js' } });
  assert.match(rec.result.content[0].text, /Exit code 0/);

  await install(root, { 'node_modules/alpha': alpha('1.0.1', 'exports.add = (a, b) => a * b;') });
  const why = await mcp.request('tools/call', { name: 'lastgreen_why', arguments: {} });
  assert.equal(why.result.isError, false, why.result.content[0].text);
  assert.equal(why.result.structuredContent.status, 'found');
  assert.deepEqual(why.result.structuredContent.culprit.map((f) => f.name), ['alpha']);
  assert.match(why.result.content[0].text, /Culprit confirmed/);

  const unknown = await mcp.request('nope', {});
  assert.equal(unknown.error.code, -32601);
  } finally {
    await mcp.close();
  }
  assert.ok(fs.existsSync(path.join(root, '.lastgreen')));
  assert.equal(cli(root, ['log']).code, 0);
});
