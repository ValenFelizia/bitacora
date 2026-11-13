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
