#!/usr/bin/env node
import { cmdExport, cmdLog, cmdRestore, cmdRun, cmdWhy, UserError } from '../src/commands.js';
import { setLang, t } from '../src/i18n.js';
import { VERSION } from '../src/snapshot.js';
import { setColor } from '../src/ui.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 16) {
  process.stderr.write(`lastgreen needs Node.js 16 or newer (you have ${process.version}).\n`);
  process.exit(1);
}

const VALUE_FLAGS = { '-c': 'command', '--command': 'command', '--against': 'against', '--max-runs': 'maxRuns',
  '--timeout': 'timeout', '--repeat': 'repeat', '--node': 'node', '-o': 'out', '--out': 'out', '-n': 'n', '--lang': 'lang' };
const BOOL_FLAGS = { '--dry-run': 'dryRun', '--offline': 'offline', '--rebuild': 'rebuild', '--json': 'json', '--show-output': 'showOutput',
  '--now': 'now', '--ci': 'ci', '--no-install': 'noInstall', '--no-color': 'noColor', '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version' };
const NUMERIC = new Set(['maxRuns', 'timeout', 'n', 'repeat']);

function parse(argv) {
  const opts = {};
  let command = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (command === 'run') {
      // Everything after `run` (and an optional `--`) is the user's command.
      rest.push(...(arg === '--' ? argv.slice(i + 1) : argv.slice(i)));
      break;
    }
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (VALUE_FLAGS[flag]) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UserError(`${flag} needs a value`);
      const key = VALUE_FLAGS[flag];
      opts[key] = NUMERIC.has(key) ? Number(value) : value;
      if (NUMERIC.has(key) && !(opts[key] > 0)) throw new UserError(`${flag} needs a positive number`);
    } else if (BOOL_FLAGS[flag]) {
      opts[BOOL_FLAGS[flag]] = true;
    } else if (!command && !arg.startsWith('-')) {
      command = arg;
    } else {
      throw new UserError(`Unknown option: ${arg}`);
    }
  }
  return { command, opts, rest };
}

async function main() {
  let parsed;
  try {
    parsed = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`lastgreen: ${err.message}\n`);
    process.exit(2);
  }
  const { command, opts, rest } = parsed;
  if (opts.lang) setLang(opts.lang);
  if (opts.noColor) setColor(false);
  if (opts.version) return void process.stdout.write(`${VERSION}\n`);
  if (opts.help || !command) return void process.stdout.write(`${t('help')}\n`);

  switch (command) {
    case 'run':
      return cmdRun(rest);
    case 'why':
      return cmdWhy(opts, { dryRun: Boolean(opts.dryRun) });
    case 'diff':
      return cmdWhy(opts, { dryRun: true });
    case 'export':
      return cmdExport(opts);
    case 'log':
      return cmdLog(opts);
    case 'restore':
      return cmdRestore();
    case 'init': {
      const { cmdInit } = await import('../src/init.js');
      return cmdInit(opts, UserError);
    }
    case 'mcp': {
      const { serve } = await import('../src/mcp.js');
      return serve();
    }
    default:
      throw new UserError(`Unknown command "${command}". Try: lastgreen --help`);
  }
}

main().catch((err) => {
  if (err instanceof UserError || err?.code === 'ESTATE') {
    process.stderr.write(`lastgreen: ${err.message}\n`);
  } else {
    process.stderr.write(`lastgreen: unexpected error\n${err?.stack ?? err}\n`);
  }
  process.exitCode = process.exitCode || 1;
});
