# Verificación del issue #16

Fecha: 2026-11-13. Base: `7b120b6`. Sin login, sin pedidos a ChatGPT, sin administrador, sin acceso total. No se usó el Codex personal ni la carpeta de prueba prohibida.

## Aislamiento real

`npx tsx scripts/verify-loopback.ts`: Codex CLI 0.168.0 fijado, CODEX_HOME desechable propio, MXC confirmado mediante `config/read`, `command/exec` con la misma política `workspaceWrite` de los pedidos (red desactivada y temporales excluidos). Listeners IPv4 e IPv6 en puerto efímero 63890. Las tres conexiones de control desde el host funcionaron. Dentro de MXC:

| Destino | Resultado |
| --- | --- |
| 127.0.0.1 | exit 1, SocketException: forbidden by its access permissions |
| localhost | exit 1, SocketException: forbidden by its access permissions |
| [::1] | exit 1, SocketException: forbidden by its access permissions |

Cero conexiones aceptadas dentro del aislamiento. Cero turnos de modelo. Comandos exactos, política y salidas completas en [loopback.json](loopback.json).
Comentario solicitado: https://github.com/ValenFelizia/bitacora/issues/16#issuecomment-6866223257.
La observación sólo corresponde a este Windows, versión y modo; no demuestra que todos los modos/versiones bloqueen loopback.

## Autenticación y navegador

`npx tsx scripts/verify-session-browser.ts`: PASS con Edge 157.0.4341.46 y motor falso. Entrar por fragmento de un uso, URL final sin código, cookie HttpOnly de sesión SameSite=Strict, JavaScript sin acceso a cookie, localStorage/sessionStorage vacíos; recarga y segunda pestaña autenticadas. Reiniciar invalida ambas pestañas, que muestran el mensaje para volver a entrar. Entrada anterior rechazada; entrada nueva aceptada. Cero errores JavaScript. [Resultados](browser.json).

Capturas: [entrada](entry.png), [recarga](reload.png), [segunda pestaña](second-tab.png), [reinicio](restart.png), [entrada anterior](used-entry.png), [nuevo ingreso](reentered.png). Se inspeccionaron visualmente entrada y reinicio.
La vista compartida de T3 agotó dos veces el plazo al capturar; la evidencia de navegador es de Edge automatizado, no de esa vista.

## Pruebas automáticas

- `npm run typecheck`: PASS.
- `npm test`, tres corridas consecutivas: 51/51 PASS en cada una.
- `npm run build`: PASS.
- Rechazo de WebSocket con Host/Origin correctos sin cookie y con secreto incorrecto; controles Host/Origin también con cookie válida.
- Entrada no reutilizable ni vencida (reloj controlado en prueba), comparación constante de 32 bytes, archivos sin autenticación rechazados, cookie anterior rechazada tras reiniciar.
- Se escribe un pedido sintético en works.json: ni secreto ni código en datos ni impresiones del servidor; snapshots sin fileToken. No queda un segundo token para archivos.
- `scripts/verify-files-browser.ts`: PASS, incluye descarga exacta, PDF, portapapeles, adjuntos y galería.
- `scripts/verify-protection.ts`: PASS con proceso falso, incluye preparación, falla, reintento y reinicio.

## Garantía y límites

Ver el [modelo de amenaza del README](../../../README.md#acceso-local-y-l%C3%ADmites-de-protecci%C3%B3n-issue-16). Se impide suplantar a la pantalla sólo falsificando cabeceras. Bitácora conserva el secreto exclusivamente en memoria y la cookie HTTP; no lo persiste en sus archivos ni lo entrega a JavaScript. El navegador puede persistir cookies de sesión: no hay garantía completa frente a lectura arbitraria del disco. No se inspeccionó la base personal de cookies ni se verificó que su cifrado impida al agente leerla. No se promete que el fragmento nunca se haya capturado antes de borrarse del historial normal. Si el código se filtra antes del canje, el primero que lo use obtiene acceso. Tauri #9 podría separar la credencial de disco mediante entrega privada en memoria; no se implementó ni se verificó acá.

No hubo inferencia, ensayo de exfiltración ni instalador Tauri. No se cambiaron `.csdd/`, kit, copias ni deshacer.

## Cierre y limpieza

Los scripts anteriores `verify-browser.ts` y `verify-round2-browser.ts` también pasaron, con Vite administrado por un envoltorio de prueba. Se ajustaron para entrar con el código de un uso, esperar su redirección y usar datos internos desechables; la prueba genérica fuerza una sonda falsa para no depender del MXC real al simular falta de protección. Sus capturas regeneradas se descartaron para preservar la evidencia anterior.

Los servidores y navegadores iniciados por las pruebas se cerraron; no hay listeners de prueba en 4317 ni 5173. La limpieza normal eliminó los datos de las corridas exitosas y del ensayo MXC. El entorno rechazó por política el borrado posterior de dos carpetas dejadas por intentos fallidos: `.local/issue16-browser-CROiWJ` y `.local/issue5-browser-OAYAwA`. Se dejaron intactas dentro del repo, ignoradas por Git. También quedan los auxiliares internos `.local/verify-legacy.ts` y `.local/issue16-comment.md`. No se dejaron temporales propios fuera del repo. No se modificaron las carpetas ignoradas preexistentes.
