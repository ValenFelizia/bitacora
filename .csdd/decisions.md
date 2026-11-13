# Decisions

<!--
Record consequential decisions when useful. A decision may use stable DEC-NNN
identity, status and date, context, decision, rationale, and consequences;
add alternatives or supersession only when useful. Do not infer rationale or
accepted direction from implementation alone.
-->

## DEC-001 — App local de escritorio, no web hosteada

- Status: accepted (2026-11-13)
- Context: la idea original era una plataforma web donde cada agencia trae su
  suscripción.
- Decision: la app corre en la compu de la usuaria y usa el Codex CLI oficial
  con su login de ChatGPT.
- Rationale: según cobertura de prensa consultada el 2026-11-13, Anthropic no
  permite usar el login de suscripción en productos de terceros sin aprobación,
  y OpenAI abre el uso del plan a apps open source y locales, con un formulario
  de interés para productos pagos u hosteados. No se leyeron los términos
  oficiales. Además, hosteado, el cómputo del agente lo pagaría el proyecto.
- Consequences: hay que distribuir un instalador. Revisar esta decisión si
  cambian las reglas de los proveedores.

## DEC-002 — El motor es Codex, envuelto; no se escribe un agente propio

- Status: accepted (2026-11-13)
- Decision: el servidor le habla al Codex CLI, que aporta login, agente,
  herramientas y sandbox. Una sola interfaz de "motor", con Codex como única
  implementación.
- Rationale: es lo que hace T3 Code. Abstraer varios proveedores antes de tener
  el segundo es adivinar.
- Rejected: Sign in with ChatGPT más un agente propio sobre la API. Es mucho más
  trabajo y esa vía no ofrece ejecución de código.

## DEC-008 — Codex se maneja por app-server sobre stdio, con versión fijada

- Status: accepted (2026-11-13)
- Context: investigación del issue #1, hecha contra Codex CLI 0.168.0 y la
  documentación oficial.
- Decision: el servidor lanza `codex app-server` como proceso hijo y le habla
  por stdio. La versión de Codex queda fijada y los tipos del protocolo se
  generan desde esa misma versión. Bitácora usa un `CODEX_HOME` propio, separado
  del Codex personal de quien la usa.
- Rationale: app-server expone login, conversaciones retomables, eventos y
  solicitudes bidireccionales, que el SDK y `codex exec` no dan juntos. El CLI lo
  marca experimental, por eso se fija la versión.
- Consequences: actualizar Codex es un cambio deliberado, con prueba de
  compatibilidad. Deshacer cambios en disco es responsabilidad de Bitácora:
  Codex retoma conversaciones pero no revierte archivos.

## DEC-003 — Servidor local en TypeScript, UI web y cáscara Tauri mínima

- Status: accepted (2026-11-13)
- Decision: tres piezas. Un servidor local en TypeScript que habla con Codex,
  maneja el espacio de trabajo y ofrece las herramientas del kit. Una UI en
  React, Vite y Tailwind. Una cáscara Tauri que arranca el servidor y muestra la
  ventana.
- Rationale: casi todo queda en un solo lenguaje, se puede iterar sin empaquetar,
  y la cáscara queda tan fina que cambiarla por Electron no toca servidor ni UI.
  Valentín prefiere Tauri a Electron.
- Consequences: Tauri no trae Node ni Chromium. El dibujo usa el Edge del
  sistema y el instalador incluye un runtime de JavaScript para el agente.

## DEC-004 — Solo Windows en el MVP

- Status: accepted (2026-11-13)
- Rationale: es lo que usan Fer y la mayoría de las agencias, y garantiza Edge
  instalado para dibujar sin descargar un navegador.

## DEC-005 — Kit base de turismo que el agente adapta

- Status: accepted (2026-11-13)
- Decision: un espacio de trabajo nuevo parte de un kit con herramientas e
  instrucciones de entrevista, no de una carpeta vacía.
- Rationale: pedirle "ayudame a armar las plantillas" a un agente da mejor
  resultado desde una base probada. El repo `787-propuestas` es el punto de
  partida, mejorable y reemplazable, no un estándar.
- Rejected: carpeta vacía; kit genérico sin turismo.

## DEC-006 — De cero, con T3 Code como referencia

- Status: accepted (2026-11-13)
- Decision: repo nuevo. Se lee cómo T3 Code le habla a Codex, sin forkearlo.
- Rationale: T3 Code es MIT pero arrastra git, worktrees, SSH y muchos
  proveedores que este producto no quiere.

## DEC-007 — El trabajo se ordena en los issues de GitHub

- Status: accepted (2026-11-13)
- Decision: los issues del repo, bajo el milestone "MVP", son la lista de
  trabajo. `.csdd/` guarda solo la verdad durable (requisitos y decisiones).

## DEC-009 — Node como runtime incluido y dibujo con el Edge del sistema

- Status: accepted (2026-11-13)
- Context: investigación del issue #2, verificada contra la documentación
  oficial y con una prueba en Windows 11 con Edge 157.
- Decision: el instalador incluye `node.exe` para correr el servidor y los
  scripts del agente. El dibujo a PNG y PDF usa `playwright-core` con
  `channel: 'msedge'`, sin descargar un navegador.
- Rationale: Node es lo más estable en Windows y ya es lo que usa el servidor.
  `playwright-core` encuentra Edge solo, produce tamaño exacto y permite medir
  desbordes; el modo de línea de comandos de Edge no puede inspeccionar la
  página.
- Consequences: la página a dibujar se carga desde un archivo, no con
  `setContent`. Cargada con `setContent` no puede leer fuentes locales y dibuja
  con una de reemplazo sin avisar. Después de esperar las fuentes hay que
  comprobar que ninguna quedó en error, y fallar si alguna falló.
- Rejected: Bun y Deno (sin ventaja que compense), Node SEA (no corre scripts
  sueltos), `msedge --headless` por línea de comandos.
