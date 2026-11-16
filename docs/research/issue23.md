# Issue #23 — Qué trae Codex `0.168.0` de fábrica en Bitácora, riesgos y opciones

Investigación realizada el 2026-11-16 sobre `@openai/codex@0.168.0` (fijado en [`package.json`](../../package.json)), lanzado como `codex app-server` por [`server/src/codex/engine.ts`](../../server/src/codex/engine.ts) con `CODEX_HOME` propio y el servidor MCP de [`server/src/codex/kit.ts`](../../server/src/codex/kit.ts), frente a las reglas de [`.csdd/specs.md`](../../.csdd/specs.md), [`.csdd/decisions.md`](../../.csdd/decisions.md) (DEC-008 y DEC-010) y [`kit/turismo/AGENTS.md`](../../kit/turismo/AGENTS.md).

> [!IMPORTANT]
> **Alcance probatorio y regla de no inferencia.** No hubo cuota de ChatGPT para correr inferencia real (`turn/start`), ni se usó una sesión autenticada de ChatGPT ni el `~/.codex` personal. Toda la evidencia proviene del binario fijado (`codex-cli 0.168.0`), esquemas generados, llamadas RPC de solo lectura al `app-server` en un `CODEX_HOME` aislado y el código fuente exacto de `openai/codex` en el tag [`rust-v0.168.0`](https://github.com/openai/codex/tree/rust-v0.168.0). Todo comportamiento que solo puede confirmarse con login ChatGPT activo o ejecutando un turno de inferencia queda marcado explícitamente como **`sin verificar`**.

---

## Resumen ejecutivo

Aunque Bitácora le da a Codex un `CODEX_HOME` aislado y define el perfil `agencia` (solo carpeta de agencia, red apagada, `traer`/`controlar`/`dibujar`), Codex `0.168.0` arranca por defecto con varias capacidades orientadas a programadores y a ChatGPT que **ignoran o tensionan** las reglas del producto:

1. **Búsqueda web alojada (`web_search`) prendida por defecto en modo `Cached`**: corre en el backend de OpenAI, por lo que **se salta** `network={enabled=false}` del sandbox local y la lista de URLs autorizadas de `traer`.
2. **Generación de imágenes (`image_generation` + skill `imagegen`) prendida por defecto**: expone la herramienta `image_gen.imagegen` para planes pagos de ChatGPT y la skill embebida `imagegen`, en conflicto directo con *"No generes imágenes con IA"* ([`.csdd/specs.md`](../../.csdd/specs.md) y `developerInstructions` en `engine.ts`).
3. **5 skills embebidas de sistema (`CODEX_HOME/skills/.system/`)**: se extraen automáticamente al disco (`imagegen`, `openai-docs`, `review-agent`, `skill-creator`, `skill-installer`). Varias promueven flujos de código, reviews de Git o descargas desde GitHub.
4. **Fuga de skills del sistema anfitrión (`%USERPROFILE%\.agents\skills\` y `C:\ProgramData\OpenAI\Codex\skills`)**: incluso con `CODEX_HOME` vacío y aislado, `app-server` descubre e inventaría skills personales de la máquina anfitriona (`scope: "user"`, 167 detectadas en la máquina de prueba). Además, el flag `features.skip_host_skill_discovery` **es ignorado** en sesiones normales en `0.168.0`.
5. **Plugins curados y clonación silenciosa en arranque (`~58,5–81 MB` / `~5.475` archivos)**: con `plugins=true`, cada `CODEX_HOME` nuevo clona en segundo plano `https://github.com/openai/plugins.git` dentro de `.tmp/plugins` (65 plugins curados, entre ellos Figma, Canva, GitHub, Hyperframes, Remotion) y habilita `tool_suggest` para sugerir instalaciones por el flujo de elicitación que `engine.ts` luego rechaza en silencio.
6. **Conectores de ChatGPT (`apps` / MCP `codex_apps` + instrucciones `<apps_instructions>`)**: están prendidos por defecto y se inyectan automáticamente cuando el usuario inicia sesión con ChatGPT (el modo R1 de Bitácora).
7. **Subagentes (`multi_agent` v1) y `sleep_tool`**: `multi_agent` sigue prendido por defecto (`deprecated = true`) y expone herramientas para abrir hilos hijos fuera de la UX de hilo único de Bitácora.

En una prueba controlada contra el binario fijado (`0.168.0`) agregando flags `-c` en `appServerArgs` (sin tocar código de producto), el arranque quedó **en `0,62 MB` (14 archivos)**, sin `.tmp/plugins`, sin `skills/.system`, con `web_search="disabled"`, `apps=false`, `image_generation=false`, `multi_agent=false` y con el MCP `bitacora` (`traer`, `controlar`, `dibujar`) intacto.

---

## Tabla maestra: qué trae Codex `0.168.0` por defecto en Bitácora

| Componente | Prendido por defecto en Bitácora | Qué hace | ¿Choca con Bitácora? | Cómo apagarlo / limitarlo |
|---|---|---|---|---|
| **Skills `.system`** (`imagegen`, `openai-docs`, `review-agent`, `skill-creator`, `skill-installer`) | **Sí** (se extraen en `CODEX_HOME/skills/.system/` y se listan en `skills/list`) | Inyecta instrucciones de generación de imágenes IA (`imagegen`), búsqueda en docs OpenAI (`openai-docs`), code review (`review-agent`), creación e instalación de skills desde GitHub (`skill-creator`, `skill-installer`). | **Sí.** `imagegen` choca con *"no AI images"*; `skill-installer` intenta bajar cosas de GitHub; las demás meten ruido técnico de programador. | `-c skills.bundled.enabled=false` (evita extracción y las saca de `skills/list`). Opcional: `-c skills.include_instructions=false`. |
| **Skills del host** (`%USERPROFILE%\.agents\skills\`, `C:\ProgramData\OpenAI\Codex\skills\`, `.agents/skills/` en ancestros del cwd) | **Sí** (descubre `scope: "user"` y `"admin"` fuera de `CODEX_HOME`) | Expone en catálogo y permite invocar vía `$nombre` skills instaladas en el perfil del usuario de Windows o del repo padre. | **Sí.** Fuga del entorno personal hacia Bitácora; sus rutas quedan bloqueadas por `agencia` (`:root=deny`) y confunden al modelo. | `skills.include_instructions=false` oculta el catálogo del prompt; para bloquear también `$nombre`, apagarlas vía `skills/config/write` (`{name, enabled:false}`) tras `skills/list`. *(Nota: `features.skip_host_skill_discovery=true` no funciona en `0.168.0`.)* |
| **Plugins curados y sync en arranque** (`plugins`, `remote_plugin`, `plugin_discovery_prefetch`, `plugin_sharing`) | **Sí** (`stable = true`) | Al iniciar, clona `openai/plugins` (`65` plugins) en `CODEX_HOME/.tmp/plugins` (`~58,5–81 MB`), consulta marketplace remoto si hay login ChatGPT y habilita instalar/usar plugins con MCPs/skills propios. | **Sí.** Red en arranque hacia GitHub/ChatGPT, peso extra en disco de datos, y plugins ajenos al kit (`figma`, `canva`, `github`, etc.). | `-c features.plugins=false`, `-c features.remote_plugin=false`, `-c features.plugin_discovery_prefetch=false`, `-c features.plugin_sharing=false` (y opcional `[plugins._default] enabled=false`). |
| **Sugerencia de plugins** (`tool_suggest`) | **Sí** (`stable = true`, requiere `plugins && apps`) | Expone `list_available_plugins_to_install` y `request_plugin_install` (`30` plugins en allowlist), disparando `mcpServer/elicitation/request`. | **Sí.** Ofrece a una usuaria no técnica instalar conectores externos; `engine.ts` auto-declina la elicitación tras gastar turnos. | `-c features.tool_suggest=false` (también se apaga en cascada si `plugins=false` o `apps=false`). |
| **Apps / Conectores ChatGPT** (`apps`, `include_apps_instructions`, MCP `codex_apps`) | **Sí** (`stable = true`, efectivo con login ChatGPT) | Con login ChatGPT (`AuthMode::uses_codex_backend`), registra automáticamente el servidor MCP interno `codex_apps` e inyecta `<apps_instructions>` con conectores de la cuenta. Efecto real con cuenta conectada: **`sin verificar`**. | **Sí.** Abre integraciones externas fuera de `traer`, introduce conectores que la usuaria no espera y agrega ruido al prompt. | `-c features.apps=false` y `-c include_apps_instructions=false` (defensa adicional: `[apps._default] enabled=false`). |
| **Web search alojado** (`web_search`) | **Sí** (`null` resuelve a `Cached`) | Adjunta la herramienta alojada `web_search` en la Responses API (con `external_web_access: false` en `Cached`, índice cacheado de OpenAI). Invocación real en turno: **`sin verificar`**. | **Sí.** Permite consultar internet indirectamente sin pasar por `traer` ni respetar el `network.enabled=false` del sandbox local. | `-c web_search="disabled"`. |
| **Generación de imágenes** (`image_generation` → `image_gen.imagegen`) | **Sí** (`stable = true`, activo en planes ChatGPT pagos con modelos multimodales) | Expone la herramienta integrada `image_gen.imagegen` y guarda imágenes en `$CODEX_HOME`. Ejecución real en turno: **`sin verificar`**. | **Sí (crítico).** Contradice directamente la regla *"No generes imágenes con IA"* de `.csdd/specs.md`, `AGENTS.md` del kit y `developerInstructions`. | `-c features.image_generation=false`. |
| **Subagentes v1** (`multi_agent`) | **Sí** (`deprecated = true`; `multi_agent_v2` es `false`) | Registra `spawn_agent`, `send_input`, `wait_agent`, `resume_agent`, `close_agent`. Comportamiento en turno: **`sin verificar`**. | **Parcial.** Bitácora modela un solo trabajo por hilo (`R2`) y no presenta árboles de subagentes en UI. | `-c features.multi_agent=false` y `-c agents.enabled=false`. |
| **`sleep_tool`** (`clock.sleep`) | **Sí** (`stable = true`, `SleepToolMode::ModelDriven`) | Registra la herramienta `clock.sleep` para pausas del modelo si el modelo la pide. Uso por el modelo: **`sin verificar`**. | **Bajo / ruido.** Innecesaria para armar piezas locales; puede alargar turnos esperando sin utilidad. | `-c features.sleep_tool=false`. |
| **Hooks de workspace/plugins** (`hooks`) | **Sí** (`stable = true`) | Descubre y ejecuta hooks declarados en `.codex/hooks.json` del repo o en plugins. | **Bajo / preventivo.** Con carpeta vacía no hay hooks, pero un repo/kit importado podría traer hooks no revisados. | `-c features.hooks=false`. |
| **Instalación de MCP desde skills** (`skill_mcp_dependency_install`) | **Sí** (`stable = true`, pero limitado por originator `first-party`) | Propone instalar servidores MCP declarados en `SKILL.md` vía `request_user_input`. Ya bloqueado en parte porque Bitácora se identifica como `"bitacora"` (`mcp_skill_dependencies.rs:48`). | **Bajo.** Bloqueado por `originator` y porque `engine.ts` responde `{}` a `requestUserInput`. | `-c features.skill_mcp_dependency_install=false` por higiene explícita. |
| **Búsqueda de skills en nube/herramientas** (`skill_search`) | **Sí** (`stable = true`) | Activa herramientas `skills.*` si hay `cloud_skills` o `executor_capability_discovery` (`tools_enabled`), ninguno activo en el entorno local sin login de nube. | **Bajo.** Inerte en flujo local sin cloud skills. | `-c features.skill_search=false` si se quiere superficie mínima. |
| **Herramientas base de trabajo** (`shell_tool`, `unified_exec`, `apply_patch`, `view_image`) | **Sí** (`stable = true`) | `exec_command`/`write_stdin` (PowerShell dentro de `agencia`), `apply_patch` (edición), `view_image` (inspección visual de PNGs). Ejecución completa con modelo: **`sin verificar`**. | **No (necesarias).** `view_image` es requerida explícitamente por `kit/turismo/AGENTS.md` (*"Revisá las fotos chicas y mirá todas las piezas"*). | **Mantener prendidas.** |
| **MCP `bitacora` + herramientas de recursos MCP** (`traer`, `controlar`, `dibujar` + `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) | **Sí** (configurado por `kit.ts`; resource tools automáticas si hay cualquier MCP) | Expone el kit en `config.toml`; Codex adjunta además los 3 helpers de lectura de recursos MCP (`bitacora` expone `resources: []`). | **No (núcleo del kit).** | **Mantener prendidas.** |
| **`request_user_input`** (`tools.experimental_request_user_input`) | **Sí** (solo en modo `Plan`; `default_mode_request_user_input = false`) | Permite al modelo pedir opciones estructuradas; `engine.ts` no cambia a modo Plan y responde `{ answers: {} }`. | **Bajo.** En modo `Default` no debería registrarse (`request_user_input_available_modes`), aunque queda **`sin verificar`** en turno real. | `-c tools.experimental_request_user_input.enabled=false` (opcional). |
| **Flags de app de escritorio** (`computer_use`, `browser_use*`, `in_app_*`, `goals`, `guardian_approval`) | **Sí** (`stable = true`) | Bandera de configuración o gating de UI/desktop/Guardian; **no** registran herramientas de navegador/mouse ni objetivos propios en `codex app-server`. | **No (sin superficie de herramientas en `app-server`).** | No requiere acción; se pueden ignorar. |
| **`update_plan`, `memories`, `multi_agent_v2`, `code_mode`, `network_proxy`** | **No** (`false` por defecto en `CODEX_HOME` limpio) | `update_plan` es `opt-in`; `memories` y `multi_agent_v2` vienen en `false` en `0.168.0` limpio. | **No mientras sigan apagados.** *(Ojo: `memories` crea igual un `memories_1.sqlite` vacío al inicializar.)* | Fijar `-c features.memories=false` explícito protege ante futuros cambios de versión de Codex. |

---

## Evidencia por componente

### 1. Cómo lanza Bitácora a Codex hoy

- [`package.json`](../../package.json#L17): fija `"@openai/codex": "0.168.0"`. Al consultar `npx codex --version`, el binario resuelto por [`scripts/codex-runtime.mjs`](../../scripts/codex-runtime.mjs) responde `codex-cli 0.168.0`.
- [`server/src/codex/engine.ts`](../../server/src/codex/engine.ts#L42-L69): `appServerArgs` solo pasa `--listen stdio://`, `-c cli_auth_credentials_store="file"` y, cuando aplica MXC o antes de decidir backend, `default_permissions="agencia"` junto con `permissions.agencia={extends=":workspace",filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"},network={enabled=false}}`. **No deshabilita** `web_search`, `plugins`, `apps`, `image_generation`, `multi_agent` ni `skills`.
- [`server/src/codex/engine.ts`](../../server/src/codex/engine.ts#L864-L876): ante solicitudes interactivas del servidor (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `mcpServer/elicitation/request`, `item/tool/requestUserInput`), el cliente rechaza o devuelve `{ answers: {} }`.
- [`server/src/codex/engine.ts`](../../server/src/codex/engine.ts#L1055-L1056): `developerInstructions` solo instruye en texto: `"Respondé en castellano rioplatense, simple y sin términos técnicos. Trabajá en la carpeta actual. No generes imágenes con IA."` (mitigación por prompt, no técnica).
- [`server/src/codex/kit.ts`](../../server/src/codex/kit.ts#L8-L22): `registerKit` escribe únicamente `[mcp_servers.bitacora]` en `<CODEX_HOME>/config.toml` con `enabled_tools = ["traer", "controlar", "dibujar"]` aprobadas.
- [`kit/turismo/`](../../kit/turismo/AGENTS.md): verificado en el árbol completo del repo; el kit no contiene carpetas `.agents/` ni archivos `SKILL.md`. Toda su guía está en `AGENTS.md` y `entrevista.md`.

### 2. Sonda de `features list` y esquema del protocolo

Con un `CODEX_HOME` temporal vacío (para no heredar flags del `~/.codex` personal de la máquina, donde por ejemplo `memories` figuraba prendido):

```powershell
$env:CODEX_HOME = "<dir-vacio>"
codex.exe features list
```

Resultado en `0.168.0`: 210 flags en total, **80 habilitados por defecto** (`stable = true` o `deprecated/removed = true`), incluyendo `apps`, `plugins`, `remote_plugin`, `plugin_discovery_prefetch`, `plugin_sharing`, `tool_suggest`, `image_generation`, `multi_agent` (`deprecated true`), `sleep_tool`, `hooks`, `skill_mcp_dependency_install`, `skill_search`, `view_image`, `shell_tool`, `unified_exec`, `browser_use*`, `computer_use`, `in_app_*`, `goals`, `guardian_approval`; y en `false`: `memories`, `multi_agent_v2`, `code_mode`, `skip_host_skill_discovery`, `recommended_plugins`, `network_proxy`.

También se verificó la generación de esquemas y flags de CLI:
- `npx codex app-server --help` confirma los flags soportados: `-c, --config <key=value>`, `--disable <FEATURE>`, `--print-startup-config` y `--strict-config`.
- `npx codex app-server generate-json-schema --experimental --out <tmp>` generó el esquema completo v1/v2 coincidente con los tipos versionados en [`server/src/codex/generated/v2/`](../../server/src/codex/generated/v2/), incluidos [`Config.ts`](../../server/src/codex/generated/v2/Config.ts), [`SkillsConfigWriteParams.ts`](../../server/src/codex/generated/v2/SkillsConfigWriteParams.ts) y [`AppsConfig.ts`](../../server/src/codex/generated/v2/AppsConfig.ts).

### 3. Sonda RPC sobre `codex app-server` (línea base actual de Bitácora)

Se lanzó `codex.exe` (`0.168.0`) exactamente con `appServerArgs("mxc")` y `registerKit(home, workspace)` sobre un `CODEX_HOME` aislado y un entorno limpio (sin credenciales ni variables `CODEX_*`/`OPENAI_*`), negociando `initialize` con `experimentalApi: true` y consultando métodos de solo lectura (sin `turn/start`):

- **`config/read` (`includeLayers: true`)**:
  - `web_search: null` (que [`codex-rs/core/src/config/mod.rs:4047-4048`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/config/mod.rs#L4047-L4048) resuelve con `.unwrap_or(WebSearchMode::Cached)`).
  - `include_apps_instructions: true`.
  - `mcp_servers.bitacora` cargado y sano en `mcpServerStatus/list` con `traer`, `controlar`, `dibujar` y `resources: []`.
- **`skills/list` (`forceReload: true`)**:
  - Devolvió **5 skills `scope: "system"`**, todas con `enabled: true`, extraídas en `<CODEX_HOME>\skills\.system\<nombre>\SKILL.md`: `imagegen`, `openai-docs`, `review-agent`, `skill-creator`, `skill-installer`.
  - Devolvió además **167 skills `scope: "user"`**, todas `enabled: true`, leídas desde `C:\Users\Valen\.agents\skills\*\SKILL.md`.
- **Estado en disco de `<CODEX_HOME>` sin endurecer**:
  - Apenas iniciado el `app-server`, lanzó un hilo `plugins-curated-repo-sync` que ejecutó `git fetch` sobre `https://github.com/openai/plugins.git` (con respaldo HTTP a GitHub API / `chatgpt.com/backend-api/plugins/export/curated` según [`codex-rs/core/src/plugins/startup_sync.rs:30-166`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/plugins/startup_sync.rs#L30-L166)).
  - En la prueba corta se observaron **5.434 archivos (81,09 MB)** en `.tmp/plugins-clone-*`; dejando correr 12 segundos, completó la activación en `.tmp/plugins/` con **5.475 archivos (58,50 MB)** y `.tmp/plugins.sha`.
  - Al leer `.tmp/plugins/.agents/plugins/marketplace.json`, el catálogo `openai-curated` contiene **65 plugins** (Productividad: `linear`, `notion`, `google-drive`, `google-calendar`, `airtable`, `dropbox`, etc.; Creatividad: `canva`, `figma`, `adobe`, `hyperframes`, `remotion`, `chatcut`, `higgsfield`, etc.; Comunicación: `gmail`, `slack`, `zoom`, `teams`, etc.; Desarrollo/Seguridad/Finanzas: `github`, `vercel`, `supabase`, `stripe`, `sentry`, etc.).
- **`plugin/list` y `app/list` sin autenticación**:
  - `plugin/list` devolvió `marketplaces: []` sin login porque [`PluginsManager::target_curated_marketplace`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/plugins/manager.rs#L3752-L3763) devuelve `OpenAiApi` (que busca `api_marketplace.json`) cuando no hay auth ChatGPT, mientras que con `AuthMode::uses_codex_backend` (login ChatGPT de Bitácora) devuelve `OpenAiWithRemote` y expone `openai-curated` + marketplaces remotos.
  - `app/list` devolvió `data: []` sin login ChatGPT, pero [`codex-rs/core/src/mcp/mod.rs:475-490`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/mcp/mod.rs#L475-L490) registra `codex_apps` incondicionalmente siempre que `mcp_config.apps_enabled` sea `true` y la sesión no sea `SessionIsolation::Isolated`.

### 4. Referencias primarias en `openai/codex@rust-v0.168.0` para mecanismos de control

- **Flags de características**: [`codex-rs/features/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/features/src/lib.rs#L1441-L2041) define las claves exactas (`plugins`, `remote_plugin`, `plugin_discovery_prefetch`, `plugin_sharing`, `tool_suggest`, `apps`, `image_generation`, `multi_agent`, `sleep_tool`, `hooks`, `memories`, `skill_mcp_dependency_install`, `skill_search`, `skip_host_skill_discovery`).
- **Skills integradas y fuga del host**:
  - [`codex-rs/core/src/skills/config.rs`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/skills/config.rs#L19-L56): `SkillsConfig` expone `bundled.enabled`, `include_instructions` y `config: Vec<SkillConfig>` (que acepta selector por `name` o por `path`).
  - [`codex-rs/ext/skills/src/host_roots.rs`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/ext/skills/src/host_roots.rs#L150-L180): inyecta `home_dir().join(".agents/skills")` (`User`) y el layer `System` (`C:\ProgramData\OpenAI\Codex\skills`) (`Admin`), además de `.agents/skills/` del repo/cwd.
  - [`codex-rs/core/src/session/session.rs:691-695`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/session/session.rs#L691-L695) y [`codex-rs/ext/skills/src/extension.rs:304-306`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/ext/skills/src/extension.rs#L304-L306): `Feature::SkipHostSkillDiscovery` exige `!extensions.requires_host_skill_discovery()`, pero `SkillsExtension` siempre retorna `self.providers.has_host_provider()` (`true`). Por eso `-c features.skip_host_skill_discovery=true` **no** detiene la carga de `%USERPROFILE%\.agents\skills\`.
  - [`codex-rs/ext/skills/src/extension.rs:208,400,434`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/ext/skills/src/extension.rs#L208-L445): `skills.include_instructions = false` suprime la inyección del catálogo `<skills_instructions>` tanto al iniciar hilo como por turno; sin embargo, una mención explícita `$nombre` en el mensaje del usuario sigue cargando la skill si no está deshabilitada en `skills.config`.
  - [`codex-rs/app-server/src/request_processors/catalog_processor.rs:727-763`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/app-server/src/request_processors/catalog_processor.rs#L727-L763): el método RPC `skills/config/write` acepta `{ name, enabled }` además de `{ path, enabled }`.
- **Herramientas expuestas en el plan de turno**:
  - [`codex-rs/core/src/tools/spec_plan.rs`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/tools/spec_plan.rs#L723-L855): `web_search` alojada (`hosted_model_tool_specs`), `tool_suggest` (`tool_suggest_enabled`), `image_gen.imagegen` (`image_generation_available`, activa cuando `ImageGeneration` está habilitado, plan `!= Free`, auth ChatGPT y modelo con entrada de imagen), `multi_agent` (`collab_tools_enabled` y [`core/src/config/mod.rs:1723-1730`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/config/mod.rs#L1723-L1730) donde `agents.enabled = false` fuerza `MultiAgentVersion::Disabled` incluso sobre metadatos del modelo).
  - [`codex-rs/core/src/mcp_skill_dependencies.rs:47-60`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/mcp_skill_dependencies.rs#L47-L60): `SkillMcpDependencyInstall` ya se corta si el originator no es `first-party`, y además se apaga con `features.skill_mcp_dependency_install=false`.
- **Flags solo de app de escritorio**: búsqueda directa sobre `openai/codex` muestra que `Feature::ComputerUse` y `Feature::BrowserUse` solo se declaran en `features/src/lib.rs` y no registran herramientas en `codex app-server`.

### 5. Sonda RPC con flags de endurecimiento (verificación sin inferencia)

Se ejecutó una segunda sonda sobre un `CODEX_HOME` limpio con `appServerArgs("mxc")` + `registerKit` + los siguientes `-c`:

```text
-c features.plugins=false
-c features.remote_plugin=false
-c features.plugin_discovery_prefetch=false
-c features.plugin_sharing=false
-c features.tool_suggest=false
-c features.apps=false
-c include_apps_instructions=false
-c web_search="disabled"
-c features.image_generation=false
-c features.multi_agent=false
-c features.sleep_tool=false
-c features.memories=false
-c features.hooks=false
-c skills.bundled.enabled=false
-c skills.include_instructions=false
```

Resultados medidos tras 5 segundos de vida del proceso:
- **`stderr`**: vacío (cero errores o advertencias de configuración).
- **Peso en disco de `CODEX_HOME`**: **14 archivos / 650.762 bytes (`0,62 MB`)** frente a **5.475 archivos / 58.501.684 bytes (`55,8 MB`, hasta `81 MB` durante clone)** sin endurecer. No se creó `skills\.system` ni `.tmp\plugins`.
- **`skills/list`**: **0 skills de sistema**. Se validó también `skills/config/write` con `{ name: "<skill-de-usuario>", enabled: false }`: respondió `{ effectiveEnabled: false }` y el recuento habilitado en `scope: "user"` bajó en el acto.
- **`config/read`**: confirmó `web_search: "disabled"`, `include_apps_instructions: false`, `skills.bundled.enabled: false`, `skills.include_instructions: false` y todas las features anteriores en `false`.
- **`mcpServerStatus/list`**: `bitacora` siguió conectado con `traer`, `controlar` y `dibujar` activos.

---

## Qué quedó "sin verificar"

Por falta de cuota de ChatGPT y restricción de no correr inferencia ni usar cuentas reales:

1. **Conectores y plugins remotos con cuenta autenticada (`sin verificar`)**: qué conectores concretos devuelve `codex_apps` (`app/list`) y qué plugins remotos aparecen en `plugin/list` cuando hay un token de ChatGPT activo.
2. **Comportamiento real del modelo en `turn/start` (`sin verificar`)**: si el modelo intenta invocar `image_gen.imagegen`, `web_search` o `clock.sleep` pese a `developerInstructions`, y cómo reacciona ante `skills.include_instructions=false`.
3. **Smoke test de punta a punta del kit con los flags aplicados (`sin verificar`)**: confirmar en un turno real con cuota que `traer` -> `controlar` -> `dibujar` + `view_image` siguen completando una propuesta turística de punta a punta sin regresiones.

---

## Riesgos concretos para Bitácora

1. **Violación silenciosa de reglas del producto (`web_search` e `image_gen`)**: hoy el sandbox MXC bloquea red saliente en PowerShell, pero **no** bloquea `web_search` ni `image_gen` porque ambos corren del lado de OpenAI en la Responses API. El agente puede buscar precios/textos en la web fuera de `traer` (rompiendo trazabilidad de citas de `controlar`) o generar imágenes IA (rompiendo `.csdd/specs.md`).
2. **Tráfico y peso ocultos al iniciar (`~58,5–81 MB` de `openai/plugins`)**: cada `CODEX_HOME` nuevo dispara `git` contra GitHub para clonar 65 plugins que Bitácora no usa, añadiendo miles de archivos y consumo de red en un arranque pensado para una usuaria no técnica.
3. **Fuga de skills del perfil de Windows (`%USERPROFILE%\.agents\skills\`)**: si la usuaria (o alguien en esa PC) instaló Codex/Claude/herramientas en su usuario, esas skills aparecen en `skills/list` y en el catálogo aunque Bitácora haya separado `CODEX_HOME`. Sus archivos quedan ilegibles bajo MXC `:root=deny`, produciendo errores confusos.
4. **Fricción por herramientas de programador o subagentes (`multi_agent`, `tool_suggest`, `.system`)**: `tool_suggest` dispara pedidos de instalación que `engine.ts` rechaza sin feedback; `review-agent`, `skill-creator`, `skill-installer` y `spawn_agent` pueden desviar al agente del flujo simple de un solo hilo (`R2`, `R3`).
5. **Deriva al actualizar `@openai/codex`**: Codex cambia defaults con frecuencia (`memories` ya estaba en transición, `multi_agent` pasó a `deprecated` mientras `multi_agent_v2` avanza). Sin fijar explícitamente los `-c` en el arranque, una subida de versión puede reintroducir herramientas nuevas por defecto.

---

## Opciones y recomendación

### Opción A — Apagado mínimo puntual

Pasar solo los `-c` indispensables para los conflictos más graves: `web_search="disabled"`, `features.image_generation=false`, `skills.bundled.enabled=false`, `features.plugins=false`, `features.apps=false`, `include_apps_instructions=false`.

- **Pros:** cambio mínimo (~6 líneas en `appServerArgs` de [`engine.ts`](../../server/src/codex/engine.ts)).
- **Contras:** deja prendidos `multi_agent`, `sleep_tool`, `hooks`, `tool_suggest` (aunque inactivo sin `plugins`/`apps`) y no bloquea las skills que lleguen desde `%USERPROFILE%\.agents\skills\`.

### Opción B — Endurecimiento completo por `-c` en `engine.ts` + bloqueo de skills del host **(Recomendada)**

Concentrar en `appServerArgs` de [`server/src/codex/engine.ts`](../../server/src/codex/engine.ts) una lista explícita de `-c` (sin ensuciar el `config.toml` de datos ni afectar el `~/.codex` personal), manteniendo prendidas solo las capacidades necesarias (`exec_command`/`write_stdin`, `apply_patch`, `view_image`, `mcp_servers.bitacora`):

1. **Flags de arranque recomendados en `appServerArgs`** (aplicables en todos los backends, tanto `mxc` como `elevated`):
   - `-c web_search="disabled"`
   - `-c features.image_generation=false`
   - `-c features.plugins=false`
   - `-c features.remote_plugin=false`
   - `-c features.plugin_discovery_prefetch=false`
   - `-c features.plugin_sharing=false`
   - `-c features.tool_suggest=false`
   - `-c features.apps=false`
   - `-c include_apps_instructions=false`
   - `-c features.multi_agent=false` y `-c agents.enabled=false`
   - `-c features.sleep_tool=false`
   - `-c features.hooks=false`
   - `-c features.memories=false`
   - `-c features.skill_mcp_dependency_install=false`
   - `-c features.skill_search=false`
   - `-c skills.bundled.enabled=false`
   - `-c skills.include_instructions=false`
2. **Cierre opcional de la fuga `$nombre` desde `%USERPROFILE%\.agents\skills\`**: tras `initialize` en [`engine.ts`](../../server/src/codex/engine.ts), llamar `skills/list` y, para toda skill retornada con `enabled === true`, llamar `skills/config/write` con `{ name: skill.name, enabled: false }` (o evaluar en futuro si algún kit llegara a definir sus propias `SKILL.md`, manteniendo una allowlist explícita).
   - *Nota:* como ya muestra `skills.include_instructions=false`, esto por sí solo oculta el catálogo del prompt; el paso `skills/config/write` evita incluso que una mención accidental `$algo` en el chat cargue una skill externa.

- **Costo de implementación:**
  - ~20–35 líneas en [`server/src/codex/engine.ts`](../../server/src/codex/engine.ts) (`appServerArgs` + opcionalmente un pase `skills/list` -> `skills/config/write` en el arranque).
  - 1 test de integración sin inferencia en [`server/test/codex.test.ts`](../../server/test/codex.test.ts) (verificando `config/read`, `skills/list` sin skills de sistema, `mcpServerStatus/list` con `bitacora` y ausencia de `.tmp/plugins` y `skills/.system` en el `CODEX_HOME` de prueba).
  - 1 prueba manual corta con cuota cuando vuelva el límite (18 de noviembre) para certificar el recorrido `traer` -> `controlar` -> `dibujar` + `view_image`.
  - **Riesgo de reversión:** nulo; son flags de línea de comandos por proceso, no migran ni borran archivos del usuario.

### Opción C — Aislamiento del home del SO (`USERPROFILE` / `HOME`) o parche del paquete

Redefinir `USERPROFILE`/`HOME` al subproceso `codex` para que ni siquiera vea `%USERPROFILE%\.agents\skills\`, o eliminar/parchear archivos del paquete `@openai/codex` en el instalador.

- **Pros:** corta en la raíz la lectura de `~/.agents/skills`.
- **Contras y costo:** **alto riesgo en Windows.** Cambiar `USERPROFILE` en Windows puede romper rutas de sistema, credenciales/DPAPI, variables heredadas hacia PowerShell dentro del sandbox MXC y descubrimiento de Edge por `playwright-core`. Parchear un binario Rust tampoco remueve `skills/.system` porque están compiladas dentro de `codex.exe` con `include_dir!`.

**Recomendación:** adoptar la **Opción B**. Cierra toda la superficie no deseada (`web_search`, `image_generation`, `apps`, `plugins` + clon de 58–81 MB, `skills/.system`, catálogo de skills del host, `multi_agent`, `sleep_tool`, `hooks`), preserva al 100 % `traer`/`controlar`/`dibujar`, `view_image` y el perfil `agencia`, no toca ningún archivo fuera de Bitácora y tiene costo acotado y reversible.
