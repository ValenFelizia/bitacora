> [!NOTE]
> 🤖 **GPT-6.1 Sol responding on behalf of ValenFelizia**

Elegido **MXC explícito**, sin fallback a ejecución desprotegida. Investigación del 2026-11-13, sin pedidos al modelo.

## Modos y requisitos

- `mxc`: protección nativa por proceso, sin aprobación administrativa, cuentas adicionales ni reglas locales de firewall. Necesita capacidades MXC del sistema y que la política permita usarlo. Microsoft las introdujo en 26100.9278 / 26200.9278; el número de build por sí solo no prueba disponibilidad.
- `elevated`: alternativa anterior; preparación con aprobación administrativa, ejecución posterior sin privilegios administrativos. Prepara cuentas restringidas, permisos de archivos y reglas de red.
- `unelevated`: alternativa anterior con red más débil y sin rutas de lectura denegadas. No lo seleccionamos ni lo probamos: no hace falta bajar a este modo cuando MXC funciona.

Fuente: [documentación oficial de Windows](https://learn.chatgpt.com/docs/windows/windows-sandbox). No se modificaron funciones opcionales de Windows.

## Protocolo exacto 0.168.0

Tipos versionados en `server/src/codex/generated/v2/WindowsSandbox*.ts`, generados con `codex app-server generate-ts` en el esqueleto:

- `windowsSandbox/readiness` sin parámetros devuelve `ready`, `notConfigured` o `updateRequired`.
- `windowsSandbox/setupStart` recibe `{mode: "elevated" | "unelevated", cwd?: rutaAbsoluta}` y responde `{started: boolean}`. **No admite `mxc`**.
- `windowsSandbox/setupCompleted` notifica `{mode, success, error}`. La respuesta `started` no equivale a preparación exitosa.
- Para MXC se escribe `[windows] sandbox = "mxc"` en el `config.toml` del home propio, con `config/value/write`, y se relanza app-server. Para los modos anteriores, el setup persiste la selección al terminar; también hay que recargar la configuración.
- Readiness considera listo MXC efectivo; para `elevated` consulta si el setup está completo; un token restringido (`unelevated`) puede informar listo sin setup. Por eso Bitácora exige también una selección explícita `mxc` o `elevated`.

Fuentes leídas **con `gh api`, sin clonar**, agregando `?ref=rust-v0.168.0` y `-H 'Accept: application/vnd.github.raw+json'`:

- [`windows_sandbox_processor.rs`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/app-server/src/request_processors/windows_sandbox_processor.rs): despacho, parámetros, notificación y cálculo de readiness.
- [`core/src/windows_sandbox.rs`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/windows_sandbox.rs): `run_windows_sandbox_setup_and_persist`, persistencia posterior al éxito.
- [`windows_sandbox_config.rs`](https://github.com/openai/codex/blob/rust-v0.168.0/codex-rs/core/src/config/windows_sandbox_config.rs): selección efectiva, requisitos administrados y prohibición de MXC.

No usamos `features.prefer_mxc`: admite fallback. La selección explícita falla si MXC no se puede aplicar.

## Esta máquina

- `Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' | Select ProductName,CurrentBuild,UBR`: build **26300.9974**. El campo histórico ProductName dice Windows 10 Pro; el entorno identificado por el operador es Windows 11 Pro.
- `codex --version` del PATH dio **0.169.0**, distinto de la versión fijada. No se cambió la instalación personal. Se instaló una copia de `@openai/codex@0.168.0` con `npm install --prefix "$env:LOCALAPPDATA\Bitacora-dev\issue12\runtime" @openai/codex@0.168.0 --no-audit --no-fund` y se seleccionó su exe con `BITACORA_CODEX_BIN`.
- Con esa copia: `codex --version` → `codex-cli 0.168.0`.
- Con `CODEX_HOME=%LOCALAPPDATA%\Bitacora-dev\issue12\data\codex` y cwd `...\issue12\workspace`, `codex -c windows.sandbox=mxc sandbox --include-managed-config --permission-profile :workspace -- cmd.exe /d /c echo MXC_OK` → **MXC_OK**, salida **0**. También funcionó con el binario del PATH; la conclusión para este issue usa la copia fijada.
- El botón de Bitácora escribió `[windows] sandbox = "mxc"` en ese home y, tras relanzar, confirmó `ready`. No hubo UAC ni preparación legacy. Disponibilidad de `elevated`/`unelevated`: documentada, **no certificada en esta máquina**, porque no fue necesario modificar el sistema para probarlos.

No se leyó ni usó el home personal de Codex. No se usó acceso total. La prueba de compatibilidad ejecuta un comando fijo, sin inferencia. Las pruebas reales de escritura se registran por separado en la entrega del PR.
