# Retrabajo del PR #18

**Informe histórico de la segunda ronda (`b69dc14`).** El tratamiento de nombres,
fallas previas, omisiones y la salida de una restauración parcial se actualizó en
la [tercera ronda](round3.md). Sus mediciones no certifican los cambios posteriores.

2026-11-14. Se reprodujeron primero los bloqueantes contra `ecfafed`:
`npx tsx --test server/test/undo-review.test.ts` dio **0/2**. Se borraron
`foto.jpg` (agregada a mano) y `new.txt` (antes de fallar por el documento bloqueado).
Salida original: [rework-red.txt](rework-red.txt). Las mismas dos pruebas pasan ahora.

## Qué cambió y cómo se comprobó

| Punto de revisión | Cambio | Evidencia |
| --- | --- | --- |
| 1. Cambios manuales | Diferencia antes/después del pedido; se comprueba el estado actual antes de revertir cada ruta. Lo ajeno a esa diferencia nunca se modifica. | `review blocker 1`, `manual edits, moves and deletion...`, incluido un pedido posterior sin cambios. |
| 2. Pérdida y falta de reintento | Plan persistido antes de empezar, progreso por operación, temporales y renombre; cierre durable antes de consumir; se conservan ambas fotos hasta terminar. | `review blocker 2`, `journal resumes...`, `failed atomic replacement...`, `completion journal failure...`, reinicio de App con restauración incompleta. |
| 3. Conflicto de tipos | Preflight de todos los destinos, contenido, accesos de escritura y contenido crudo de carpetas, incluidos ocultos/excluidos. | `file/directory conflict with hidden contents...`; también intercambios sin restos y carpetas nuevas con archivos manuales. |
| 4. Aviso al motor | Otro `UserInput` de tipo `text` dentro de un solo `turn/start`; sin `thread/resume` ni instrucciones persistentes. | Tipos generados 0.168.0 `v2/UserInput.ts`; prueba stdio y prueba App de una sola entrega, sólo en el trabajo correspondiente. |
| 5. Recorridos duplicados | `WorkspaceFiles.scan` alimenta copia y resultados juntos, una vez antes y una después; verificaciones por componente sólo al restaurar. | Prueba App cuenta 2 recorridos por pedido; comparación con código exacto de `main` y `ecfafed`, abajo. |
| 6. Tamaños y memoria | Lectura, hash y escritura en flujo; el archivo omitido no invalida los demás; se informa sólo cuando cambió. | `individual oversized file...`, topes de cantidad/bytes y prueba de temporal incompleto tras falla. |
| 7. Exclusiones | Mismas exclusiones al copiar/restaurar, sin distinguir mayúsculas: componentes con punto, `adjuntos`, `node_modules`, enlaces y junctions. Atributo de sólo lectura registrado y restaurado. | `excluded content survives undo...`, `restore preserves original read-only attribute`. Los enlaces, incluidos los creados por el agente, quedan fuera y no se eliminan. |
| 8. Pantalla | Confirmación protege cambios manuales; resultado con cantidad y nombres; aviso cuando no puede deshacer; reintento y avisos vigentes; resultados revertidos indisponibles. | Edge, capturas 01–06, prueba de rechazo de Deshacer mientras hay pedido activo, reinicio con reintento visible. |
| 9. Cobertura de seguridad | Corrupción de manifiesto/contenido, cambios manuales, bloqueo, reinicio, retención de objetos y junction introducida durante la operación. | `undo-review.test.ts` y [mutation.json](mutation.json). Sin controles de ruta, el mutante **no rechaza** la restauración y cambia el testigo externo: la prueba lo detecta. |

Pruebas: `server/test/undo-review.test.ts`, `backups.test.ts`, `codex.test.ts`
y suite existente. `npm run typecheck`, `npm run build` y tres corridas de
`npm test` pasan: **69 pruebas aprobadas, 1 omitida por falta de permiso de Windows
para crear enlaces simbólicos de archivo, 0 fallas**. Una corrida fue desde
`C:\Program Files\Git\bin\bash.exe --noprofile --norc -c "npm test"`.
La prueba omitida queda preparada para correr donde Windows permita esos enlaces;
no se pidió elevación ni se cambió la configuración. Las junctions sí se probaron.
**Cero pedidos a ChatGPT**. No se modificó `.csdd/`, la copia
ajena, sus puertos ni `%LOCALAPPDATA%\Bitacora-dev\prueba`. No se activó el perfil
beta de lecturas y no se repitió su investigación.

## Rendimiento y espacio

`npx tsx scripts/benchmark-undo-rework.ts`. Misma carpeta sintética de **2.004
archivos**: 2.000 de 16 KiB y cuatro de 16 MiB, **99.876.864 B (95,25 MiB)**.
Cinco rondas alternadas de las tres implementaciones, sin servicios propios ni
pruebas ejecutándose en paralelo en esta medición final. Se cargan copias
temporales del código exacto mediante `git show`, sin cambiar el checkout.

| Operación | Antes (`ecfafed`) | Ahora |
| --- | ---: | ---: |
| Pedido sin cambios: antes + después, mediana de 5 rondas de esta misma medición | 2.036 ms (4 recorridos) | **351 ms** (2 recorridos) |
| Base `main` (`7b120b6`), 2 recorridos de resultados, mediana | 336 ms | Sobrecosto de copias: **15 ms** |
| Primera copia | 5.897 ms históricos | 6.604 ms |
| Pedido con un archivo cambiado: antes + después | 2.256 ms históricos | 353 ms |
| Deshacer | 3.731 ms históricos | 571 ms |

La primera copia no mejoró y sigue esperando a leer y cerrar los contenidos antes
de enviar al motor. No se afirma lo contrario. Los números históricos del primer
PR incluyen la consulta del espacio ocupado; los tiempos de la medición nueva se
cierran antes de consultar ese espacio. La comparación directa de las tres
implementaciones para pedidos sin cambios sí usa el mismo método.

Contenido guardado: **99.876.864 B** al inicio y tras pedidos sin cambios;
**99.893.248 B** al cambiar un archivo (+16 KiB), **0 B sin referencias** al
terminar Deshacer. Es espacio lógico del contenido: no incluye manifiestos, bloques
de NTFS, memoria del proceso ni temporales de restauración. Durante una restauración
pendiente se retienen las dos fotos, el plan y sus temporales; la prueba de reinicio
confirma que la limpieza no borra los objetos todavía necesarios.

Datos de todas las rondas: [benchmark-rework.json](benchmark-rework.json).
Medición inicial histórica: [benchmark.json](benchmark.json).

## Pantalla y bloqueo real de Windows

`npx tsx scripts/capture-undo-browser.ts` crea su propia instancia en **5184/4328**,
usa FakeEngine y Edge, cierra todo y elimina sus datos dentro de `.local/`.
`verify-undo-browser.ts` sirve la misma fixture para uso manual: comandos `manual`,
`lock`, `unlock` y Enter para cerrar. No ejecutar ambos a la vez.

El bloqueo se mantiene con un proceso propio de PowerShell absoluto de System32,
`FileShare.Read`: el archivo se puede leer pero no escribir ni reemplazar.
No es Word real: reproduce su bloqueo usando el sistema de archivos nativo.

- `01-request.png`, `02-confirm.png`: pedido y confirmación que protege ediciones manuales.
- `03-restored.png`: restaura el documento, mantiene `foto personal.jpg` y el resultado revertido dice que ya no está.
- `04-gallery-reverted.png`: el mismo aviso en la galería.
- `05-locked-no-loss.png`: archivo bloqueado; ningún archivo de la propuesta se borró; opción Reintentar deshacer.
- `06-retry-complete.png`: se libera el bloqueo y el reintento termina; el documento original y la foto personal siguen intactos.

Las capturas se abrieron y revisaron. El navegador compartido volvió a fallar dos
veces con `Preview automation snapshot timed out after 15000ms`; se usó Playwright
con Edge y se cerró la pestaña del preview.

## Límites de la evidencia

- El aviso está verificado contra los tipos generados y el proceso falso.
  **No se probó con el agente real.** El protocolo estable tiene `text` para
  lenguaje natural, sin una variante de rol desarrollador dentro de `UserInput`:
  el aviso es otra entrada identificada como Bitácora. La app nunca lo incorpora
  al texto guardado de la usuaria ni a su extracción de links.
- Se simularon fallas en límites precisos: después de renombrar y antes de guardar
  el progreso, renombre fallido y cierre del plan fallido. Una nueva instancia de
  Backups y una nueva App cargan el diario persistido y terminan. No se cortó la
  energía ni se mató físicamente el proceso Node durante una llamada al sistema.
- La falla `ENOSPC` es inyectada: no se llenó físicamente el disco. Se probó un
  bloqueo Windows real, pero no una ventana de Word real. No se midió una agencia real.
- Node permite comprobar lectura/escritura y preparar temporales; no garantiza
  que otro proceso no abra un archivo entre esa comprobación y un renombre.
  Una falla nueva conserva el avance y ofrece reintento; no hay atomicidad global
  de toda la carpeta ni una garantía ante una carrera arbitraria de procesos externos.
- Si se reinicia un pedido sin haber guardado su foto final, no se inventa esa foto
  con archivos que pudieron cambiar a mano mientras la app estaba cerrada. No se
  ofrece Deshacer para ese pedido. Manifiestos anteriores sin foto final tampoco
  se ofrecen; se apartan como `legacy-*`.
