# Bitácora

Nombre provisorio. App de escritorio para que una agencia de turismo arme y use
su propio entorno de trabajo con agentes, usando la suscripción de ChatGPT que
ya paga. Pensada para personas no técnicas.

Estado: esqueleto local para Windows. Todavía no hay instalador.

## Desarrollo

Requiere Node.js 22 o posterior y npm. `npm install` instala **Codex CLI 0.168.0**
como dependencia de desarrollo exacta. La app y el generador de tipos usan su
ejecutable nativo, independientemente del Codex del PATH. `BITACORA_CODEX_BIN`
permite seleccionar otra copia, que debe tener esa misma versión.

```powershell
npm install
npm run dev
```

Abrí http://127.0.0.1:5173 o http://localhost:5173, tocá **Conectar ChatGPT** y completá el acceso
oficial. Si el navegador bloquea la ventana, usá **Continuar en el navegador**.
Bitácora prepara MXC automáticamente cuando está disponible, sin pedir permisos.
Si hace falta un permiso de administrador, muestra **Antes de empezar** y explica
el cambio antes de habilitar **Preparar la protección**. Si falla, bloquea los
pedidos y permite reintentar. Una falla de consulta vuelve a consultar el estado.
En cada arranque de la app comprueba nuevamente la disponibilidad de MXC.
Después escribí un pedido. Cada trabajo aparece a la izquierda: podés abrirlo
y seguirlo, también después de cerrar y volver a levantar el servidor.
**Pausar pedido** detiene el pedido actual; no deshace cambios en archivos.

La carpeta de la agencia se crea en `%USERPROFILE%\Bitacora`. Los trabajos se
guardan en `%APPDATA%\Bitacora\works.json`; el estado y las credenciales de
Codex se guardan por separado en `%APPDATA%\Bitacora\codex` (archivo de
credenciales administrado por Codex). No se usa el Codex personal de la PC.
No compartas esa carpeta de datos ni sus credenciales.

Para pruebas se pueden cambiar `BITACORA_WORKSPACE` (carpeta de trabajo) y
`BITACORA_DATA_DIR` (datos y cuenta). Deben ser carpetas separadas, sin estar
una dentro de la otra. El servidor escucha sólo en `127.0.0.1:4317` y acepta
la interfaz de `127.0.0.1:5173` o `localhost:5173`, exclusivamente. `BITACORA_PORT` y `BITACORA_WEB_ORIGIN`
permiten cambiar el servidor; si cambiás su puerto, ajustá también el destino
de desarrollo en `web/vite.config.ts`.

```powershell
npm run typecheck
npm test
npm run build
npm run generate:protocol
```

Las pruebas automáticas usan un motor falso y un proceso que simula el protocolo
por stdio, sin consumir ChatGPT. Con Vite levantado (`npm run dev -w web`),
`npx tsx scripts/verify-browser.ts` comprueba la pantalla con Edge, la caída del
motor, la reconexión, los dos nombres locales y el acceso en una ventana nueva.
Usa datos de prueba en `%LOCALAPPDATA%\Bitacora-dev\pr11-browser` y capturas en `.local/`.
Los tipos
de Codex están generados y versionados en `server/src/codex/generated`, con
la versión en `server/src/codex/VERSION`. El generador y el servidor rechazan
otras versiones. Referencia: [protocolo oficial](https://learn.chatgpt.com/docs/app-server).

Este paso usa `workspace-write` y `approvalPolicy: never`. El aislamiento
se consulta al arrancar: si Windows no confirma una protección real, la app
avisa y bloquea los pedidos. El detalle del motor indica el estado y el modo.
El paso guiado prepara la protección (issue #12); no usa el modo `unelevated`
ni continúa sin protección. La versión sigue fijada en 0.168.0: el Codex
del PATH puede tener otra versión sin afectar la app.
`npx tsx scripts/verify-protection.ts` verifica el paso guiado con un proceso
falso y Edge, sin inferencia. Guarda capturas en `docs/verification/issue12/`
y elimina sus datos de prueba fuera del repo al terminar.
Si el motor se cae, intenta relanzarlo hasta cinco veces, con espera creciente;
no reenvía pedidos automáticamente. Si no vuelve, reiniciá la app.
Un archivo de trabajos dañado se conserva como `works.corrupt-<fecha>.json` y
la app abre una lista vacía con un aviso. Si falla un guardado, muestra un aviso
y el siguiente guardado puede recuperarse.

El aislamiento
estricto de lecturas, las copias y deshacer corresponden al issue #4 y no
están implementados. Tampoco hay adjuntos, galería, kit ni instalador.

- Qué tiene que hacer el MVP: [`.csdd/specs.md`](.csdd/specs.md)
- Por qué está armado así: [`.csdd/decisions.md`](.csdd/decisions.md)
- Qué falta: los issues del milestone **MVP**
