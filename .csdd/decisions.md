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

## DEC-010 — Cada pedido corre con un perfil de permisos que no deja leer afuera

- Status: accepted (2026-11-15)
- Context: el issue #4 probó en Windows 11, con MXC y Codex 0.168.0, que un
  perfil de permisos con nombre impide leer un archivo testigo fuera de la
  carpeta sin romper PowerShell ni la lectura adentro. R4 decía que el bloqueo
  de lecturas se sumaba solo si esa prueba salía bien: salió bien. El issue #19
  lo activa en la app.
- Decision: el app-server arranca con un perfil propio, `agencia`, definido con
  `-c` en la línea de comandos (no en el `config.toml` de la usuaria): extiende
  `:workspace`, deja `:root` y `:tmpdir` en `deny`, `:minimal` en `read` y la red
  apagada. Cada `thread/start`, `thread/resume` y `turn/start` manda
  `permissions = "agencia"`. Antes de habilitar pedidos, la app pide
  `permissionProfile/list` y exige que el perfil exista y esté permitido; si no,
  no trabaja y lo dice en castellano simple.
- Update (2026-11-16, decidido por la dueña): en una compu sin MXC el backend
  `elevated` no puede correr el perfil, y negarse a trabajar deja a la usuaria
  sin app. En esa compu la app trabaja con la protección de escritura anterior
  —el hilo con `sandbox: "workspace-write"` y el turno con `sandboxPolicy`
  workspaceWrite, `writableRoots` la carpeta, red apagada y sin `:tmpdir`— y
  avisa en castellano simple que el agente puede leer afuera pero no cambiarlo
  ni borrarlo. El aviso va en `ExecutionSafety.readBlock = false` y no es un
  fallo: no bloquea pedidos. En una compu con MXC no cambia nada: el perfil es
  obligatorio y, si no se puede aplicar, la app no trabaja. El modo lo decide
  la comprobación de arranque; si el proceso se abrió con los argumentos del
  otro modo, se lo detiene y se lo vuelve a abrir con los que corresponden, así
  un mismo proceso nunca mezcla los dos. El modo sin MXC es el último recurso:
  el sondeo de MXC corre aunque el modo guardado sea `elevated`, así una compu
  que gana MXC con una actualización de Windows pasa sola al perfil.
- Rationale: cierra la vía principal de fuga de datos: el agente ya no podía
  escribir afuera, pero podía leer cualquier archivo de la usuaria. El perfil
  reemplaza al `sandboxPolicy` del turno porque Codex no acepta los dos juntos.
- Consequences: la app pasa a depender de la API experimental de Codex. Los
  campos `permissions` (en thread y turn) y `permissionProfile` (en
  `command/exec`) no son estables, y el cliente tiene que negociar
  `experimentalApi: true` en `initialize`: sin eso el app-server rechaza el
  perfil con -32600. Por eso los tipos del protocolo se generan con
  `--experimental` desde la versión fijada, y actualizar Codex es un cambio
  deliberado que exige volver a probar `permissionProfile/list`, el
  `activePermissionProfile` que devuelve `thread/start`, que `-c` siga aceptando
  el perfil como tabla TOML y la prueba de arena real de
  `server/test/read-block.test.ts`. Antes de habilitar pedidos, en una compu con
  MXC la app corre un comando inofensivo con el perfil (`command/exec`): que el
  perfil figure en la lista no alcanza, porque el backend "elevated" de Windows
  rechaza cualquier perfil que niegue la lectura de `:root` y una compu sin el
  sandbox nativo no puede correrlo. Si ese comando falla, la app no trabaja y lo
  dice. Dos límites verificados: Codex lee los `AGENTS.md` desde la raíz del
  repositorio, así que una carpeta de agencia dentro de un repo git necesita
  leer sus carpetas superiores y la app va a informar que no puede aplicar el
  perfil; y apagar esa lectura con `project_doc_max_bytes = 0` dejaría al agente
  sin las instrucciones del kit, así que no se usa.

## DEC-011 — Entorno curado para agencia de viajes, no un Codex recortado

- Status: accepted (2026-11-16, decidido por el dueño)
- Context: la investigación del issue #23 (`docs/research/issue23.md`) sobre
  `@openai/codex@0.168.0` mostró que, de fábrica, `codex app-server` prende
  `web_search` en modo `Cached`, `image_generation` junto con la skill `imagegen`,
  cinco skills `.system` (`imagegen`, `openai-docs`, `review-agent`,
  `skill-creator`, `skill-installer`), la clonación al arrancar de
  `openai/plugins` (~58–81 MB), `tool_suggest`, conectores `apps` (`codex_apps`)
  y subagentes `multi_agent`.
- Decision: armar un entorno curado para agencias en un módulo propio e
  independiente del proveedor (`server/src/agency-environment.ts`) y pasarlo
  por línea de comandos con `-c` en `appServerArgs` (`server/src/codex/environment.ts`),
  sin escribir en el `config.toml` de la usuaria:
  - **Imágenes con IA prendidas y solo a pedido explícito:** se mantiene
    `features.image_generation=true` (verificado en `codex-rs` que la
    herramienta `image_gen.imagegen` depende de ese flag y no de la skill
    `imagegen`, por lo que ese flag es el mínimo necesario). En
    `developerInstructions` se reemplaza *"No generes imágenes con IA"* por la
    regla en castellano simple: usar imágenes con IA solo si la usuaria lo pide
    explícitamente, y nunca presentar una imagen con IA como si fuera una foto
    real de un hotel o un destino (la regla del kit sigue vigente; las piezas se
    siguen dibujando con código, refinando así la restricción general de
    `.csdd/specs.md`).
  - **Plugins y conectores por lista blanca, vacía por ahora:** el módulo
    define `allowedPlugins` y `allowedConnectors` como listas vacías para que el
    issue #38 pueda sumar una lista corta elegida mirando cómo trabaja Fer (#8)
    sin rediseñar el contrato. Codex `0.168.0` tiene habilitación por ítem
    (`plugins._default.enabled=false` / `plugins.<id>.enabled=true` y
    `apps._default.enabled=false` / `apps.<id>.enabled=true`), pero **no**
    ofrece una lista blanca de descarga para `openai/plugins`: si
    `features.plugins=true` y `remote_plugin=false`, clona el catálogo entero al
    arrancar. Por eso, mientras las listas estén vacías, se apagan con los
    interruptores limpios (`features.plugins=false`, `features.remote_plugin=false`,
    `features.plugin_discovery_prefetch=false`, `features.plugin_sharing=false`,
    `features.tool_suggest=false`, `features.apps=false`,
    `include_apps_instructions=false`, `plugins._default.enabled=false`,
    `apps._default.enabled=false`).
  - **Búsqueda web de Codex apagada:** `web_search="disabled"`; lo externo
    entra únicamente por `traer`.
  - **Subagentes y skills de fábrica que no usa una agencia apagados:**
    `features.multi_agent=false`, `features.multi_agent_v2=false`,
    `agents.enabled=false` y `skills.bundled.enabled=false`. Siguen prendidos
    el servidor MCP `bitacora` (`traer`, `controlar`, `dibujar`), `view_image`
    y las herramientas base de archivos y consola.
- Update (2026-11-18, issue #41): el smoke test con un pedido real mostró qué
  herramientas ve efectivamente el agente (`bitacora`: `traer`, `controlar` y
  `dibujar`; `view_image`; `image_gen`; `exec_command` / `write_stdin`; y
  `apply_patch`; sin navegador, uso de computadora, búsqueda web ni subagentes),
  y detectó que seguían apareciendo las herramientas de metas (`create_goal`,
  `get_goal`, `update_goal`) y las skills del usuario y del entorno (`$HOME/.agents/skills`,
  `$CODEX_HOME/skills` y `.agents/skills`). Se suman dos reglas en el entorno
  curado:
  - **Metas apagadas:** `goals = false` en `AGENCY_ENVIRONMENT` pasa
    `-c features.goals=false`.
  - **Solo skills explícitas del kit (hoy ninguna):** `allowedSkills = []` en
    `AGENCY_ENVIRONMENT` e `isAllowedSkill` permiten únicamente skills de
    alcance `repo` incluidas en esa lista. Como Codex `0.168.0` en Windows lee
    `$HOME/.agents/skills` con la carpeta de perfil del sistema (ignora
    `HOME`/`USERPROFILE`), y no tiene un interruptor por alcance ni por raíz
    para skills de usuario, Bitácora pasa `-c skills.include_instructions=false`
    cuando `allowedSkills` está vacía y, al iniciar, ante `skills/changed` y
    antes de cada turno (`thread/start`, `thread/resume` y `send`), pide
    `skills/list` y apaga una por una (`skills/config/write` con
    `enabled: false`) toda skill habilitada que no sea permitida. El
    app-server serializa esas escrituras, así que el orden secuencial no evita
    una carrera sobre `config.toml` (probado con 47 escrituras en paralelo sin
    pérdidas): se usa para poder cortar el lote y avisar qué quedó prendido.
    `effectiveEnabled` no se cree, porque repite lo pedido; después de cada
    lote se vuelve a pedir `skills/list` y se avisa lo que siga prendido. La
    sincronización entera tiene un tope de 20 s y nunca rechaza: si falla o se
    queda sin tiempo, queda como detalle del trabajo y la app sigue. No se
    modifican `HOME` ni `USERPROFILE`.
- Rationale: el objetivo no es cortarle las patas a Codex sino darle a la
  agencia un entorno limpio, sin descargas de catálogos ni herramientas de
  programación o conectores sorpresa, dejando una estructura lista para que
  otro proveedor (como Claude) o la lista corta de #38 usen la misma política.
- Consequences: cualquier actualización de `@openai/codex` debe pasar la prueba
  sin inferencia (`server/test/agency-environment.test.ts`), que comprueba bajo
  los argumentos reales de Bitácora que `codex features list`, `config/read`,
  `skills/list` y `mcpServerStatus/list` mantengan este estado, que no aparezcan
  `.tmp/plugins` ni `skills/.system`, y que las skills de usuario o del espacio
  de trabajo queden persistidas como apagadas.

## DEC-012 — Sistema de diseño «De a bordo»

- Status: accepted (2026-11-16, decidido por el dueño)
- Context: la interfaz creció por partes (#25). Usaba la letra del sistema, Georgia en los títulos, verde y dorado sobre crema, y casi no tenía íconos. El dueño pidió buscar inspiración en herramientas de IA para gente no técnica (`docs/research/inspiracion-diseno.md`). También pidió darle a Bitácora una personalidad mínima, con colores y letras que no sean genéricos. Fijó cuatro principios: no bombardear de información, nada de decoración genérica, los entregables como foco con descarga clara, y menos texto y más íconos.
- Decision: se adopta la dirección «De a bordo», elegida entre tres maquetas y ajustada en una segunda vuelta. Queda descrita en `design.md`, en la raíz del repo:
  - Fondo papel `#f4efe4`, tinta azul marino `#1d2838` y un solo acento naranja de boya `#d4612a`.
  - Young Serif para títulos y Atkinson Hyperlegible para el texto, empaquetadas con la app. Íconos Lucide.
  - El progreso del agente se muestra como entradas con hora y los trabajos llevan fecha.
  - El entregable va en la barra derecha, con la miniatura como protagonista y «Descargar» como texto con ícono subrayado, no como botón relleno.
  - La cuenta se muestra con el mail. Si no hay cuenta, una invitación con una sola acción. Sin indicadores que laten.
- Rationale: la personalidad sale del nombre (un cuaderno de a bordo es un registro con hora), no de adornos. Atkinson Hyperlegible está hecha para leerse fácil, y eso le sirve a una usuaria no técnica. El naranja se reserva para lo que está pasando ahora, para que la atención vaya ahí.
- Consequences: todo cambio visual en `web/` sigue `design.md`. Si hace falta algo que no está, se agrega ahí. Aplicarlo a la interfaz es parte de #25. Las ideas de producto de la investigación (generar en segundo plano, editar señalando, historial, elegir qué placas mandar) quedan para después del MVP.
