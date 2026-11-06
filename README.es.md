# lastgreen

**`git bisect` para tu entorno.**

Ayer tus pruebas pasaban. Hoy fallan y no tocaste el código. Alguien corrió
`npm update`, un agente de IA instaló algo, se actualizó Node, apareció una
variable de entorno... `lastgreen` recuerda el entorno de cada ejecución que
pasa y, cuando el mismo código empieza a fallar, devuelve las piezas viejas una
por una hasta encontrar (y **confirmar**) el cambio que lo rompió.

> [Read in English](README.md)

```text
$ npx lastgreen why
Último verde  hace 2 h · npm test · 447 ms

13 cambios desde entonces
  paquete      chalk 4.1.2 → 5.3.0 (+5 dependencias suyas)  mayor, dependencia directa
  paquete      debug 4.3.4 → 4.4.0  menor, dependencia directa
  paquete      semver 7.5.4 → 7.6.3 (+2 dependencias suyas)  menor, dependencia directa
  paquete      ms 2.1.2 → 2.1.3  parche, dependencia directa

Buscando al culpable entre 11 cambios con `npm test`
  #1   ✗ falla      431 ms    entorno actual
  #2   ✓ pasa       443 ms    entorno del último verde
  #3   ✗ falla      449 ms    7 de 11 cambios
  #4   ✗ falla      442 ms    4 de 11 cambios
  #5   ✗ falla      438 ms    3 de 11 cambios
  #6   ✗ falla      446 ms    solo: chalk 4.1.2 → 5.3.0
  #7   ✓ pasa       435 ms    todo menos: chalk

✓ Culpable confirmado:
    chalk 4.1.2 → 5.3.0
    deshacerlo también devuelve 5 dependencias que la versión vieja necesita: ansi-styles, supports-color, color-convert, has-flag y 1 más
    deshacer solo esto hace que `npm test` pase; dejar solo esto lo hace fallar

    Fallo con este cambio:
      TypeError: chalk.green is not a function

Arreglo
    npm install --save-exact chalk@4.1.2

7 ejecuciones · 3.6 s · node_modules restaurado y verificado
```

Es una salida real, de un `npm install` real con paquetes reales del registro.

## Empezar

```bash
# 1. Una vez, mientras tus pruebas pasan (o siempre, mira abajo)
npx lastgreen run -- npm test

# 2. El día que se rompan
npx lastgreen why
```

Para guardar cada verde automáticamente, envuelve tu script de pruebas:

```json
{
  "scripts": { "test": "lastgreen run -- vitest run" },
  "devDependencies": { "lastgreen": "^0.1.0" }
}
```

`lastgreen run` deja pasar intactos la salida y el código de salida de tu
comando, y solo agrega una línea al final.

## Qué responde

| Tú dices | Comando |
| --- | --- |
| "Ayer funcionaba." | `lastgreen why` |
| "¿Qué cambió desde que pasó?" (sin ejecutar nada) | `lastgreen diff` |
| "En mi máquina sí funciona." | la otra persona corre `lastgreen export`; tú corres `lastgreen why --against lastgreen-export.json` |
| CI / agentes de IA | `lastgreen why --json` |

## Cómo funciona

1. **Una huella en cada ejecución.** `lastgreen run` registra lo que *de verdad*
   está instalado en `node_modules` (del lockfile oculto de npm, contrastado
   con el disco), la versión de Node que recibe tu comando, el gestor de
   paquetes, las variables de entorno que afectan la ejecución, archivos de
   configuración y el estado de git. Corre en paralelo con tu comando y tarda
   unos 60–180 ms (un proyecto de 200 paquetes da una huella de ~45 KB).
2. **Diferencias.** Cuando falla, `why` compara ahora contra el último verde y
   ordena sospechosos: saltos de versión mayor, dependencias directas y
   paquetes que aparecen en el error van primero.
3. **Delta debugging.** Vuelve a correr tu comando con partes del entorno viejo
   (algoritmo *ddmin* de Zeller y Hildebrandt), así que un culpable entre
   cientos de cambios se encuentra en pocas ejecuciones; si aparece en el
   mensaje de error, normalmente en 4.
4. **Entiende las dependencias.** Devolver `chalk@4` también devuelve el
   `ansi-styles` que necesita; dejar `debug@4.4` nuevo deja el `ms` que exige.
   Revisa los rangos semver para que cada configuración probada sea coherente.
5. **Confirmado en las dos direcciones.** Deshacer solo al culpable debe hacer
   que pase, y dejar solo al culpable debe hacer que falle. Si no, lo dice.

## Seguridad

- `node_modules` se modifica **temporalmente** y se restaura al final. Cada
  paso se anota en `.lastgreen/journal.json` *antes* de hacerlo: si pulsas
  Ctrl+C, se cae el proceso o se va la luz, el siguiente comando de lastgreen (o
  `lastgreen restore`) lo repara y verifica contra el disco.
- Las versiones viejas de paquetes se descargan como tarballs y se comprueban
  con el **hash de integridad que se registró al instalarlas**. Nunca se
  ejecutan scripts de instalación.
- Las versiones viejas de Node salen de tu gestor (nvm, nvm-windows, fnm, volta,
  mise, asdf, n) o de nodejs.org, **verificadas con los SHA-256 oficiales**.
- Tu código fuente nunca se toca.

## Privacidad

Las huellas se quedan en `.lastgreen/` (git las ignora automáticamente). Las
variables de entorno se guardan como un hash SHA-256 corto; solo se guarda el
valor de una lista corta de variables de comportamiento que no son secretas
(`NODE_OPTIONS`, `NODE_ENV`, `TZ`, `LANG`, `CI`...), y nunca de nada cuyo nombre
parezca un secreto. Los `.env` se resumen con hash, nunca se copian.
`lastgreen export` además quita rutas locales y la salida de las pruebas. No se
envía nada a ningún lado.

## Opciones

```text
lastgreen run -- <comando>         ejecuta y guarda una huella (verde o roja)
lastgreen why                      encuentra y confirma al culpable
lastgreen diff                     lista los cambios desde el último verde, sin ejecutar
lastgreen export [-o archivo]      comparte tu último verde
lastgreen log                      lista las huellas guardadas
lastgreen restore                  repara node_modules tras una búsqueda interrumpida

  -c, --command <cmd>   comando a repetir (por defecto: el del último verde)
  --against <archivo>   compara con una huella exportada
  --max-runs <n>        rendirse tras n ejecuciones (60 por defecto)
  --timeout <segundos>  por ejecución (por defecto: 5x el verde, mínimo 120)
  --offline             nunca descargar paquetes ni versiones de Node
  --rebuild             correr scripts de instalación (módulos nativos) de lo devuelto
  --show-output         mostrar el final de la salida de cada ejecución
  --json                resultado legible por máquinas en stdout
  --lang en|es          idioma (también LASTGREEN_LANG; se detecta solo)
```

Configuración opcional en `.lastgreenrc.json` o en la clave `"lastgreen"` de
`package.json`: `{ "command": "npm test", "ignoreEnv": ["MI_RUIDO_*"], "timeout": 300 }`.

## Soporte y límites (v0.1)

- **Busca al culpable en:** `node_modules` de npm (y estructuras planas: yarn
  classic, bun), versión de Node.js y variables de entorno. Windows, macOS y
  Linux, Node 20+.
- **Por ahora solo muestra diferencias de:** pnpm, Yarn PnP, versiones del
  gestor de paquetes, actualizaciones del sistema, contenido de `.env` y de
  configuración, y código fuente (para el código te da el comando `git bisect`).
- Los paquetes con scripts de instalación (módulos nativos) se cambian sin
  recompilar, salvo que uses `--rebuild`, que corre `npm rebuild` en los que
  se devuelven. `why` te avisa cuando eso importa.
- Necesita un comando de prueba que pase o falle de forma fiable. Las pruebas
  inestables aparecen como "sin confirmar".
- Las causas de fuera de la máquina (una API remota, la fecha) no se pueden
  devolver; en ese caso `why` te dice que la causa *no* es el entorno, y eso
  también es una respuesta.

## En CI

En GitHub Actions, `why` también escribe su informe en la página de resumen
del job. Para "falla en CI y en mi laptop no", guarda el verde de `main`:

```yaml
- run: npx lastgreen run -- npm test
- if: success() && github.ref == 'refs/heads/main'
  run: npx lastgreen export -o lastgreen-main.json
- if: success() && github.ref == 'refs/heads/main'
  uses: actions/upload-artifact@v4
  with: { name: lastgreen-main, path: lastgreen-main.json }
```

Luego, en cualquier máquina: `npx lastgreen why --against lastgreen-main.json`.

## Próximamente

- Búsqueda con pnpm y después Python (uv / pip)
- Hooks y servidor MCP para agentes de IA: "¿qué le cambió el agente a mi
  máquina?" y `why` como herramienta
- **lastgreen para equipos** (alojado, de pago para repos privados de
  organizaciones): el verde de `main` guardado por ti, un comentario en el PR
  con el culpable confirmado cuando CI se rompe sin cambios de código, y una
  vista de qué máquinas se alejaron de CI. Si tu equipo lo quiere,
  [avísanos aquí](https://github.com/MarioACo/lastgreen/issues/new?template=team-interest.yml).

## Licencia

[MIT](LICENSE). La CLI es y seguirá siendo gratis y de código abierto.
