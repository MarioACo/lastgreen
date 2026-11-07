// Environment variables: what we record, what we ignore, what we never store.
//
// Values are only ever stored as a short SHA-256 hash, except for a small
// allowlist of variables that change runtime behaviour and are not secrets
// (NODE_OPTIONS, TZ, LANG...). Those are needed to put an old value back
// while bisecting. Anything whose name looks like a secret is hash-only.
import crypto from 'node:crypto';

// Variables that change from one terminal, editor or CI job to the next and
// say nothing about whether tests should pass.
const NOISE_EXACT = new Set([
  'PATH', 'PWD', 'OLDPWD', 'SHLVL', '_', 'PS1', 'PS2', 'PROMPT', 'PROMPT_COMMAND', 'TERM',
  'COLORTERM', 'LS_COLORS', 'LSCOLORS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS', 'WINDOWID', 'LINES', 'COLUMNS', 'HISTFILE', 'HISTSIZE',
  'INIT_CWD', 'NODE', 'COLOR', 'GPG_TTY', 'SECURITYSESSIONID', 'SESSIONNAME', 'STY', 'TMUX',
  'GIT_ASKPASS', 'EDITOR', 'VISUAL', 'PAGER', 'LESS', 'MANPATH', 'INFOPATH', 'CHROME_DESKTOP',
  'CHROME_CRASHPAD_PIPE_NAME', 'ELECTRON_NO_ATTACH_CONSOLE', 'ORIGINAL_XDG_CURRENT_DESKTOP',
  'TERMINAL_EMULATOR', 'IDEA_INITIAL_DIRECTORY', '__INTELLIJ_COMMAND_HISTFILE__',
  '__CF_USER_TEXT_ENCODING', 'APPLE_PUBSUB_SOCKET_RENDER', 'XPC_SERVICE_NAME', 'XPC_FLAGS',
  'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'MOTD_SHOWN', 'HOSTNAME',
  'CLAUDECODE', 'AI_AGENT', 'STARSHIP_SHELL', 'STARSHIP_SESSION_KEY',
]);
const NOISE_PREFIX = [
  'VSCODE_', 'npm_', 'TERM_', 'WT_', 'ITERM', 'KITTY_', 'ALACRITTY_',
  'WEZTERM_', 'GHOSTTY_', 'KONSOLE_', 'GNOME_TERMINAL_', 'VTE_', 'TMUX_', 'SSH_', 'XDG_SESSION',
  'XDG_RUNTIME', 'CLAUDE_CODE_', 'CODEX_', 'LASTGREEN_', 'CONEMU', 'CMDER_', 'GITHUB_', 'RUNNER_',
  'ACTIONS_', 'GITLAB_', 'CI_', 'BUILDKITE_', 'CIRCLE_', 'TRAVIS_', 'JENKINS_', 'BITBUCKET_',
  'AGENT_', 'SYSTEM_', 'BUILD_', '__',
];
// Windows: differences between cmd, PowerShell and Git Bash.
const NOISE_WIN32 = new Set([
  'PSMODULEPATH', 'PSEXECUTIONPOLICYPREFERENCE', 'MSYSTEM', 'MSYS', 'SHELL', 'HOME', 'TEMP', 'TMP',
  'PKG_CONFIG_PATH', 'ACLOCAL_PATH', 'CONFIG_SITE', 'ORIGINAL_TEMP', 'ORIGINAL_TMP',
  'ORIGINAL_PATH', 'EXEPATH', 'PLINK_PROTOCOL', 'DISPLAY',
]);
const NOISE_WIN32_PREFIX = ['MSYSTEM_', 'MINGW_'];

// Variables that are both behavioural and safe to keep in clear text.
const SAFE_VALUE = new Set([
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_NO_WARNINGS', 'NODE_PENDING_DEPRECATION', 'NODE_DEBUG', 'NODE_COMPILE_CACHE',
  'NODE_PRESERVE_SYMLINKS', 'NODE_ICU_DATA', 'UV_THREADPOOL_SIZE', 'TZ', 'LANG', 'LANGUAGE', 'CI',
  'FORCE_COLOR', 'NO_COLOR', 'DEBUG', 'BROWSERSLIST', 'BROWSERSLIST_ENV', 'BABEL_ENV',
  'TS_NODE_PROJECT', 'TS_NODE_TRANSPILE_ONLY', 'TS_NODE_COMPILER_OPTIONS', 'TSX_TSCONFIG_PATH',
]);
const SAFE_VALUE_PREFIX = ['LC_'];

// Never tested by toggling: removing these breaks every process.
const CRITICAL = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'COMMONPROGRAMFILES', 'SYSTEMDRIVE', 'USER', 'USERNAME', 'LOGNAME', 'SHELL',
  'HOMEDRIVE', 'HOMEPATH', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
]);

const SECRET_RE =
  /(TOKEN|SECRET|PASSW|PWD|PRIVATE|CREDENTIAL|COOKIE|SESSION|AUTH|API_?KEY|ACCESS_?KEY|(^|_)KEY($|_)|DSN|DATABASE_URL|CONNECTION_?STRING|SIGNATURE|SALT|WEBHOOK)/i;

export function normName(name, platform = process.platform) {
  return platform === 'win32' ? name.toUpperCase() : name;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function isNoise(name, { platform = process.platform, ignore = [] } = {}) {
  const upper = name.toUpperCase();
  if (NOISE_EXACT.has(upper) || NOISE_EXACT.has(name)) return true;
  if (NOISE_PREFIX.some((p) => name.startsWith(p) || upper.startsWith(p.toUpperCase()))) return true;
  if (platform === 'win32') {
    if (NOISE_WIN32.has(upper)) return true;
    if (NOISE_WIN32_PREFIX.some((p) => upper.startsWith(p))) return true;
  }
  return ignore.some((glob) => globToRegExp(glob).test(name));
}

export function isSecretName(name) {
  return SECRET_RE.test(name);
}

export function canStoreValue(name) {
  const upper = name.toUpperCase();
  if (isSecretName(upper)) return false;
  return SAFE_VALUE.has(upper) || SAFE_VALUE_PREFIX.some((p) => upper.startsWith(p));
}

export function isBehavioural(name) {
  return canStoreValue(name);
}

export function isCritical(name) {
  return CRITICAL.has(name.toUpperCase());
}

export function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function captureEnv(env, { platform = process.platform, ignore = [] } = {}) {
  const out = {};
  for (const [rawName, value] of Object.entries(env)) {
    if (value == null) continue;
    const name = normName(rawName, platform);
    if (isNoise(name, { platform, ignore })) continue;
    const entry = { h: hashValue(value) };
    if (canStoreValue(name)) entry.v = value;
    out[name] = entry;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Find the real key for a variable in an env object (Windows keys are case-insensitive). */
export function envKey(env, name, platform = process.platform) {
  if (platform !== 'win32') return name;
  const upper = name.toUpperCase();
  return Object.keys(env).find((k) => k.toUpperCase() === upper) ?? name;
}

export function setEnv(env, name, value, platform = process.platform) {
  const key = envKey(env, name, platform);
  if (value == null) delete env[key];
  else env[key] = value;
}

export function prependPath(env, dir, platform = process.platform) {
  const key = envKey(env, 'PATH', platform);
  const sep = platform === 'win32' ? ';' : ':';
  env[key] = env[key] ? `${dir}${sep}${env[key]}` : dir;
}
