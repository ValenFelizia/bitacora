# Verificación del issue #12

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
