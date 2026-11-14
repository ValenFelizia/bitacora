# Verificación del issue #4

**Informe histórico del primer PR (`ecfafed`).** El diseño de restauración y sus
limitaciones fueron reemplazados por el [retrabajo](rework.md). Las capturas de
pantalla se actualizaron y ya corresponden al diseño nuevo. La investigación beta
de lecturas y `permissions.json` no se modificaron.

2026-11-13. Windows nativo, Codex fijado 0.168.0. Sin login, inferencia,
administrador, cambios al home personal ni acceso total. Sólo esta copia del repo.

## Copias, restauración y pantalla

Pruebas automáticas con FakeEngine: copia antes de enviar, crear/modificar/borrar,
subcarpetas, espacios, acentos y ñ, deduplicación, recuperación tras reinicio incluso
con pedido pendiente, consumo de Deshacer, aviso genérico separado al motor,
resultados que desaparecen y reaparecen, exclusiones, topes, ACL de carpeta ilegible,
bloqueo exclusivo Windows, junctions exteriores y sustitución de un destino por una
junction antes de restaurar, y limpieza de objetos. Las solicitudes iniciadas por
el proceso falso reciben rechazo, respuesta vacía o error explícito y el turno
termina; ninguna se presenta como aprobación a la usuaria.

`npm run typecheck`, `npm test` tres veces y `npm run build` pasan.

Pantalla con FakeEngine y Edge en **5184/4328**: pedido, botón, confirmación,
cancelación, confirmación efectiva, mensaje de restauración y botón consumido.
Capturas: `01-request.png`, `02-confirm.png`, `03-restored.png`, abiertas y revisadas.
El preview compartido falló dos veces con `Preview automation snapshot timed out
after 15000ms`; se usó Playwright con Edge como alternativa.

Reproducir: `npx tsx scripts/verify-undo-browser.ts` (dejar esa terminal abierta),
`npx tsx scripts/capture-undo-browser.ts`; Enter en la primera cierra y limpia.
No se usaron ni detuvieron los servicios de 5173/4317.

## Rendimiento

`npx tsx scripts/benchmark-undo.ts`. Datos sintéticos: 2.000 archivos JPG de 16 KiB
con contenido distinto y cuatro de 16 MiB. No se decodifican como fotos: se mide E/S.
99.876.864 bytes lógicos (95,25 MiB). Una corrida de referencia, sin promesa de SLA.
Los tiempos incluyen la consulta del espacio ocupado por objetos y manifiesto.

| Operación | Tiempo | Contenido guardado | Manifiesto |
| --- | ---: | ---: | ---: |
| Primera copia | 5.897 ms | 99.876.864 B | 649.034 B |
| Pedido sin cambios (copia y comparación final) | 2.019 ms | 99.876.864 B | 324.519 B |
| Pedido con un archivo cambiado (copia y comparación final) | 2.256 ms | 99.893.248 B | 649.029 B |
| Deshacer | 3.731 ms | 0 B tras limpieza | 131 B |

Mediciones completas: `benchmark.json`. No cambió el espacio de contenido en el
pedido sin cambios; el archivo cambiado sumó sólo 16 KiB. Espacio lógico de archivos,
sin medir bloques físicos de NTFS ni consumo de memoria. El siguiente pedido tras
Deshacer vuelve a calcular hashes, porque la caché se invalida.

## Perfil beta de lecturas

`npx tsx scripts/verify-undo-permissions.ts` usa un CODEX_HOME propio bajo `.local/`,
dos conexiones app-server, `command/exec` y datos testigo. Comandos y salidas
literales en `permissions.json`. Tipos contrastados con:

```text
codex app-server generate-ts --experimental --out .local/issue4-schema
```

Perfil probado (sin mezclar `sandboxPolicy` ni `sandbox_mode`):

```toml
approval_policy = "never"
default_permissions = "agencia"
cli_auth_credentials_store = "ephemeral"
[windows]
sandbox = "mxc"
[permissions.agencia]
extends = ":workspace"
[permissions.agencia.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"
[permissions.agencia.network]
enabled = false
```

- Con `experimentalApi: false`, `command/exec.permissionProfile` devuelve
  `-32600`, `command/exec.permissionProfile requires experimentalApi capability`.
- Con `experimentalApi: true`, el perfil aparece en `permissionProfile/list` y
  Windows informa `ready` con MXC explícito.
- PowerShell absoluto de System32, `-NoProfile -NonInteractive -Command`:
  `Write-Output SIMPLE_OK` → exit 0, `SIMPLE_OK`.
- `Get-Content -LiteralPath <agencia>/inside.txt -ErrorAction Stop` → exit 0,
  `INSIDE_WITNESS`.
- Mismo comando sobre `<base>/outside.txt`, fuera de agencia → exit 1,
  `Access to the path ... is denied`, `UnauthorizedAccessException`; stdout vacío.

Recomendación: es un candidato viable en esta máquina para bloquear lecturas de
datos ajenos. **No activado en la app**, por alcance explícito del encargo.
Activarlo requiere negociar API experimental y regenerar tipos experimentales;
expone campos inestables y exige repetir compatibilidad antes de actualizar Codex.
`:minimal` conserva lecturas externas necesarias para runtime: no equivale a negar
toda lectura exterior. No se probaron herramientas del kit, MCP, red, otra PC ni
una conversación real con el modelo. La prueba acredita PowerShell y los testigos,
no todas las herramientas. No hubo pedidos a ChatGPT.

## Límites

No se simuló disco físicamente lleno ni una caída de energía en mitad de restaurar.
La restauración no es atómica; se consume antes de escribir y avisa si queda parcial.
No se certifican carreras con procesos externos que cambien enlaces durante una
operación. El botón excluye pedidos simultáneos del agente, no procesos externos.
No se midió una agencia real ni se verificó aceptación humana.
