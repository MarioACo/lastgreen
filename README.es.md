<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img alt="lastgreen" src="assets/logo-light.svg" width="380">
</picture>

### `git bisect` para tu entorno

Ayer tus pruebas pasaban. Hoy fallan y nadie tocó el código.<br>
lastgreen encuentra la dependencia, la versión de Node o la variable que las rompió, **lo demuestra**<br>
y te muestra la línea que debes cambiar.

[![CI](https://github.com/MarioACo/lastgreen/actions/workflows/ci.yml/badge.svg)](https://github.com/MarioACo/lastgreen/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/lastgreen?color=2da44e&label=npm)](https://www.npmjs.com/package/lastgreen)
[![node](https://img.shields.io/badge/node-%E2%89%A516-2da44e)](#soporte)
[![dependencias](https://img.shields.io/badge/dependencias-0-2da44e)](package.json)
[![licencia](https://img.shields.io/badge/licencia-MIT-2da44e)](LICENSE)

[Empezar](#empezar) · [Cómo funciona](#cómo-funciona) · [CI](#en-ci) · [Agentes de IA](#agentes-de-ia-mcp) · [Equipos](#lastgreen-para-equipos) · [English](README.md)

<img src="assets/demo.svg" alt="lastgreen why: 13 cambios tras un npm install, 7 ejecuciones, culpable confirmado: chalk 4.1.2 → 5.3.0" width="900">

<sub>Una sesión real, resumida: paquetes reales del registro de npm, salida real.</sub>

</div>

## El problema

El código que no cambió empieza a fallar porque cambió algo *alrededor*:

- alguien corrió `npm update`, o un rango `^` agarró un parche nuevo
- CI pasó a otra versión de Node.js, o alguien del equipo usa otra
- un agente de IA instaló un paquete o puso una variable mientras "arreglaba" otra cosa
- un `.env`, `NODE_OPTIONS` o `TZ` es distinto en esa máquina

Lo normal es perder una tarde leyendo diffs del lockfile, reinstalando y
preguntando "¿a ti te funciona?" en Slack. lastgreen hace el experimento por ti.

## Empezar

```bash
npx lastgreen init --ci   # una vez: guarda cada verde y agrega el workflow de CI
npm test                  # como siempre; los verdes se recuerdan
npx lastgreen why         # el día que se rompan
```

`init` envuelve tu script de pruebas (`"test": "lastgreen run -- \"vitest run\""`),
agrega lastgreen como devDependency, escribe `.github/workflows/lastgreen.yml` y
te muestra cómo conectar tu agente de IA. ¿Prefieres no configurar nada? Basta con
correr `npx lastgreen run -- npm test` una vez mientras las pruebas pasan.
`lastgreen run` deja pasar intactos la salida y el código de salida de tu comando,
y solo agrega una línea al final.

¿Ya está roto y no guardaste un verde? `npx lastgreen why --from-git` usa el
lockfile npm de `HEAD` si tiene cambios sin commit; si no, usa `HEAD^`. También
puedes elegir un commit, rama o tag: `npx lastgreen why --from-git main`.

| Tú dices | Tú corres |
| --- | --- |
| "Ayer funcionaba." | `lastgreen why` |
| "¿Qué cambió desde que pasó?" (sin ejecutar nada) | `lastgreen diff` |
| "En mi máquina sí funciona." | la otra persona corre `lastgreen export`; tú, `lastgreen why --against lastgreen-export.json` |
| "CI está en rojo y nadie cambió nada." | la [GitHub Action](#en-ci) |
| "El PR de Dependabot / Renovate está en rojo." | la [GitHub Action](#con-dependabot-y-renovate): qué actualización, qué línea, qué nota de versión |
| "Solo falla a veces." | `lastgreen why --repeat 3` |
| "El proyecto es Node 18 y yo estoy en 22." | `lastgreen why`: usa `.nvmrc` / `engines`, aunque no haya verde guardado |
| "Agente, ¿por qué se rompieron las pruebas?" | el [servidor MCP](#agentes-de-ia-mcp) |

## Cómo funciona

1. **Una huella en cada ejecución.** `lastgreen run` registra lo que *de verdad*
   está instalado (el lockfile oculto de npm contrastado con el disco, o el grafo
   de enlaces de pnpm), la versión de Node que recibe tu comando, el gestor de
   paquetes, las variables que afectan la ejecución, archivos de configuración y
   el estado de git. Corre en paralelo con tu comando y tarda 60–180 ms.
2. **Diferencias ordenadas.** Cuando falla, `why` compara ahora con el último
   verde. Los saltos de versión mayor, las dependencias directas y los paquetes
   que aparecen en el error van primero.
3. **Delta debugging.** Vuelve a correr tu comando con partes del entorno viejo
   (algoritmo *ddmin* de Zeller y Hildebrandt), así que un culpable entre cientos
   de cambios se encuentra en pocas ejecuciones: 7 para los 13 cambios de arriba.
4. **Entiende las dependencias.** Devolver `chalk@4` también devuelve el
   `ansi-styles` que necesita; dejar `debug@4.4` deja el `ms` que exige. Revisa
   los rangos semver para que cada combinación probada sea una que npm o pnpm
   pudieron haber instalado.
5. **Demostrado en las dos direcciones.** Deshacer solo al culpable debe hacer
   que pase, y dejar solo al culpable debe hacer que falle. Si no, lo dice en vez
   de adivinar.
6. **Qué cambiar, no solo qué fijar.** Te muestra la línea donde falla tu código
   y la línea que importa el paquete. Luego te dice qué cambió en el paquete,
   leído de su CHANGELOG o de sus notas de versión en GitHub, con primero las
   notas que coinciden con tu error. Para Node.js muestra la deprecación oficial
   (código DEP, reemplazo y codemod automático si existe). Recibes dos arreglos:
   volver ya o avanzar.

```text
  Dónde falla en tu código
    src/report.js:7  const byDay = _.groupBy(valid, (o) => format(o.date, 'yyyy-MM-dd'));

  Cómo usa tu código date-fns
    src/report.js:1  const format = require('date-fns/format');

  Qué cambió en date-fns 2.30.0 → 3.6.0 (su CHANGELOG)
    3.0.0  ⚠ BREAKING: Now all file content's exported via named exports instead of
             `export default`, which will require change direct imports i.e.
             `const addDays = require('date-fns/addDays')` to `const { addDays } = require(...)`

Arreglo
    para volver ya:     npm install --save-exact date-fns@2.30.0
    o para avanzar:     actualiza src/report.js:7 para date-fns 3.6.0
```

<sub>Salida real de un proyecto con vitest después de un `npm update` que cambió 61 paquetes (6 ejecuciones, 30 s).</sub>

## ¿Por qué no simplemente…

- **…`git bisect`?** Busca en commits. Aquí ningún commit es malo: el código es el
  mismo y lo que se movió fue el entorno. lastgreen te avisa cuando *sí* es el
  código y te da el comando `git bisect` exacto.
- **…revisar el diff del lockfile?** Te da 200 líneas cambiadas y ninguna
  respuesta. ¿Cuál importa, y revertirla de verdad lo arregla?
- **…preguntarle a mi agente de IA?** Lee el error y adivina. lastgreen hace el
  experimento y lo confirma. Mejor aún: dale lastgreen al agente como
  [herramienta](#agentes-de-ia-mcp). Con el culpable confirmado, la línea que
  falla y la nota del cambio incompatible, el agente hace el arreglo correcto y
  no solo uno que parece correcto.
- **…usar Docker o Nix para que nada se mueva?** Excelente si puedes. La mayoría
  de los proyectos no pueden fijarlo todo, y aun así las imágenes de CI y las
  versiones de Node cambian.

## En CI

La GitHub Action guarda la huella verde de tu rama principal. Cuando una
ejecución falla, compara contra ella, encuentra al culpable y escribe el informe
en el resumen del job.

```yaml
permissions:
  contents: read
  actions: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - uses: MarioACo/lastgreen@v0
        with:
          command: npm test
```

El job falla exactamente cuando fallan tus pruebas. Salidas: `result` (`green`,
`found`, `not-in-env`…) y `exit-code`. Fuera de GitHub, `npx lastgreen why
--json` da el mismo resultado en JSON.

## Con Dependabot y Renovate

Los PRs de actualización son donde el entorno cambia a propósito, y donde más se
rompe. Con la Action en el workflow (`npx lastgreen init --ci` la agrega), un PR
de actualización en rojo se compara con el verde de tu rama principal:

- **Una actualización:** la confirma, con la línea de tu código que hay que
  cambiar y la nota de la versión que lo explica.
- **Un PR agrupado de Renovate** (cinco actualizaciones juntas): te dice cuál
  rompió el build, para que puedas aceptar las otras cuatro.
- **Dos actualizaciones que solo fallan juntas:** lo dice, en vez de culpar a una.

No necesita secretos: la Action solo lee el artefacto del verde (`actions: read`),
así que funciona tal cual en los PRs de Dependabot.

<sub>Ejemplo real: una actualización estilo Dependabot de `date-fns` 2 → 3 en un proyecto con vitest, corrida como en CI (`npm ci` y los pasos de la Action). Culpable confirmado en 5 ejecuciones, con `src/report.js:7`, la línea `require('date-fns/format')` y la nota del changelog sobre los imports con nombre, todo en el resumen del job.</sub>

## Agentes de IA (MCP)

`lastgreen mcp` es un servidor de [Model Context Protocol](https://modelcontextprotocol.io)
con tres herramientas: `lastgreen_record`, `lastgreen_diff` y `lastgreen_why`.
Tu agente deja de adivinar a partir del stack trace y recibe un culpable
confirmado con el comando exacto para arreglarlo.

```bash
# Claude Code
claude mcp add lastgreen -- npx -y lastgreen mcp
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.lastgreen]
command = "npx"
args = ["-y", "lastgreen", "mcp"]
```

```json
// Cursor: .cursor/mcp.json
{ "mcpServers": { "lastgreen": { "command": "npx", "args": ["-y", "lastgreen", "mcp"] } } }
```

## Seguridad

- **Tu código nunca se toca.**
- **`node_modules` siempre se restaura.** Cada cambio se anota en
  `.lastgreen/journal.json` *antes* de hacerlo. Si pulsas Ctrl+C, el proceso se
  cae o se va la luz, el siguiente comando de lastgreen (o `lastgreen restore`)
  lo repara y lo verifica contra el disco. Probado con un Ctrl+C real en Windows
  y con el proceso matado en los tres sistemas.
- **Descargas verificadas.** Las versiones viejas de paquetes se comprueban con
  el hash de integridad que se registró al instalarlas. Las versiones viejas de
  Node salen de tu gestor (nvm, nvm-windows, fnm, volta, mise, asdf, n) o de
  nodejs.org, comprobadas con los SHA-256 oficiales.
- **No se ejecutan scripts de instalación**, salvo que uses `--rebuild` (para
  módulos nativos).

## Privacidad

Las huellas se quedan en `.lastgreen/`, que git ignora automáticamente. No se
envía nada de tu proyecto a ningún lado: lastgreen solo descarga datos públicos
(versiones viejas de paquetes desde tu registro, versiones de Node.js, notas de
versión de GitHub y la lista de deprecaciones de Node), y `--offline` lo apaga
todo. Las variables de entorno se guardan como un hash
SHA-256 corto; solo se guarda el valor de una lista corta de variables de
comportamiento que no son secretas (`NODE_OPTIONS`, `NODE_ENV`, `TZ`, `LANG`,
`CI`…), y nunca de nada cuyo nombre parezca un secreto. Los `.env` se resumen
con hash, nunca se copian. `lastgreen export` además quita rutas locales y la
salida de las pruebas.

## Soporte

| | Encuentra al culpable | Notas |
| --- | :---: | --- |
| npm | ✅ | probado con el registro real |
| pnpm | ✅ | probado con el registro real, incluso versiones que pnpm ya borró |
| yarn classic, bun | ✅ | `node_modules` plano; menos probado |
| Yarn Plug'n'Play | — | solo diferencias |
| Versión de Node.js | ✅ | descarga y verifica versiones viejas si hace falta; `.nvmrc`, `.node-version`, `.tool-versions`, Volta y `engines` cuentan como la versión esperada |
| Variables de entorno | ✅ | cuando el valor viejo no es secreto, o la variable es nueva |
| Gestor de paquetes, sistema, `.env` / configuración, código fuente | — | aparecen en las diferencias; para el código te da el comando `git bisect` |

Windows, macOS y Linux, Node.js 16+. Cero dependencias. Inglés y español
(automático, o `--lang`).

Pruebas inestables: con `--repeat 3` cada configuración se corre tres veces, y
si los resultados no coinciden se reporta como inestable en vez de culpar al
entorno. Las causas de fuera de la máquina (una
API remota, la fecha) no se pueden devolver; en ese caso `why` te dice que la
causa *no* es el entorno, y eso también es una respuesta.

<details>
<summary><b>Todos los comandos y opciones</b></summary>

```text
lastgreen init [--ci]          configúralo: envuelve las pruebas, agrega el workflow de CI, muestra MCP
                               (--no-install, --dry-run)
lastgreen run -- <comando>     ejecuta y guarda una huella (verde o roja)
lastgreen why                  encuentra y confirma al culpable
lastgreen why --from-git [ref] usa un lockfile npm de Git si no guardaste un verde
lastgreen diff                 lista los cambios desde el último verde, sin ejecutar
lastgreen export [-o archivo]  comparte tu último verde
lastgreen log                  lista las huellas guardadas
lastgreen restore              repara node_modules tras una búsqueda interrumpida
lastgreen mcp                  servidor MCP para agentes de IA

  -c, --command <cmd>   comando a repetir (por defecto: el del último verde)
  --against <archivo>   compara con una huella exportada
  --from-git [ref]      usa el lockfile npm de Git (HEAD si cambió; si no, HEAD^)
  --max-runs <n>        rendirse tras n ejecuciones (60 por defecto)
  --timeout <segundos>  por ejecución (por defecto: 5x el verde, mínimo 120)
  --offline             nunca descargar paquetes ni versiones de Node
  --rebuild             correr scripts de instalación (módulos nativos) de lo devuelto
  --repeat <n>          correr cada configuración n veces; si no coinciden, es inestable
  --node <versión>      comparar con otra versión de Node.js (18, lts/hydrogen, ^20)
  --show-output         mostrar el final de la salida de cada ejecución
  --json                resultado legible por máquinas en stdout
  --lang en|es          idioma (también LASTGREEN_LANG; se detecta solo)
```

Configuración opcional en `.lastgreenrc.json` o en la clave `"lastgreen"` de
`package.json`:

```json
{ "command": "npm test", "ignoreEnv": ["MI_RUIDO_*"], "timeout": 300, "repeat": 2 }
```

</details>

## lastgreen para equipos

La CLI, la GitHub Action y el servidor MCP son gratis y MIT, para siempre. Una
persona sola tiene todo lo que necesita.

Un equipo tiene problemas que una persona sola no tiene: diez laptops y un CI que
se van separando, el mismo cambio incompatible pegándole a cinco repos, y nadie
sabe cuánto cuesta todo eso. Para eso es la versión alojada:

- **Detenerlo antes de que se rompa.** Las laptops y los runners de CI reportan
  su huella (opcional). Ves quién está en otra versión de Node, a quién se le
  desincronizó `node_modules` del lockfile y qué actualización está por llegar,
  antes de que alguien pierda la tarde.
- **Arreglarlo una vez para todos los repos.** Cuando se confirma que una
  actualización rompe algo, se avisa a cada repo que usa ese paquete, con la
  línea que hay que cambiar y la nota de la versión.
- **La respuesta dentro del pull request.** Cuando CI se pone en rojo sin cambios
  de código, el culpable confirmado, la línea que falla y los dos arreglos
  aparecen como comentario. Nadie tiene que correr nada.
- **Saber cuánto cuesta.** Un reporte mensual: cuántas veces el entorno rompió el
  build, cuánto tardaron en arreglarlo y cuánto tiempo ahorró lastgreen.

**Ejemplo:** 10 desarrolladores. El entorno rompe el build dos veces al mes y
encontrar la causa toma 2 horas cada vez: 4 horas de desarrollo al mes, cada mes.
lastgreen Team para esas 10 personas: 80 dólares al mes.

Gratis para código abierto y personas. Para repos privados de organizaciones el
plan es de **8 dólares por committer activo al mes** (contado como GitHub:
quienes subieron commits en los últimos 90 días). Los equipos de acceso
anticipado lo usan gratis durante la beta.

**[→ Pide acceso anticipado](https://github.com/MarioACo/lastgreen/issues/new?template=team-interest.yml)**

## Próximamente

- [x] npm, pnpm, versiones de Node.js, variables de entorno
- [x] GitHub Action, servidor MCP, `--json`
- [x] `lastgreen init`, pruebas inestables (`--repeat`), PRs de Dependabot y Renovate
- [x] Node.js 16+, la versión de Node declarada como base, `--node`
- [ ] Python (uv, pip) y reproducción solo con el lockfile en CI
- [ ] "¿Qué le cambió el agente a mi máquina?": huellas antes y después de cada sesión de un agente de IA
- [ ] lastgreen para equipos (alojado)

## Contribuir

Los issues y pull requests son bienvenidos. Mira [CONTRIBUTING.md](CONTRIBUTING.md).
Para reportar un problema de seguridad, mira [SECURITY.md](SECURITY.md).

## Licencia

[MIT](LICENSE) © MarioACo
