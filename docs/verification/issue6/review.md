# Retrabajo de la revisión independiente

Se verificaron los once hallazgos contra el código de `3946c37`; todos tenían
respaldo. Sin turnos de modelo ni login de ChatGPT.

## Reproducción y descarga pública

Antes del arreglo, ejecutar `download` con `https://www.google.com/` y
`http://neverssl.com/` dio en ambos casos:
`ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` (Node 24.15.0).
`https://example.com/` dio ENOTFOUND en esta máquina, por eso se usó Google.

Después: `npx tsx scripts/verify-fetch.ts` descargó la página pública de Google,
guardó fuente con acentos correctos y una foto PNG sin avisos. `public-fetch.json`
registra fecha, URL, respuestas DNS, resumen, extracto y SHA-256 de la fuente.
El callback de conexión devuelve exclusivamente la IP ya validada y respeta
`options.all`; no hay una segunda resolución. La prueba con `operador.test`
inyecta un resolvedor hacia el HTTP local y comprueba el host recibido.

## Cobertura

`server/test/kit-review.test.ts` agrega regresiones para:

- Lista exacta en datos, fuera de la agencia; variantes rechazadas; la app guarda
  solo URLs de pedidos de usuaria antes de llamar al motor, nunca de sus respuestas.
- Nombre de host resuelto por inyección y conectado a la IP controlada, redirecciones,
  charset de cabecera y meta Windows-1252, firmas JPEG/PNG/WebP y MIME contradictorio.
- Página de más de 2 MB, foto de más de 5 MB, más de 12 fotos, timeout de respuesta
  y de DNS, y bucle de redirecciones. Loopback solo se habilita desde el test.
- Junction a datos externos: lectura, escritura y dibujo rechazados; publicación
  atómica sin sobrescritura; ejemplo borrado que no se repone tras reinicializar.
- Shadow DOM declarativo, iframe/srcdoc, object, embed, controles y counter/counters,
  incluso reglas de impresión: error que indica qué sacar.
- Experiencia con verbos acentuados, operador partido entre elementos, emojis,
  normalización de miles/decimales, rechazo de coincidencias parciales y citas sobrantes.

Las pruebas originales conservan cliente MCP real y Edge. `verify-kit.ts` volvió
a comprobar catálogo y llamadas a las tres herramientas por Codex 0.168.0 sin
solicitudes de aprobación, con fuente local, fuente rota y desbordes.

Las escrituras preparan un temporal en el directorio validado, verifican el archivo
abierto, publican atómicamente y verifican la ruta real final. Para conservar la
semántica sin sobrescritura se publica un archivo nuevo con enlace transitorio y
se quita el nombre temporal; las actualizaciones usan rename. Las lecturas verifican
identidad antes y después; Edge recibe esos bytes verificados, sin reabrir el archivo
por su cuenta. Se rechaza también el cambio de la raíz real de la agencia.

## Límites y empaquetado

`controlar` protege contra errores honestos, no contra un agente que edite la
fuente. La prueba conversacional real sigue pendiente para el orquestador con una
persona. No se construyó instalador. Las dependencias de ejecución del MCP,
incluidos tsx y playwright-core, pertenecen ahora al paquete del servidor; #9
debe distribuirlo junto con Node, Codex fijado, kit y recursos, preservando o
adaptando las rutas del registro. No se necesita instalar ni descargar navegador.
## Resultado final

`review-tests-1.txt`, `review-tests-2.txt` y `review-tests-3.txt`: 43/43 pruebas
aprobadas en cada corrida. `review-typecheck.txt` y `review-build.txt`: aprobados.
No quedaron procesos de estas pruebas. Los datos creados por las verificaciones
terminadas se eliminaron; el intento de borrar la raíz
`%LOCALAPPDATA%\Bitacora-dev\issue6` (restos de pruebas de la primera entrega)
fue rechazado por la revisión automática con «blocked by policy».

