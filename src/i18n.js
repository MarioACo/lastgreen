// Messages in English and Spanish. Spanish is picked automatically from the
// locale (LANG, LC_ALL, system locale) or with LASTGREEN_LANG=es / --lang es.

const en = {
  noProject: 'No package.json found here or in any parent folder. Run lastgreen inside a Node.js project.',
  busy: (pid) => `Another lastgreen is bisecting this project right now (pid ${pid}). Wait for it to finish.`,
  recovered: (n) => `A previous bisect was interrupted: node_modules restored (${n} change${n === 1 ? '' : 's'} put back).`,
  noCommand: 'Which command should I run? Example: npx lastgreen run -- npm test',
  noCommandWhy: 'No command to re-run. Pass one: npx lastgreen why --command "npm test"',
  greenSaved: (n, node) => `green saved ${'·'} ${n} packages ${'·'} Node ${node ?? '?'}`,
  redNoGreen: 'failed. There is no green run saved yet: once it passes, lastgreen remembers that environment.',
  redNoChanges: (when) => `failed, but nothing outside your code changed since the last green (${when}).`,
  redSummary: (n, when) => `failed ${'·'} ${n} change${n === 1 ? '' : 's'} since the last green (${when})`,
  andMore: (n) => `and ${n} more`,
  runWhy: 'find the culprit:',
  badSnapshot: (file) => `${file} is not a lastgreen snapshot.`,
  noGreen: 'No green run saved for this project yet.\nRun your tests through lastgreen once while they pass:  npx lastgreen run -- npm test',
  lastGreen: 'Last green',
  exportedFrom: (when) => `exported snapshot, ${when}`,
  changesSince: (n) => `${n} change${n === 1 ? '' : 's'} since then`,
  untestable: (n) => `Also changed, can't be tested automatically (${n})`,
  noChanges: 'Nothing outside your code changed since the last green run.',
  dryRunHint: 'Dry run: nothing executed. Run `npx lastgreen why` to test which change is the culprit.',
  fetching: (n) => `Getting ${n} package version${n === 1 ? '' : 's'} from the last green (cached, integrity-checked)...`,
  downloadingNode: (v) => `Downloading official Node.js ${v} (verified with nodejs.org SHA-256)...`,
  nothingTestable: 'None of these changes can be put back automatically.',
  lostFactors: (n) => `${n} change${n === 1 ? '' : 's'} could not be put back, so ${n === 1 ? 'it is' : 'they are'} not part of the search:`,
  otherMachineEnv: (n) => `${n} environment variable${n === 1 ? '' : 's'} differ${n === 1 ? 's' : ''} because it is another machine (not compared)`,
  bisecting: (n, cmd) => `Finding the culprit among ${n} change${n === 1 ? '' : 's'} with \`${cmd}\``,
  safety: 'node_modules is changed temporarily and restored at the end, even on Ctrl+C or a crash.',
  interrupted: 'lastgreen: interrupted, node_modules restored.',
  pass: 'pass',
  fail: 'fail',
  timedOut: 'timed out',
  cfgCurrent: 'current environment',
  cfgGreen: 'last green environment',
  cfgOnly: (label) => `only: ${label}`,
  cfgAllBut: (label) => `all except: ${label}`,
  cfgSome: (k, n) => `${k} of ${n} changes`,
  culpritConfirmed: 'Culprit confirmed:',
  culpritsConfirmed: 'Culprits confirmed (they only fail together):',
  culpritProbable: 'Probable culprit (not confirmed):',
  confirmedHow: (cmd) => `undoing only this makes \`${cmd}\` pass; keeping only this makes it fail`,
  notConfirmedHow: 'undoing only this still fails: flaky test or more than one cause',
  errorWas: 'Failure with this change:',
  whereBreaks: 'Where it breaks in your code',
  howYouUseIt: (name) => `How your code uses ${name}`,
  whatChanged: (label, source) => `What changed in ${label} (${source})`,
  'source.changelog': 'its CHANGELOG',
  'source.github': 'GitHub release notes',
  notesAt: (name, url) => `Release notes of ${name}: ${url}`,
  requiredBy: (name, list) => `${name} is installed because of: ${list}`,
  whatChangedNode: (from, to) => `What Node.js removed or changed between ${from} and ${to} (official deprecations)`,
  nodeChangelogs: (from, to) => `Node.js changes between ${from} and ${to}:`,
  whereEnvRead: (name) => `Where your code reads ${name}`,
  fixBack: 'to go back now:',
  fixForwardLabel: 'or to move forward:',
  fwdPackage: (loc, name, to) => `update ${loc} for ${name} ${to} (see what changed above)`,
  fwdPackageNoLoc: (name, to) => `adapt your code to ${name} ${to} (see what changed above)`,
  fwdNode: (loc, to) => `update ${loc} for Node ${to} (see the replacement above)`,
  fwdEnv: (loc, name) => `review ${loc}, where ${name} is read`,
  notInEnvScripts: (names) => `But ${names} need${names.includes(',') ? '' : 's'} a native build step that was skipped. Try again building them:`,
  scriptNote: (names) => `${names} has an install script and was tested without rebuilding. To be sure: npx lastgreen why --rebuild`,
  withItsDeps: (n) => `(+${n} of its dependencies)`,
  pulls: (n, list) => `the new version also brings ${n} change${n === 1 ? '' : 's'}: ${list}`,
  bringsBack: (n, list) => `undoing it also puts back ${n} dependenc${n === 1 ? 'y' : 'ies'} the old version needs: ${list}`,
  fix: 'Fix',
  notReproduced: 'It passes now: the failure did not reproduce (flaky test, or something already fixed it).',
  notInEnv: 'Putting back everything I can test does not fix it: the cause is not in the testable environment.',
  budget: (n) => `Stopped after ${n} runs without isolating it (use --max-runs to allow more).`,
  restoreProblem: (list) => `could not verify restore of: ${list}. Run \`npx lastgreen restore\` or reinstall.`,
  restoredOk: 'node_modules restored and verified',
  runs: (n) => `${n} run${n === 1 ? '' : 's'}`,
  codeChanged: 'Your code also changed',
  codeCommits: (n, from) => `${n} commit${n === 1 ? '' : 's'} since ${from}`,
  codeFiles: (n) => `${n} uncommitted file${n === 1 ? '' : 's'}`,
  tryGitBisect: 'To search the commits instead:',
  fixExplain: (cmd) => `see who brings it in: ${cmd}`,
  fixOverride: (field, pair) => `pin it in package.json "${field}": { ${pair} } and reinstall`,
  fixNodeUse: (cmd) => `${cmd}`,
  fixNodeInstall: (v) => `use Node ${v}`,
  fixNodePin: (v) => `pin it for everyone: echo ${v} > .nvmrc   (or update the code that relies on the old behaviour)`,
  fixEnvUnset: (name) => `unset ${name} (bash: unset ${name} · PowerShell: Remove-Item Env:${name})`,
  fixEnvSet: (name, v) => `set it back: ${name}=${JSON.stringify(v)}`,
  exportNoGreen: 'No green run saved: exporting the current environment instead.',
  exported: (file) => `Saved ${file} (no secret values, no local paths).`,
  exportHint: 'Send it to whoever has the failing machine. They run:',
  logEmpty: 'No snapshots yet. Start with: npx lastgreen run -- npm test',
  green: 'green',
  red: 'red',
  nothingToRestore: 'Nothing to restore: no bisect was interrupted.',
  inside: 'inside',
  'kind.package': 'package',
  'kind.node': 'node',
  'kind.env': 'env',
  'kind.tool': 'tool',
  'kind.file': 'file',
  'kind.system': 'system',
  'kind.code': 'code',
  'tag.major': 'major',
  'tag.minor': 'minor',
  'tag.patch': 'patch',
  'tag.prerelease': 'pre-release',
  'tag.other': 'version',
  'tag.direct': 'direct dependency',
  'tag.in-output': 'named in the error',
  'tag.install-script': 'has install script',
  'tag.behavioural': 'affects runtime',
  'tag.peers': 'peer dependencies changed',
  'reason.pnpm': 'pnpm layout: diff only for now',
  'reason.layout': 'package manager layout changed',
  'reason.platform': 'platform-specific package',
  'reason.critical': 'system variable',
  'reason.other-machine': 'other machine',
  'reason.value-not-stored': 'old value is not stored (could be a secret)',
  'reason.tool': 'info',
  'reason.content-not-stored': 'content is not stored',
  'reason.system': 'info',
  'reason.code': 'source code',
  'reason.node-download': 'could not get that Node version',
  'reason.node-mismatch': 'could not switch Node version',
  'reason.fetch:offline': 'offline',
  'reason.fetch:integrity': 'tarball integrity mismatch',
  'reason.fetch:local-package': 'local package',
  'reason.fetch:npm-pack': 'could not download old version',
  'reason.fetch:unknown': 'could not download old version',
  help: `lastgreen — git bisect for your environment

Remembers the environment of every passing run (installed packages, Node
version, env vars, config) and, when the same code starts failing, puts the old
pieces back one by one until it finds the change that broke it.

Usage
  npx lastgreen run -- <command>   run your tests; saves a snapshot (green or red)
  npx lastgreen why                find and confirm which change broke them
  npx lastgreen diff               list what changed since the last green, run nothing
  npx lastgreen export [-o file]   share your last green environment with a teammate
  npx lastgreen why --against file   "works on my machine": compare with theirs
  npx lastgreen log                list saved snapshots
  npx lastgreen restore            restore node_modules after an interrupted bisect
  npx lastgreen mcp                MCP server for AI agents (Claude Code, Codex, Cursor)

Options for why/diff
  -c, --command <cmd>   command to re-run (default: the one from the last green)
  --against <file>      compare with an exported snapshot instead of the last green
  --max-runs <n>        give up after n runs (default 60)
  --timeout <seconds>   per run (default: 5x the green run, at least 120)
  --offline             do not download old packages or Node versions
  --rebuild             run install scripts (native addons) of restored packages
  --show-output         print the end of each run's output
  --json                machine-readable result on stdout (for CI and AI agents)

Global
  --lang en|es   language (also LASTGREEN_LANG)   --no-color   -v, --version   -h, --help`,
};

const es = {
  noProject: 'No encontré package.json aquí ni en carpetas superiores. Ejecuta lastgreen dentro de un proyecto de Node.js.',
  busy: (pid) => `Otro lastgreen está buscando en este proyecto ahora mismo (pid ${pid}). Espera a que termine.`,
  recovered: (n) => `Una búsqueda anterior se interrumpió: node_modules restaurado (${n} cambio${n === 1 ? '' : 's'} devuelto${n === 1 ? '' : 's'}).`,
  noCommand: '¿Qué comando ejecuto? Ejemplo: npx lastgreen run -- npm test',
  noCommandWhy: 'No hay comando para repetir. Indícalo: npx lastgreen why --command "npm test"',
  greenSaved: (n, node) => `verde guardado ${'·'} ${n} paquetes ${'·'} Node ${node ?? '?'}`,
  redNoGreen: 'falló. Aún no hay ninguna ejecución en verde: cuando pase, lastgreen recordará ese entorno.',
  redNoChanges: (when) => `falló, pero nada fuera de tu código cambió desde el último verde (${when}).`,
  redSummary: (n, when) => `falló ${'·'} ${n} cambio${n === 1 ? '' : 's'} desde el último verde (${when})`,
  andMore: (n) => `y ${n} más`,
  runWhy: 'encuentra al culpable:',
  badSnapshot: (file) => `${file} no es una huella de lastgreen.`,
  noGreen: 'Todavía no hay ninguna ejecución en verde guardada para este proyecto.\nCorre tus pruebas una vez con lastgreen mientras pasan:  npx lastgreen run -- npm test',
  lastGreen: 'Último verde',
  exportedFrom: (when) => `huella exportada, ${when}`,
  changesSince: (n) => `${n} cambio${n === 1 ? '' : 's'} desde entonces`,
  untestable: (n) => `También cambió, sin poder probarlo automáticamente (${n})`,
  noChanges: 'Nada fuera de tu código cambió desde el último verde.',
  dryRunHint: 'Solo diferencias: no se ejecutó nada. Corre `npx lastgreen why` para probar cuál es el culpable.',
  fetching: (n) => `Obteniendo ${n} ${n === 1 ? 'versión' : 'versiones'} de paquetes del último verde (en caché, con integridad verificada)...`,
  downloadingNode: (v) => `Descargando Node.js ${v} oficial (verificado con el SHA-256 de nodejs.org)...`,
  nothingTestable: 'Ninguno de estos cambios se puede revertir automáticamente.',
  lostFactors: (n) => `${n} cambio${n === 1 ? '' : 's'} no se ${n === 1 ? 'pudo' : 'pudieron'} devolver, así que no entra${n === 1 ? '' : 'n'} en la búsqueda:`,
  otherMachineEnv: (n) => `${n} variable${n === 1 ? '' : 's'} de entorno distinta${n === 1 ? '' : 's'} por ser otra máquina (no se comparan)`,
  bisecting: (n, cmd) => `Buscando al culpable entre ${n} cambio${n === 1 ? '' : 's'} con \`${cmd}\``,
  safety: 'node_modules se modifica temporalmente y se restaura al final, incluso con Ctrl+C o si algo se cae.',
  interrupted: 'lastgreen: interrumpido, node_modules restaurado.',
  pass: 'pasa',
  fail: 'falla',
  timedOut: 'tiempo agotado',
  cfgCurrent: 'entorno actual',
  cfgGreen: 'entorno del último verde',
  cfgOnly: (label) => `solo: ${label}`,
  cfgAllBut: (label) => `todo menos: ${label}`,
  cfgSome: (k, n) => `${k} de ${n} cambios`,
  culpritConfirmed: 'Culpable confirmado:',
  culpritsConfirmed: 'Culpables confirmados (solo fallan juntos):',
  culpritProbable: 'Culpable probable (sin confirmar):',
  confirmedHow: (cmd) => `deshacer solo esto hace que \`${cmd}\` pase; dejar solo esto lo hace fallar`,
  notConfirmedHow: 'deshacer solo esto sigue fallando: prueba inestable o más de una causa',
  errorWas: 'Fallo con este cambio:',
  whereBreaks: 'Dónde falla en tu código',
  howYouUseIt: (name) => `Cómo usa tu código ${name}`,
  whatChanged: (label, source) => `Qué cambió en ${label} (${source})`,
  'source.changelog': 'su CHANGELOG',
  'source.github': 'notas de versión en GitHub',
  notesAt: (name, url) => `Notas de versión de ${name}: ${url}`,
  requiredBy: (name, list) => `${name} está instalado por: ${list}`,
  whatChangedNode: (from, to) => `Qué quitó o cambió Node.js entre ${from} y ${to} (deprecaciones oficiales)`,
  nodeChangelogs: (from, to) => `Cambios de Node.js entre ${from} y ${to}:`,
  whereEnvRead: (name) => `Dónde lee tu código ${name}`,
  fixBack: 'para volver ya:',
  fixForwardLabel: 'o para avanzar:',
  fwdPackage: (loc, name, to) => `actualiza ${loc} para ${name} ${to} (mira qué cambió arriba)`,
  fwdPackageNoLoc: (name, to) => `adapta tu código a ${name} ${to} (mira qué cambió arriba)`,
  fwdNode: (loc, to) => `actualiza ${loc} para Node ${to} (mira el reemplazo arriba)`,
  fwdEnv: (loc, name) => `revisa ${loc}, donde se lee ${name}`,
  notInEnvScripts: (names) => `Pero ${names} necesita${names.includes(',') ? 'n' : ''} compilarse al instalarse y eso se saltó. Inténtalo compilando:`,
  scriptNote: (names) => `${names} tiene script de instalación y se probó sin recompilar. Para confirmarlo: npx lastgreen why --rebuild`,
  withItsDeps: (n) => `(+${n} dependencia${n === 1 ? '' : 's'} suya${n === 1 ? '' : 's'})`,
  pulls: (n, list) => `la versión nueva también trae ${n} cambio${n === 1 ? '' : 's'}: ${list}`,
  bringsBack: (n, list) => `deshacerlo también devuelve ${n} dependencia${n === 1 ? '' : 's'} que la versión vieja necesita: ${list}`,
  fix: 'Arreglo',
  notReproduced: 'Ahora pasa: el fallo no se reprodujo (prueba inestable, o algo ya lo arregló).',
  notInEnv: 'Devolver todo lo que puedo probar no lo arregla: la causa no está en el entorno comprobable.',
  budget: (n) => `Me detuve tras ${n} ejecuciones sin aislarlo (usa --max-runs para permitir más).`,
  restoreProblem: (list) => `no pude verificar la restauración de: ${list}. Corre \`npx lastgreen restore\` o reinstala.`,
  restoredOk: 'node_modules restaurado y verificado',
  runs: (n) => `${n} ${n === 1 ? 'ejecución' : 'ejecuciones'}`,
  codeChanged: 'Tu código también cambió',
  codeCommits: (n, from) => `${n} commit${n === 1 ? '' : 's'} desde ${from}`,
  codeFiles: (n) => `${n} archivo${n === 1 ? '' : 's'} sin commit`,
  tryGitBisect: 'Para buscar en los commits:',
  fixExplain: (cmd) => `mira quién lo trae: ${cmd}`,
  fixOverride: (field, pair) => `fíjalo en package.json "${field}": { ${pair} } y reinstala`,
  fixNodeUse: (cmd) => `${cmd}`,
  fixNodeInstall: (v) => `usa Node ${v}`,
  fixNodePin: (v) => `fíjalo para todos: echo ${v} > .nvmrc   (o actualiza el código que depende del comportamiento viejo)`,
  fixEnvUnset: (name) => `quita ${name} (bash: unset ${name} · PowerShell: Remove-Item Env:${name})`,
  fixEnvSet: (name, v) => `devuélvele su valor: ${name}=${JSON.stringify(v)}`,
  exportNoGreen: 'No hay verde guardado: exporto el entorno actual.',
  exported: (file) => `Guardado ${file} (sin valores secretos ni rutas locales).`,
  exportHint: 'Envíaselo a quien tenga la máquina donde falla. Esa persona corre:',
  logEmpty: 'Aún no hay huellas. Empieza con: npx lastgreen run -- npm test',
  green: 'verde',
  red: 'rojo',
  nothingToRestore: 'Nada que restaurar: ninguna búsqueda quedó interrumpida.',
  inside: 'dentro de',
  'kind.package': 'paquete',
  'kind.node': 'node',
  'kind.env': 'variable',
  'kind.tool': 'herramienta',
  'kind.file': 'archivo',
  'kind.system': 'sistema',
  'kind.code': 'código',
  'tag.major': 'mayor',
  'tag.minor': 'menor',
  'tag.patch': 'parche',
  'tag.prerelease': 'pre-release',
  'tag.other': 'versión',
  'tag.direct': 'dependencia directa',
  'tag.in-output': 'aparece en el error',
  'tag.install-script': 'tiene script de instalación',
  'tag.behavioural': 'afecta la ejecución',
  'tag.peers': 'cambiaron sus peer dependencies',
  'reason.pnpm': 'estructura de pnpm: por ahora solo diferencias',
  'reason.layout': 'cambió la estructura del gestor de paquetes',
  'reason.platform': 'paquete de otra plataforma',
  'reason.critical': 'variable del sistema',
  'reason.other-machine': 'otra máquina',
  'reason.value-not-stored': 'no guardo el valor viejo (podría ser un secreto)',
  'reason.tool': 'informativo',
  'reason.content-not-stored': 'no guardo su contenido',
  'reason.system': 'informativo',
  'reason.code': 'código fuente',
  'reason.node-download': 'no pude conseguir esa versión de Node',
  'reason.node-mismatch': 'no pude cambiar la versión de Node',
  'reason.fetch:offline': 'sin conexión',
  'reason.fetch:integrity': 'la integridad del paquete no coincide',
  'reason.fetch:local-package': 'paquete local',
  'reason.fetch:npm-pack': 'no pude descargar la versión vieja',
  'reason.fetch:unknown': 'no pude descargar la versión vieja',
  help: `lastgreen — git bisect para tu entorno

Recuerda el entorno de cada ejecución que pasa (paquetes instalados, versión de
Node, variables de entorno, configuración) y, cuando el mismo código empieza a
fallar, devuelve las piezas viejas una por una hasta encontrar el cambio que lo rompió.

Uso
  npx lastgreen run -- <comando>   corre tus pruebas; guarda una huella (verde o roja)
  npx lastgreen why                encuentra y confirma qué cambio las rompió
  npx lastgreen diff               lista lo que cambió desde el último verde, sin ejecutar
  npx lastgreen export [-o archivo]   comparte tu último verde con un compañero
  npx lastgreen why --against archivo   "en mi máquina sí funciona": compara con el suyo
  npx lastgreen log                lista las huellas guardadas
  npx lastgreen restore            restaura node_modules tras una búsqueda interrumpida
  npx lastgreen mcp                servidor MCP para agentes de IA (Claude Code, Codex, Cursor)

Opciones de why/diff
  -c, --command <cmd>   comando a repetir (por defecto: el del último verde)
  --against <archivo>   compara con una huella exportada en vez del último verde
  --max-runs <n>        rendirse tras n ejecuciones (60 por defecto)
  --timeout <segundos>  por ejecución (por defecto: 5x el verde, mínimo 120)
  --offline             no descargar paquetes ni versiones de Node
  --rebuild             ejecutar scripts de instalación (módulos nativos) de lo restaurado
  --show-output         mostrar el final de la salida de cada ejecución
  --json                resultado legible por máquinas en stdout (CI y agentes de IA)

Globales
  --lang en|es   idioma (también LASTGREEN_LANG)   --no-color   -v, --version   -h, --help`,
};

const dicts = { en, es };

function detect() {
  const pick = (v) => (v && /^es\b|^es[-_]/i.test(v) ? 'es' : v && /^en\b|^en[-_]/i.test(v) ? 'en' : null);
  const env = process.env;
  if (env.LASTGREEN_LANG) return pick(env.LASTGREEN_LANG) ?? 'en';
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const got = pick(v);
    if (got) return got;
  }
  try {
    return pick(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en';
  } catch {
    return 'en';
  }
}

let lang = detect();

export function setLang(value) {
  if (dicts[value]) lang = value;
}

export function getLang() {
  return lang;
}

export function t(key, ...args) {
  const value = dicts[lang][key] ?? en[key];
  if (typeof value === 'function') return value(...args);
  return value ?? key;
}

export function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  const unit = (n, enUnit, esUnit) => (lang === 'es' ? `hace ${n} ${esUnit}` : `${n} ${enUnit} ago`);
  if (s < 60) return lang === 'es' ? 'hace un momento' : 'just now';
  if (s < 3600) return unit(Math.round(s / 60), 'min', 'min');
  if (s < 86_400) return unit(Math.round(s / 3600), 'h', 'h');
  const d = Math.round(s / 86_400);
  return unit(d, d === 1 ? 'day' : 'days', d === 1 ? 'día' : 'días');
}

export function reasonText(f) {
  const base = t(`reason.${f.reason}`);
  return f.detail ? `${base}: ${f.detail}` : base;
}

/** One-line human label for a factor. */
export function factorLabel(f, { long = false, short = false } = {}) {
  const arrow = '→';
  if (short) return f.kind === 'node' ? 'Node' : f.name;
  switch (f.kind) {
    case 'package': {
      let label =
        f.change === 'changed' ? `${f.name} ${f.from} ${arrow} ${f.to}` : f.change === 'added' ? `+${f.name} ${f.to}` : `-${f.name} ${f.from}`;
      if (long && f.parent) label += ` (${t('inside')} ${f.parent})`;
      if (long && f.paths?.length > 1) label += ` (+${f.paths.length - 1})`;
      return label;
    }
    case 'node':
      return `Node ${f.from} ${arrow} ${f.to}`;
    case 'env': {
      const show = (v) => (v == null ? '' : JSON.stringify(v));
      if (f.change === 'added') return `+${f.name}${f.to != null ? `=${show(f.to)}` : ''}`;
      if (f.change === 'removed') return `-${f.name}${f.from != null ? ` (${show(f.from)})` : ''}`;
      return f.from != null && f.to != null && long ? `${f.name} ${show(f.from)} ${arrow} ${show(f.to)}` : `${f.name}`;
    }
    case 'tool':
      return `${f.name} ${f.from ?? '-'} ${arrow} ${f.to ?? '-'}`;
    case 'file':
      return `${f.name}${f.change === 'added' ? ' (+)' : f.change === 'removed' ? ' (-)' : ''}`;
    case 'system':
      return `${f.from} ${arrow} ${f.to}`;
    case 'code':
      return `git ${f.from?.slice(0, 7) ?? '?'} ${arrow} ${f.to?.slice(0, 7) ?? '?'}${f.fileCount ? ` +${f.fileCount}` : ''}`;
    default:
      return f.name;
  }
}
