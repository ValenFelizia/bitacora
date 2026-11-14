# Integración final con adjuntos y resultados (#14)

Se integró `origin/main` (`7b120b6`) por merge, sin reescribir historia. Conflictos
en `server/src/app.ts` y README: se conservó el envío de adjuntos y la autorización
de links desde `command.text`, antes del adaptador. Los cambios de engine,
contracts, server, index y web se combinaron sin conflictos; el servidor conserva
el acceso a archivos y la galería de #5.

## Comportamiento combinado

- `App.start()` inicializa el kit después de crear la agencia y antes de arrancar
  el motor o recuperar escaneos pendientes. La marca sigue en datos por identidad
  de agencia; el arranque de index mantiene la validación de rutas reales.
- Solo el texto del pedido amplía la lista. El caso con adjunto comprueba que
  su nombre `www.nombre-adjunto.example.txt`, su contenido con otra URL y un link
  agregado por un adaptador simulado no quedan autorizados. Las tres llamadas
  MCP con esos links fallan antes de intentar descargar.
- Traer guarda fotos en `<oferta>/fotos/operador/`. El escaneo excluye esa pareja
  de subcarpetas en cualquier oferta y `ejemplo/` en la raíz. Las guardas y
  temporales `.kit-*` se excluyen por empezar con punto. Se eligió una ruta
  reservada para entradas, sin listas auxiliares ni cambios al contrato de resultados.
- Dibujar escribe fuera de esas rutas. Sus PNG y PDF aparecen en el pedido y en
  la galería. Se prueban también JPG, JPEG, WebP y cambios de contenido posterior.
- Controlar requiere `.md` en fuente e informe; no puede escribir un informe HTML,
  script, ejecutable o PDF. Traer usa fuente.md y las demás salidas de herramientas
  tienen extensiones fijas de imagen/PDF. La creación de HTML/JSON del kit es
  inicialización de la app, no una herramienta invocable por el agente.
- directory-lock.ts queda en UTF-8 sin BOM, con «Volvé» y «ubicación» correctos.
  `source-encoding.test.ts` recorre server/, web/src/, scripts/ y kit/: rechaza BOM,
  UTF-8 inválido y la secuencia de acentos rotos indicada en la tarea.

## Recorrido reproducible

`npx tsx scripts/verify-kit-integration.ts` usa una agencia nueva con espacios,
acentos y ñ bajo `%LOCALAPPDATA%\Bitacora-dev\issue6\`:

1. Arranca el servidor real de la app con un motor falso. El motor comprueba que
   el kit ya exista al iniciar. El servidor usa puerto efímero; UI en 5326.
2. Recibe un pedido por WebSocket con texto y adjunto. La app registra únicamente
   el link del texto. El MCP por stdio se conecta con un cliente SDK real.
3. Traer baja fuente y foto de un HTTP local sintético. La excepción de loopback
   se inyecta solo desde `server/test/kit-mcp.ts`, para el origen exacto del fixture.
   El ejecutable MCP de producción no expone flags ni variables para activarla.
4. El motor falso prepara el HTML, controlar valida las citas y dibujar genera
   PNG 1080 × 1920, PDF y vista conjunta usando Edge del sistema.
5. Al finalizar, el servidor informa exactamente tres resultados y los sirve por
   su endpoint autenticado. La foto de entrada, ejemplo y guardas no aparecen.
6. Edge abre la UI real y se guardan capturas de conversación y galería.

Capturas, control y salidas en `integration/`; `integration.json` conserva llamadas
y snapshot sin el token de acceso a archivos. El mismo recorrido sin capturas es
una prueba automática de `npm test`. No hay turnos ni solicitudes a ChatGPT.

La limpieza de la raíz issue6 queda a cargo del operador por instrucción expresa:
no se intentó borrarla. Los nuevos fixtures se conservan allí. Los servidores,
MCP, Vite y Edge lanzados por la verificación se cierran en finally.

## Límites

`npm install`: sin vulnerabilidades. `merge-typecheck.txt` y `merge-build.txt`:
aprobados. Tres corridas completas con 68/68:

- `merge-tests-1.txt`: npm test desde PowerShell.
- `merge-tests-gitbash-serial.txt`: npm test -- --test-concurrency=1 desde Git Bash
  real (`C:\Program Files\Git\bin\bash.exe`). El ayudante de ACL de main usa
  whoami.exe e icacls.exe absolutos de System32; no se agregaron comandos Windows.
- `merge-tests-3.txt`: npm test -- --test-concurrency=1 desde PowerShell.

También se conserva `merge-tests-gitbash.txt`: 67/68 por la afirmación temporal
preexistente de codex.test.ts:286 (backoff). No se cambió el test ni el motor;
se repitió con los archivos de prueba en serie para reducir contención de CPU.
No quedaron procesos propios en ejecución.

Se verificó con motor falso y protocolo MCP real. La conversación con un modelo
real y el instalador continúan pendientes. #9 debe distribuir Node, Codex fijado,
el servidor con sus dependencias de producción, el binario precompilado Koffi para
Windows, playwright-core, scripts y kit con rutas coherentes. Edge se encuentra en
el sistema; no se descarga navegador. Controlar protege contra errores honestos,
no contra un agente que edite la fuente. No se amplió el trabajo sobre Origin.
