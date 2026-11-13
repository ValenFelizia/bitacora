# Verificación del kit de turismo

La ronda de retrabajo y sus resultados actuales están en [review.md](review.md).
Incluye descarga pública real, lista de links escritos por la usuaria y las
tres nuevas corridas de 43 pruebas. Los registros de 37 pruebas más abajo
corresponden a la primera entrega.

Ejecutada en Windows con el Codex 0.168.0 fijado por npm y Edge del sistema.

- `pieza-1.png`: PNG real de 1080 × 1920, escala 1, con Arial cargada desde
  una copia de `C:\Windows\Fonts\arial.ttf` dentro de una agencia de prueba.
- `piezas.pdf` y `todas.png`: salidas del mismo dibujo.
- `control.md`: control del HTML de ejemplo contra líneas explícitas de fuente.
- `protocol.json`: catálogo real de app-server, llamadas a las tres herramientas,
  lista vacía de solicitudes de aprobación, cero turnos de modelo, errores de
  desborde y rechazo de una fuente local rota.

Reproducir: `npm install`, `npm run typecheck`, `npm test`,
`npx tsx scripts/verify-kit.ts`. No requiere cuenta de ChatGPT.

## Alcance y límites

Las pruebas automáticas comprueban además un servidor HTTP de operador sintético,
descarga de foto, agregado de notas conservando las líneas anteriores, rechazo de
loopback sin habilitación de prueba y de una redirección a otra dirección privada,
rutas con espacios/acentos/ñ, enlaces y nombres especiales, preservación de archivos
existentes del kit, citas ausentes o incorrectas, recursos externos bloqueados,
medidas PNG y cabecera PDF, y llamadas de un cliente MCP independiente.

No se hicieron pedidos a ChatGPT, login, instalación de programas por la usuaria,
ni pruebas de conversación con un agente real. Eso queda para el orquestador con
una persona. Tampoco se verificó empaquetado/instalador (#9), ni la presentación de
resultados en la galería (#5). Una coincidencia de número en una línea no valida
que sea el hotel o la unidad correctos: el kit exige revisar ese contexto.

La política sin aprobación se verificó con llamadas directas por app-server.
Referencia adicional: `codex-rs/config/src/mcp_types.rs` y
`codex-rs/core/src/mcp_tool_call.rs` del tag oficial `rust-v0.168.0`:
`AppToolApproval::Approve` no pide aprobación; con `Never`, las llamadas que
requieren aprobación se rechazan. La configuración se limita a tres entradas
`mcp_servers.bitacora.tools.<herramienta>.approval_mode`, sin un permiso global.

## Entrega

`typecheck` y build pasaron; las tres corridas registradas terminaron con
37/37 pruebas aprobadas cada una. No quedaron procesos de estas verificaciones.
El PR de #5 todavía estaba abierto al entregar: `origin/main` está integrado,
pero falta incorporar #5 cuando se mergee y repetir los controles combinados.

La limpieza final de `%LOCALAPPDATA%\Bitacora-dev\issue6` fue rechazada por la
revisión automática («blocked by policy»). Quedaron dos carpetas de pruebas
interrumpidas; las verificaciones terminadas eliminaron sus propios datos.
