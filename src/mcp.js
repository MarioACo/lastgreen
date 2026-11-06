// `lastgreen mcp`: a Model Context Protocol server over stdio, so AI coding
// agents (Claude Code, Codex, Cursor...) can ask lastgreen instead of guessing.
// Each tool runs the lastgreen CLI itself with --json in the requested folder.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from './snapshot.js';

const BIN = fileURLToPath(new URL('../bin/lastgreen.js', import.meta.url));
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const cwdProp = {
  type: 'string',
  description: 'Project folder (with package.json). Defaults to the folder the server was started in.',
};

export const TOOLS = [
  {
    name: 'lastgreen_record',
    title: 'Run tests and remember the environment',
    description:
      'Run the test command through lastgreen. If it passes, the environment (installed packages, Node version, env vars) is saved as the last green state; if it fails, it is saved as red. Call this once while tests pass so later failures can be explained.',
    inputSchema: {
      type: 'object',
      properties: { cwd: cwdProp, command: { type: 'string', description: 'Test command, e.g. "npm test". Defaults to the project test script.' } },
    },
  },
  {
    name: 'lastgreen_diff',
    title: 'What changed outside the code',
    description:
      'List everything outside the source code that changed since the tests last passed: package versions, Node.js version, environment variables, config files, git commits. Runs nothing. Use it first when tests that used to pass now fail.',
    inputSchema: {
      type: 'object',
      properties: { cwd: cwdProp, against: { type: 'string', description: 'Optional exported snapshot (lastgreen export) to compare with instead of the last green run.' } },
    },
  },
  {
    name: 'lastgreen_why',
    title: 'Find and confirm the culprit',
    description:
      'Find which environment change broke the tests and confirm it: re-runs the test command with parts of the last green environment put back (delta debugging). node_modules is changed temporarily and always restored. Returns the culprit, how it was confirmed and the exact fix command. Prefer this over guessing from error messages when tests passed before and the code did not change.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: cwdProp,
        command: { type: 'string', description: 'Command to re-run. Defaults to the one from the last green run.' },
        maxRuns: { type: 'number', description: 'Give up after this many runs (default 60).' },
        rebuild: { type: 'boolean', description: 'Run install scripts of restored packages (native addons).' },
      },
    },
  },
];

function runCli(args, cwd) {
  return new Promise((resolve) => {
    // Global flags first: everything after `run --` is the user's command.
    const child = spawn(process.execPath, [BIN, '--lang', 'en', '--no-color', ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => resolve({ code: 1, out, err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const tail = (text, n = 40) => String(text).trim().split(/\r?\n/).slice(-n).join('\n');

export async function callTool(name, args = {}, baseCwd = process.cwd()) {
  const cwd = path.resolve(baseCwd, args.cwd ?? '.');
  if (name === 'lastgreen_record') {
    const cliArgs = ['run'];
    if (args.command) cliArgs.push('--', String(args.command));
    const r = await runCli(cliArgs, cwd);
    const summary = tail(r.err, 3);
    return { isError: false, text: `Exit code ${r.code}. ${summary}\n\nLast output:\n${tail(r.out + r.err, 30)}` };
  }
  if (name === 'lastgreen_diff' || name === 'lastgreen_why') {
    const cliArgs = [name === 'lastgreen_diff' ? 'diff' : 'why', '--json'];
    if (args.against) cliArgs.push('--against', String(args.against));
    if (args.command) cliArgs.push('--command', String(args.command));
    if (args.maxRuns) cliArgs.push('--max-runs', String(args.maxRuns));
    if (args.rebuild) cliArgs.push('--rebuild');
    const r = await runCli(cliArgs, cwd);
    let json = null;
    try {
      json = JSON.parse(r.out);
    } catch {}
    if (!json) return { isError: true, text: tail(r.err || r.out) || `lastgreen exited with code ${r.code}` };
    return { isError: false, text: `${tail(r.err, 60)}\n\n${JSON.stringify(json, null, 2)}`, json };
  }
  return { isError: true, text: `Unknown tool ${name}` };
}

/** Newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio transport). */
export function serve({ input = process.stdin, output = process.stdout } = {}) {
  const send = (msg) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const handle = async (msg) => {
    const { id, method, params } = msg;
    if (id === undefined) return; // notifications (initialized, cancelled...)
    try {
      if (method === 'initialize') {
        const wanted = params?.protocolVersion;
        return send({
          id,
          result: {
            protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'lastgreen', title: 'lastgreen', version: VERSION },
            instructions:
              'When tests that used to pass start failing, call lastgreen_diff, then lastgreen_why to get the confirmed culprit and the fix. Call lastgreen_record while tests pass so there is a green state to compare with.',
          },
        });
      }
      if (method === 'ping') return send({ id, result: {} });
      if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        const res = await callTool(params?.name, params?.arguments ?? {});
        const result = { content: [{ type: 'text', text: res.text }], isError: res.isError };
        if (res.json) result.structuredContent = res.json;
        return send({ id, result });
      }
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (err) {
      send({ id, error: { code: -32603, message: err.message } });
    }
  };
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      handle(msg);
    }
  });
  return new Promise((resolve) => input.on('end', resolve));
}
