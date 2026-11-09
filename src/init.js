// `lastgreen init`: set a project up in one command.
//   - wraps the test script so every green run is recorded
//   - adds lastgreen as a devDependency
//   - with --ci, writes a GitHub Actions workflow that uses the action
//   - prints how to connect Claude Code, Codex or Cursor (MCP)
import fs from 'node:fs';
import path from 'node:path';
import { capture, runCommand } from './exec.js';
import { exists } from './fsx.js';
import { t } from './i18n.js';
import { detectManager } from './packages.js';
import { VERSION } from './snapshot.js';
import { findRoot } from './store.js';
import { c, createWriter, sym } from './ui.js';

/** How the test script should look once wrapped. */
export function wrapTestScript(script) {
  if (/^\s*(npx\s+(-y\s+)?)?lastgreen\s+run\b/.test(script)) return { already: true };
  // Quotes keep `a && b` together as one command for lastgreen. A script that
  // already has double quotes goes to package.json "lastgreen.command" instead.
  if (!script.includes('"')) return { script: `lastgreen run -- "${script}"`, original: script };
  return { script: 'lastgreen run', configCommand: script, original: script };
}

/** The original test command, from a wrapped script or the config. */
export function unwrapTestScript(script, config) {
  const quoted = /^\s*(?:npx\s+(?:-y\s+)?)?lastgreen\s+run\s+--\s+"(.*)"\s*$/.exec(script ?? '');
  if (quoted) return quoted[1];
  const bare = /^\s*(?:npx\s+(?:-y\s+)?)?lastgreen\s+run\s+--\s+(.+)$/.exec(script ?? '');
  if (bare) return bare[1];
  return config?.command ?? null;
}

const INSTALL_DEV = {
  npm: (spec) => `npm install --save-dev ${spec}`,
  pnpm: (spec) => `pnpm add --save-dev ${spec}`,
  yarn: (spec) => `yarn add --dev ${spec}`,
  bun: (spec) => `bun add --dev ${spec}`,
};

const CI_INSTALL = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
  'yarn-berry': 'yarn install --immutable',
  bun: 'bun install --frozen-lockfile',
};

export function workflowYaml({ manager, command, branch, nodeVersionFile, packageManagerField }) {
  const lines = [
    'name: lastgreen',
    '',
    '# Runs the tests through lastgreen. Green runs on the default branch become the',
    '# baseline; when a run fails, lastgreen finds and explains the change that broke it',
    '# (see the job summary). https://github.com/MarioACo/lastgreen',
    'on:',
    '  push:',
    `    branches: [${branch}]`,
    '  pull_request:',
    '',
    'permissions:',
    '  contents: read',
    '  actions: read',
    '',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
  ];
  if (manager === 'pnpm') {
    lines.push('      - uses: pnpm/action-setup@v4');
    if (!packageManagerField) lines.push('        with:', '          version: 9');
  }
  if (manager === 'bun') lines.push('      - uses: oven-sh/setup-bun@v2');
  lines.push('      - uses: actions/setup-node@v4', '        with:');
  lines.push(nodeVersionFile ? `          node-version-file: ${nodeVersionFile}` : '          node-version: 22');
  if (['npm', 'pnpm', 'yarn', 'yarn-berry'].includes(manager)) lines.push(`          cache: ${manager === 'yarn-berry' ? 'yarn' : manager}`);
  lines.push(`      - run: ${CI_INSTALL[manager] ?? 'npm ci'}`);
  lines.push('      - uses: MarioACo/lastgreen@v0', '        with:', `          command: ${JSON.stringify(command)}`);
  return `${lines.join('\n')}\n`;
}

async function defaultBranch(root) {
  const remote = await capture('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  if (remote) return remote.replace(/^origin\//, '');
  const current = await capture('git', ['branch', '--show-current'], { cwd: root });
  return current || 'main';
}

export async function cmdInit(opts, UserError) {
  const say = createWriter(process.stdout);
  const root = findRoot(process.cwd());
  if (!root) throw new UserError(t('noProject'));
  const file = path.join(root, 'package.json');
  const text = fs.readFileSync(file, 'utf8');
  const configFiles = [
    file,
    ...['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].map((name) => path.join(root, name)),
  ];
  const before = new Map(
    configFiles.map((name) => {
      try {
        return [name, fs.readFileSync(name)];
      } catch {
        return [name, null];
      }
    }),
  );
  const rollbackConfig = () => {
    for (const [name, contents] of before) {
      if (contents == null) fs.rmSync(name, { force: true });
      else fs.writeFileSync(name, contents);
    }
  };
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
  const pkg = JSON.parse(text);
  const manager = detectManager(root, pkg) ?? 'npm';
  const dry = Boolean(opts.dryRun);
  const done = [];
  say(c.bold(t(dry ? 'initTitleDry' : 'initTitle')));

  // 1. The test script.
  let command = null;
  const test = pkg.scripts?.test;
  if (!test || /no test specified/.test(test)) {
    say(c.yellow(`  ${sym.warn} ${t('initNoTest')}`));
  } else {
    const w = wrapTestScript(test);
    if (w.already) {
      command = unwrapTestScript(test, pkg.lastgreen);
      say(`  ${c.green(sym.ok)} ${t('initAlready')}`);
    } else {
      pkg.scripts.test = w.script;
      if (w.configCommand) pkg.lastgreen = { ...(pkg.lastgreen ?? {}), command: w.configCommand };
      command = w.original;
      done.push('script');
      say(`  ${c.green(sym.ok)} ${t('initWrapped')}`);
      say(c.dim(`      "test": ${JSON.stringify(test)}`));
      say(`      "test": ${c.cyan(JSON.stringify(w.script))}`);
      if (w.configCommand) say(c.dim(`      ${t('initConfigCommand')}`));
    }
  }
  if (done.includes('script') && !dry) {
    let out = `${JSON.stringify(pkg, null, indent)}\n`;
    if (text.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
    fs.writeFileSync(file, out);
  }

  // 2. The devDependency (needed so `npm test` finds `lastgreen`).
  const has = pkg.devDependencies?.lastgreen || pkg.dependencies?.lastgreen;
  const install = (INSTALL_DEV[manager] ?? INSTALL_DEV.npm)(`lastgreen@^${VERSION}`);
  if (has) {
    say(`  ${c.green(sym.ok)} ${t('initHasDep')}`);
  } else if (dry || opts.noInstall) {
    say(`  ${sym.arrow} ${t('initInstallLater')} ${c.cyan(install)}`);
  } else {
    say(c.dim(`  ${t('initInstalling', install)}`));
    const r = await runCommand(install, { cwd: root, timeoutMs: 180_000 });
    if (r.code === 0) say(`  ${c.green(sym.ok)} ${t('initInstalled')}`);
    else {
      rollbackConfig();
      throw new UserError(`${t('initInstallRolledBack')}\n${t('initInstallRetry')} ${install}${r.error ? `\n${r.error}` : ''}`);
    }
  }

  // 3. CI.
  const wf = path.join(root, '.github', 'workflows', 'lastgreen.yml');
  if (opts.ci) {
    if (!command) {
      say(c.yellow(`  ${sym.warn} ${t('initCiNeedsCommand')}`));
    } else if (exists(wf)) {
      say(`  ${c.green(sym.ok)} ${t('initWorkflowExists')}`);
    } else {
      const nodeVersionFile = ['.nvmrc', '.node-version'].find((f) => exists(path.join(root, f))) ?? null;
      const flavor = manager === 'yarn' && exists(path.join(root, '.yarnrc.yml')) ? 'yarn-berry' : manager;
      const yaml = workflowYaml({ manager: flavor, command, branch: await defaultBranch(root), nodeVersionFile, packageManagerField: Boolean(pkg.packageManager) });
      if (!dry) {
        fs.mkdirSync(path.dirname(wf), { recursive: true });
        fs.writeFileSync(wf, yaml);
      }
      say(`  ${c.green(sym.ok)} ${t('initWorkflow')} ${c.cyan('.github/workflows/lastgreen.yml')}`);
    }
  }

  // 4. Next steps.
  say('');
  say(c.bold(t('initNext')));
  const runTests = manager === 'bun' ? 'bun run test' : `${manager} test`;
  if (command) say(`  1. ${t('initFirstGreen')} ${c.cyan(runTests)}`);
  say(`  2. ${t('initWhenBreaks')} ${c.cyan('npx lastgreen why')}`);
  if (!opts.ci) say(`  3. ${t('initCiHint')} ${c.cyan('npx lastgreen init --ci')}`);
  say('');
  say(c.bold(t('initMcp')));
  say(`  Claude Code  ${c.cyan('claude mcp add lastgreen -- npx -y lastgreen mcp')}`);
  say(`  Codex        ${c.dim('~/.codex/config.toml')}`);
  for (const line of ['[mcp_servers.lastgreen]', 'command = "npx"', 'args = ["-y", "lastgreen", "mcp"]']) say(`               ${c.cyan(line)}`);
  say(`  Cursor       ${c.dim('.cursor/mcp.json')}  ${c.cyan('{ "mcpServers": { "lastgreen": { "command": "npx", "args": ["-y", "lastgreen", "mcp"] } } }')}`);
}
