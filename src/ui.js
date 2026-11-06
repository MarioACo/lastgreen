// Terminal output: colours (NO_COLOR / FORCE_COLOR aware) and symbols with an
// ASCII fallback for old Windows consoles.
const env = process.env;

function colorEnabled(stream) {
  if ('NO_COLOR' in env) return false;
  if (env.FORCE_COLOR) return env.FORCE_COLOR !== '0';
  return Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

function unicodeEnabled() {
  if (process.platform !== 'win32') return env.TERM !== 'linux';
  return Boolean(
    env.WT_SESSION || env.TERMINUS_SUBLIME || env.ConEmuTask === '{cmd::Cmder}' ||
      env.TERM_PROGRAM === 'vscode' || env.TERM === 'xterm-256color' || env.TERM === 'alacritty' ||
      env.TERMINAL_EMULATOR === 'JetBrains-JediTerm',
  );
}

let useColor = colorEnabled(process.stdout);
export function setColor(on) {
  useColor = on;
}
export function configureFor(stream) {
  useColor = colorEnabled(stream);
}

const wrap = (open, close) => (text) => (useColor ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

const uni = unicodeEnabled();
export const sym = {
  ok: uni ? '✓' : 'v',
  fail: uni ? '✗' : 'x',
  arrow: uni ? '→' : '->',
  dot: uni ? '·' : '-',
  warn: uni ? '⚠' : '!',
  bullet: uni ? '●' : '*',
};

export function visibleLength(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function pad(text, width) {
  const len = visibleLength(text);
  return len >= width ? text : text + ' '.repeat(width - len);
}

export function seconds(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${s} s`;
}

export function createWriter(stream) {
  return (line = '') => stream.write(`${line}\n`);
}
