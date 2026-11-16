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
que esta compu pueda correrlo. Por eso la app corre un comando inofensivo con el
perfil (`cmd /d /c echo BITACORA_PROFILE_OK` por `command/exec`) antes de
habilitar pedidos. Si falla, no trabaja y lo dice.

Con `windows.sandbox=elevated` ese comando falla con
`elevated Windows sandbox requires effective `:root` read access`: el backend
"elevated" no acepta un perfil que niegue la lectura de `:root`. En esta compu
además `windowsSandbox/readiness` para `elevated` da `updateRequired`, así que
ese backend no se pudo probar sin el setup con permisos de administrador.

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
