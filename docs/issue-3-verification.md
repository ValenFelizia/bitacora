# Verificación del issue #3: correcciones del PR #11

## Verificación actual, 13 de noviembre de 2026

Windows, Codex CLI 0.168.0. Se incorporó `origin/main` antes de modificar código;
no se editaron los documentos de `.csdd/`.
`npm run typecheck`, `npm test` y `npm run build`: PASS, con 16 pruebas.
Las pruebas usan `FakeEngine` y el adaptador real `CodexEngine` con un proceso
Node que simula app-server por stdio. No consumen inferencia.

| Punto | Cambio y evidencia |
| --- | --- |
| 1 | Cola recuperable tras rechazo; tres reintentos de `rename` ante EPERM/EBUSY con esperas de 30/60/90 ms. Prueba de guardado fallido por destino temporal inaccesible y guardado exitoso posterior. Reintentos inspeccionados en código; no se provocó un bloqueo real de Defender. |
| 2 | Fragmentos incrementales sin guardar ni reenviar snapshots. Guardado al cerrar ítem/pedido, cada segundo si hubo cambios y al cerrar la app. Prueba de 50 fragmentos sin cambios en disco hasta el cierre. |
| 3 | Hasta cinco relanzamientos, con espera creciente; se invalidan conversaciones retomadas y pedidos en curso. Pruebas del proceso muerto, saludo nuevo, tope de intentos y reanudación posterior. Edge muestra motor detenido sin «conectado» y luego recupera la cuenta. No se reenvían pedidos. |
| 4 | Se conserva JSON dañado en `works.corrupt-<fecha>.json`; lista vacía con aviso. Prueba verifica bytes conservados y trabajo nuevo; aviso comprobado en Edge. Errores de lectura ajenos al formato no se ocultan. |
| 5 | Interfaz genérica `Engine.executionSafety()`. Consulta de readiness y configuración al arrancar y relanzar; sólo `ready` permite enviar. Prueba bloquea antes de `turn/start`; Edge muestra protección pendiente y envío deshabilitado. Investigación real sin inferencia debajo. |
| 6 | Todas las variables `CODEX_*` y claves/tokens de API heredados se quitan; `CODEX_HOME` se fija. El hijo falso devuelve su entorno y confirma la ruta propia y ausencia de secretos centinela de OpenAI y Anthropic. |
| 7 | El cierre durante `turn/start` impide que una respuesta tardía reponga el pedido. Prueba de cierre anterior a respuesta inicial y pausa posterior: ningún interrupt con id viejo. |
| 8 | `willRetry` emite actividad/detalle sin error visible; falla definitiva una vez desde `turn/completed`. Prueba con error reintentable, error definitivo y cierre: un único problema y actividad retrying. |
| 9 | Pausa temprana pendiente hasta conocer el id. Prueba con respuesta inicial demorada y pausa anterior al id. |
| 10 | Actividades tipadas en el adaptador; frases de progreso en `server/src/engine.ts`. Proceso falso verifica lectura, ejecución, escritura, herramienta y reintento. |
| 11 | Ventana vacía abierta en el clic y dirección asignada al llegar. Edge confirma navegación a `https://example.test/login` interceptado localmente y conserva el enlace alternativo. Sin login real. |
| 12 | Origin/Host exactos para los dos nombres locales y puerto configurado. Pruebas rechazan sin Origin, Host incorrecto, origen externo, otro puerto y localhost.evil; aceptan localhost. Edge conecta por ambos nombres. |

Los doce hallazgos se confirmaron contra el código; ninguno se descartó.

### Aislamiento de esta máquina

Se lanzó el binario instalado con entorno limpio y CODEX_HOME nuevo en
`%LOCALAPPDATA%\Bitacora-dev\pr11\data\codex`, desde
`%LOCALAPPDATA%\Bitacora-dev\pr11\workspace`. Sólo `initialize`, `initialized`,
`windowsSandbox/readiness` y `config/read`. Resultado: `status: notConfigured`,
`windows: null`, `sandbox_mode: null`. No hubo turnos ni herramientas.
No se llamó a `windowsSandbox/setupStart` ni se solicitó elevación.

Se consultó la [documentación oficial de Windows](https://learn.chatgpt.com/docs/windows/windows-sandbox)
y el código oficial de la versión fijada:

- [Readiness](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/app-server/src/request_processors/windows_sandbox_processor.rs): Disabled → notConfigured; token restringido → ready incluso sin setup elevado; elevado sin preparación → updateRequired.
- [Configuración Windows](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/config/windows_sandbox_config.rs): sin modo seleccionado se resuelve SandboxType::None.
- [Ejecución](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/sandboxing/src/manager.rs): sin backend Windows se selecciona None; ese backend devuelve el comando sin envolverlo en aislamiento nativo. `workspace-write` por sí solo no basta en este estado.

Se permite todo backend declarado ready, incluido unelevated. El detalle técnico
registra modo configurado y estado. Fallos de consulta o preparación pendiente
impiden enviar pedidos. Esto verifica configuración, no límites físicos del sandbox.

### Navegador, desvíos y límites actuales

Edge con `playwright-core`, servidor real y proceso falso: PASS. La vista previa
compartida falló dos veces con `Preview automation snapshot timed out after 15000ms`;
se usó Edge local. `npx tsx scripts/verify-browser.ts`, con Vite levantado, comprueba
caída, relanzamiento, reconexión tras reiniciar servidor, ambos nombres locales,
archivo dañado, bloqueo por protección y ventana de acceso. Sin errores de página.
Se inspeccionaron antes/después a 1280 × 800 y la pantalla a 460 × 800:
se conservaron tipografía, colores, distribución y lectura.

Los estilos son utilidades Tailwind; style.css sólo importa Tailwind y define la
fuente del tema. Se retiró @playwright/test; playwright-core se usa para Edge sin
descargar navegador. Los tipos generados siguen completos y están marcados como
linguist-generated en .gitattributes.

Capturas locales en `.local/`: before.png, after-offline.png, after.png,
engine-down.png, reconnecting.png, mobile.png y protection-corrupt.png.
Se versionaron también [antes](verification/pr11/before.png),
[después](verification/pr11/after.png), [motor detenido](verification/pr11/engine-down.png)
y [protección y archivo dañado](verification/pr11/protection-corrupt.png).
El script deja datos sintéticos en `%LOCALAPPDATA%\Bitacora-dev\pr11-browser` y
cierra sus procesos y ventanas. También queda la carpeta pr11 de la consulta real.

**Cero pedidos reales nuevos.** Se omitió la inferencia final porque la protección
de la configuración nueva no está lista. No se sorteó el bloqueo ni se solicitó
login. La prueba histórica que sigue usó un workspace dentro del repo y cargó
instrucciones de desarrollo: no acredita el flujo representativo del producto.
No se verificaron límites físicos del sandbox, Defender, cuotas reales ni
instalación. La preparación, títulos, plugins/skills, adjuntos, galería, kit,
entrevista, Tauri, copias y deshacer siguen fuera de alcance.

## Registro histórico anterior a la revisión

Lo siguiente describe el estado previo; las comprobaciones actuales están arriba.

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
