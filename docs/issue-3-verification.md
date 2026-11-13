# Verificación del issue #3

Realizada el 13 de noviembre de 2026 en Windows, con Codex CLI 0.168.0.

## Comprobaciones automáticas

- `npm run generate:protocol`: tipos generados con el binario instalado y un
  `CODEX_HOME` de generación dentro de `.local/`, sin configuración personal.
- `npm run typecheck`, `npm test`, `npm run build`: correctos.
- Pruebas con `FakeEngine`: historial y continuación tras reinicio, respuesta
  por fragmentos sin duplicar el mensaje final, título, interrupción, límite
  del plan, cuenta desconectada, exclusión de pedidos simultáneos, petición
  vacía, recuperación de trabajo inconcluso, conservación de JSON inválido,
  rutas separadas y comunicación WebSocket con rechazo de origen externo.

## Prueba con la app y Codex reales

Se levantaron servidor y Vite en `127.0.0.1`, con datos y carpeta de trabajo
separados: `.local/smoke-data` y `.local/smoke-workspace`, ambos ignorados.

1. La pantalla mostró cuenta desconectada y el envío deshabilitado.
2. Se pulsó **Conectar ChatGPT**. Una persona completó el acceso oficial.
   La pantalla pasó a cuenta conectada.
3. Se envió: «Respondé solamente: Prueba de Bitácora lista. No uses
   herramientas ni leas archivos.» La respuesta fue «Prueba de Bitácora lista.»
4. Se cerró el servidor y se levantó otra vez con las mismas carpetas. La
   cuenta y el historial siguieron disponibles.
5. En el mismo trabajo se envió: «¿Qué frase respondiste antes? Repetila
   solamente. No uses herramientas ni leas archivos.» Respondió la misma frase.
   El JSON conservó un único trabajo, la misma conversación de Codex y cuatro
   mensajes. El estado terminó con `busy: false`.
6. Un observador de la línea de estado del navegador registró
   `Preparando la respuesta…` y `Listo.` durante el segundo pedido.
7. Se recargó la página y se volvió a abrir el trabajo desde la lista,
   conservando sus dos pedidos y dos respuestas.

Se hicieron **sólo dos pedidos reales**. No se copiaron credenciales personales
ni se usó el directorio personal de Codex. Los datos de acceso quedan fuera
de Git. Se revisó visualmente la pantalla en el navegador a 1280 × 800.

## Límites de esta evidencia

- Interrupción, detalles y cuota agotada se probaron con motor falso; no se
  provocaron con la suscripción real. La traducción de comandos y cambios de
  archivos se revisó en el código y contra los tipos generados, sin ejecutarlos.
- No se verificó aislamiento estricto de lecturas ni ejecución del sandbox
  nativo con herramientas: corresponden al issue #4. Las solicitudes usan
  `never` y `workspace-write`, sin acceso total.
- No se prueban herramientas interactivas del agente: el adaptador rechaza
  explícitamente solicitudes que esta pantalla todavía no sabe responder.
- Esta es una app de desarrollo, sin instalador ni prueba de distribución.
