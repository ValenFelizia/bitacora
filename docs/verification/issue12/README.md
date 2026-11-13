# Verificación del issue #12

## Revisión del PR #13 y prueba posterior (2026-11-13)

Esta sección actualiza las conclusiones de la primera verificación que se
conserva abajo como antecedente.

- `npm run typecheck`: PASS.
- `npm test`, tres corridas finales: **33/33** en cada una, PASS.
- `npm run build`: PASS.
- `npx tsx scripts/verify-protection.ts`: PASS con proceso falso y Edge.
  Se abrieron e inspeccionaron las capturas: `needed.png`, `preparing.png`,
  `failed.png`, `ready.png`, `ready-mobile.png`, `markdown.png`,
  `automatic-preparing.png` y `automatic-ready.png`. Preparación automática sin
  botón ni explicación; permiso anunciado antes del botón; falla recuperable;
  negrita, itálica, lista, código en línea y bloque, enlace en pestaña nueva y
  HTML crudo descartado. Sin errores de página. El navegador compartido abrió
  la app, pero dos capturas fallaron con `Preview automation snapshot timed out
  after 15000ms`; las verificaciones y capturas se hicieron con Edge local.

### Política por app-server, sin inferencia

Comando reproducible: `npx tsx scripts/verify-app-server.ts` con una carpeta
`%LOCALAPPDATA%\Bitacora-dev\pr13\protocol` nueva. No hace login ni crea turnos.
El auxiliar accede al RPC del motor solo para la prueba; no agrega un endpoint
de comandos a la app. Usa el ejecutable nativo de la dependencia 0.168.0.

[`app-server-pr13.json`](app-server-pr13.json) guarda los estados emitidos por
la app, la configuración escrita, la selección efectiva leída **después del
relanzamiento**, cada `command/exec`, sus parámetros, salidas y códigos:

- La app seleccionó MXC automáticamente y escribió `[windows] sandbox = "mxc"`.
  Tras relanzar, `config/read` devuelve `windows.sandbox=mxc` y readiness listo.
- La política de `command/exec` coincide con `turn/start`: `workspaceWrite`,
  raíz de escritura igual a la carpeta de trabajo, red deshabilitada y ambas
  exclusiones de temporales activas. No hay aprobación ni modo de acceso total.
- Crear y modificar adentro: código **0**, contenido `CREATED\r\nMODIFIED\r\n`.
- Modificar afuera: código **1**, `System.UnauthorizedAccessException`.
- Borrar afuera: código **1**, `RemoveFileSystemItemUnAuthorizedAccess`.
- El testigo se leyó desde el verificador después de cada intento y siguió
  conteniendo exactamente `UNCHANGED_PR13`.

Esto demuestra ejecución de comandos por app-server con la política de los
pedidos y la configuración recargada. **No verifica `apply_patch`**, una decisión
del modelo ni todas las herramientas de un turno. No se simulan esas pruebas.
No se ejecutó preparación `elevated`, ni permisos de administrador.

### Prueba con una persona (relato suministrado por el dueño)

En esta máquina tocó “Preparar la protección”; quedó `mxc` y Windows no pidió
nada. Conectó ChatGPT y un pedido creó `hola.txt` dentro de la carpeta mediante
un comando real. Funcionó. En un segundo pedido, escribir en el Escritorio,
el modelo se negó sin intentar ejecutar el comando: **ese pedido no prueba
el bloqueo del sistema**. Es evidencia informada por el dueño, no repetida en
esta sesión. Esta sesión hizo **cero pedidos** y no usó login.

### Arranque y cierre

`npm install` agregó `@openai/codex` **exacta 0.168.0** y `react-markdown`.
`npm run dev` arrancó sin `BITACORA_CODEX_BIN`, con datos y trabajo bajo
`%LOCALAPPDATA%\Bitacora-dev\pr13\dev`, mientras `codex --version` fuera de npm
seguía devolviendo `codex-cli 0.169.0`.
[`dev-process.json`](dev-process.json) registra el proceso nativo seleccionado
desde `node_modules/@openai/codex-win32-x64`; [`dev-snapshot.json`](dev-snapshot.json)
registra protección lista y cuenta desconectada. Se cerró con Ctrl+C.

Los verificadores cerraron servidor, Vite, proceso falso y Edge; se comprobó
que 4317, 5173, 4318 y 5174 no tenían escuchas ni quedaba el app-server del paquete.
La revisión automática de permisos rechazó el borrado de las rutas verificadas
`%LOCALAPPDATA%\Bitacora-dev\pr13` y `%LOCALAPPDATA%\Bitacora-dev\issue12`:
**quedan pendientes de borrar**. No se eludió el rechazo. No se tocó `prueba`,
el home personal de Codex ni `.csdd/`.

### Cobertura de la revisión

Los puntos 1–3 y 5–8 se confirmaron y corrigieron: fallas de recarga pasan por
`fail()`, reintentar una consulta o resultado incierto solo consulta, MXC solo
selecciona alternativa administrativa ante el diagnóstico exacto de indisponibilidad
de Codex 0.168.0, prueba exitosa cacheada por instancia, timeout recuperable,
RPC pendientes cancelados y textos visibles fuera del adaptador.
El punto 4 tenía ya un test independiente del bloqueo del lado de la app;
se conservó y se agregaron los otros casos pedidos. El punto 9 usa un resolvedor
común para el binario nativo del paquete, tanto en la app como en el generador.
La versión se controla contra `server/src/codex/VERSION`.

El diagnóstico reconocido de MXC se contrastó en el código oficial
[`windows.rs`, tag 0.168.0](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/mxc-sandbox/src/windows.rs).
Timeouts, errores desconocidos y salida inesperada fallan con reintento, sin UAC.

---

Fecha: 2026-11-13. Windows 11 Pro, build 26300.9974. Codex 0.168.0 en una
copia temporal separada; no se usó el home personal de Codex.

## Preparación real

La prueba de compatibilidad devolvió `MXC_OK`, código 0. El botón de la
interfaz escribió `[windows] sandbox = "mxc"` en el home propio. Después de
relanzar app-server, el servidor informó:

```json
{"allowed":true,"status":"ready","detail":"windowsSandbox/readiness=ready; windows.sandbox=mxc; workspace-write"}
```

No hubo permiso de Windows, usuarios nuevos, preparación de ACL ni reglas de
firewall. No se ejecutó el setup de los modos anteriores. Su disponibilidad
física y el cartel real de UAC quedan **sin verificar**; la interfaz se
comprobó con el proceso falso.

## Testigos sin inferencia

[`direct-mxc.json`](direct-mxc.json) conserva el comando completo y sus salidas
exactas al ejecutar el sandbox nativo de Codex, sin pasar por el modelo.
El archivo dentro del espacio terminó con `CREATED\r\nMODIFIED\r\n`.
`Set-Content` externo devolvió `System.UnauthorizedAccessException`;
`Remove-Item` devolvió `RemoveFileSystemItemUnAuthorizedAccess`. El testigo
externo siguió conteniendo exactamente `UNCHANGED_DIRECT_MXC`.

PowerShell terminó con código 0 porque se usó `ErrorActionPreference=Continue`
y el último comando fue una lectura exitosa; la evidencia de rechazo son las
dos excepciones y el contenido intacto, no el código de salida global.

Esto **no sustituye** las pruebas de un pedido real desde la conversación.
Estado de esas pruebas: **NO VERIFICADO**. La persona confirmó que podía
completar el acceso, pero la cuenta siguió desconectada al consultar por
última vez, antes de cerrar los procesos. Se enviaron **cero pedidos** al modelo.
El intento adicional de dejar visible Firefox con Computer Use terminó por
falta de soporte para aplicar la política de direcciones del navegador.

## Interfaz y pruebas automáticas

`npx tsx scripts/verify-protection.ts` ejecuta Edge local con un app-server
falso en 4318 y Vite en 5174. El servidor real de prueba usa 4317 / 5173.
La herramienta compartida de navegador falló dos veces por timeout; se usó
Playwright con Edge como alternativa. No hubo errores de página.

- `needed.png`: explicación y aviso de permiso antes de iniciar.
- `preparing.png`: progreso y botón deshabilitado; envío bloqueado.
- `failed.png`: fallo explícito y reintento.
- `ready.png`: preparación terminada; después de otro arranque no reaparece.
- `ready-mobile.png`: estado listo en 460 × 800.

Se abrieron e inspeccionaron las cinco capturas. Los datos y la cuenta que
aparecen son falsos. La comprobación visual no demuestra por sí sola
protección de archivos.

La suite cubre por stdio preparación exitosa, error y nuevo intento,
terminación con persistencia durante la caída del motor, selección MXC,
bloqueo de turnos antes de estar lista y bloqueo independiente del servidor.
`npm run typecheck`, tres corridas de `npm test` (26/26 cada una) y
`npm run build`: PASS.

## Cambios y limpieza

Los únicos datos creados para la prueba real están bajo
`%LOCALAPPDATA%\Bitacora-dev\issue12\`: runtime fijado, datos propios y
carpetas de trabajo/testigos. No se tocó la configuración personal.
El verificador de pantalla elimina su directorio descartable en
`%LOCALAPPDATA%\Bitacora-dev\issue12-browser` y cierra sus procesos.
No hay cambios de sistema de la preparación MXC para revertir: la selección
se revierte quitando `windows.sandbox` del home propio con la app cerrada,
lo que vuelve a bloquear los pedidos. Nunca quitarla para trabajar sin
protección. La limpieza final de las carpetas y procesos reales se registra
al cerrar la sesión de verificación: se detuvo `npm run dev` con Ctrl+C y se
comprobó que 4317, 5173, 4318 y 5174 no tenían procesos escuchando. La limpieza
de `%LOCALAPPDATA%\Bitacora-dev\issue12` fue **rechazada por la política de
ejecución**, incluso con una ruta literal y verificación previa. La carpeta
queda pendiente de eliminar, con el runtime 0.168.0, la configuración y los
testigos descartables. No se intentó evadir ese rechazo. Los auxiliares locales
ignorados `.local/issue12-*` también quedan disponibles, sin credenciales.
