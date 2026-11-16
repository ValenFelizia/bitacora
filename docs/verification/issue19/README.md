# Issue #19 — Bloqueo de lecturas fuera de la carpeta

Verificación hecha con Codex CLI 0.168.0 (la versión fijada en `package.json`),
Windows 11 (10.0.26300), MXC, sin login y sin ningún pedido a ChatGPT.

## Qué se comprobó contra el binario instalado

Los nombres de los campos salen del esquema experimental del binario, no de la
memoria:

```text
node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe \
  app-server generate-ts --experimental --out .local/schema-exp
```

- `thread/start` y `thread/resume` aceptan `permissions: string` (id de un perfil
  con nombre). No se pueden combinar con `sandbox`.
- `turn/start` acepta `permissions: string`. No se puede combinar con
  `sandboxPolicy`: el app-server responde `-32600` con
  `` `permissions` cannot be combined with `sandboxPolicy` ``.
- `command/exec` acepta `permissionProfile: string`.
- `permissionProfile/list` devuelve `{ data: [{ id, description, allowed }] }`.
- `thread/start` devuelve `activePermissionProfile: { id, extends }`.
- Todo lo anterior exige `initialize` con `capabilities.experimentalApi: true`.
  Sin esa capacidad, `command/exec` con `permissionProfile` devuelve `-32600`
  (evidencia del issue #4).

## Cómo se define el perfil

El perfil se pasa al app-server con `-c` en la línea de comandos, como una tabla
TOML en línea, así no se toca el `config.toml` de la usuaria:

```text
-c 'default_permissions="agencia"'
-c 'permissions.agencia={extends=":workspace",filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"},network={enabled=false}}'
```

Sin `default_permissions` el binario se niega a arrancar:
`config defines [permissions] profiles but does not set default_permissions`.

## Prueba de arena real

`server/test/read-block.test.ts` (solo Windows) arranca el binario real con ese
perfil y comprueba, para cada backend que la máquina pueda correr (`mxc` y
`elevated`; si uno no está listo, el test lo saltea con el motivo):

- `permissionProfile/list` incluye `agencia` con `allowed: true`.
- `thread/start` devuelve `activePermissionProfile.id = "agencia"`.
- `command/exec` con PowerShell puede leer `agencia/inside.txt`, puede escribir
  `agencia/escrito.txt` y **no** puede leer `outside.txt` (exit 1,
  `Access to the path ... is denied`).

Salida: [read-block-tests.txt](read-block-tests.txt).

## Cómo se comprueba que el perfil se puede aplicar

Que el perfil figure en `permissionProfile/list` no alcanza: dice que existe, no
que esta compu pueda correrlo. Por eso, en una compu con MXC, la app corre un
comando inofensivo con el perfil (`cmd /d /c echo BITACORA_PROFILE_OK` por
`command/exec`) antes de habilitar pedidos. Si falla, no trabaja y lo dice.

Con `windows.sandbox=elevated` ese comando falla con
`elevated Windows sandbox requires effective `:root` read access`: el backend
"elevated" no acepta un perfil que niegue la lectura de `:root`. En esta compu
además `windowsSandbox/readiness` para `elevated` da `updateRequired`, así que
ese backend no se pudo probar sin el setup con permisos de administrador.

## Qué pasa en una compu sin MXC

Decisión de la dueña (2026-11-16, DEC-010): en una compu sin MXC la app trabaja
con la protección de escritura anterior y avisa, en vez de negarse a trabajar.

- El modo lo decide la comprobación de arranque: `windows.sandbox=elevated` con
  `windowsSandbox/readiness=ready` y el sondeo de MXC en falso es el modo sin
  MXC; `windows.sandbox=mxc` con el sondeo en verde es el modo con perfil.
- El sondeo de MXC corre también cuando el modo guardado es `elevated`: una
  compu que gana MXC con una actualización de Windows pasa sola al perfil, en
  vez de quedarse leyendo todo el disco por un ajuste viejo. Si el sondeo no
  puede responder y el modo guardado ya funciona, la app se queda con él y
  avisa.
- En el modo sin MXC el app-server no arranca con el perfil: los argumentos `-c`
  no llevan `default_permissions` ni `permissions.agencia`, porque el backend
  "elevated" rechaza ese perfil y, al ser el default, todo comando fallaría. Si
  el proceso se abrió con el perfil, el motor lo detiene y lo vuelve a abrir sin
  él antes de habilitar pedidos.
- Lo mismo vale para cualquier camino que decida el modo, no solo el arranque:
  el reintento después de una comprobación fallida, el setup de Windows que
  termina tarde y la recarga de la protección. Ninguno deja `allowed: true`
  sobre un proceso abierto con los argumentos del otro modo: primero se lo
  reemplaza, y el proceso nuevo se comprueba de nuevo antes de trabajar.
- Cada `thread/start` y `thread/resume` manda `sandbox: "workspace-write"` y cada
  `turn/start` manda `sandboxPolicy` workspaceWrite con `writableRoots` la
  carpeta, `networkAccess: false`, `excludeTmpdirEnvVar: true` y
  `excludeSlashTmp: true`: lo mismo que antes del issue #19.
- `executionSafety()` queda `allowed: true`, `status: "ready"` y
  `readBlock: false`, y la UI muestra el aviso: «En esta compu no puedo impedir
  que el agente lea archivos fuera de tu carpeta. Igual no puede cambiarlos ni
  borrarlos.»
- En una compu con MXC no cambia nada: el perfil es obligatorio y, si no se
  puede aplicar, la app no trabaja.

La prueba de arena real cubre ese arranque: con `windows.sandbox=elevated`
guardado y el sondeo de MXC en falso, el motor reinicia el app-server sin el
perfil y llega a la comprobación. En esta compu pide el setup de Windows; en una
donde `elevated` esté listo, arranca el trabajo con la protección de escritura.

## Límites verificados

- Codex lee los `AGENTS.md` desde la raíz del repositorio git. Si la carpeta de
  la agencia está dentro de un repo, el perfil tiene que dejar leer las carpetas
  superiores hasta esa raíz; con `:root = deny` el `thread/start` falla con
  `failed to load AGENTS.md instructions ... Access is denied`. Fuera de un repo
  no se lee nada por encima de la carpeta (probado en `%TEMP%`, en
  `%USERPROFILE%` y en `%APPDATA%`).
- Apagar esa lectura con `project_doc_max_bytes = 0` hace funcionar el perfil en
  cualquier ruta, pero deja al agente sin las instrucciones del kit, así que no
  se usa.
- `:minimal` mantiene lecturas del runtime; no certifica aislamiento literal de
  toda lectura exterior (ya anotado en el issue #4).

## Pendiente

- Un pedido real del agente (necesita la cuota de ChatGPT, que vuelve el 18 de
  noviembre). Es el único ítem del issue que queda sin marcar.
