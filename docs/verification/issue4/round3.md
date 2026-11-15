# Tercera ronda del PR #18

2026-11-14. Base `b69dc14`, misma rama `issue-4-deshacer`. Sin subagentes,
dependencias nuevas, pedidos a ChatGPT, cambios a `.csdd/`, configuración de Windows
o perfil de lecturas. No se usaron 5173/4317 ni los datos o la copia ajena.

## Regresiones primero

Antes de modificar producción se ejecutaron las ocho primeras pruebas de
`server/test/undo-round3.test.ts`: **0 aprobadas, 8 fallidas**. Se reprodujeron N1
con archivo y carpeta, N2a/b/c, N3 con archivo exclusivo y carpeta ilegible, y N4.
Salida original: [round3-red.txt](round3-red.txt). Esas mismas pruebas pasan ahora.

## N1–N6

| Punto | Qué quedó | Evidencia |
| --- | --- | --- |
| N1 | Identidad de ruta agrupada por separador, NFC y mayúsculas. Se comprueba el nombre real antes de quitar una entrada. Renombrados del pedido sólo por mayúsculas/composición se rechazan antes de tocar nada; renombrados manuales se conservan. | Pruebas N1 de archivo/carpeta del agente, archivo/carpeta manual, `ñ` compuesta/descompuesta y dos nombres Unicode coexistentes. Datos conservados, copia retenida si sigue disponible y ningún bloqueo de pedidos. |
| N2a | Sólo lectura no se confunde con bloqueo: se comprueba lectura y se quita el atributo al reemplazar; el modo anterior se restaura donde corresponde. | `N2a agent read-only file...` y prueba anterior de atributo original de sólo lectura. |
| N2b/c | La comprobación previa no persiste un plan pendiente: verifica enlaces, padres y creación prevista. Un rechazo deja la copia disponible y no bloquea pedidos nuevos. | `N2b preflight junction...`, `N2c replaced parent...`, conflictos previos de archivo/carpeta y contenido manual posterior. |
| N2, salida | Sólo un avance real activa una restauración pendiente. Hay intención durable antes de la operación para cubrir cierres entre llamada al sistema y registro de progreso; al reiniciar se contrasta con el original apartado y los temporales. Si no hubo avance se descarta la intención. Un avance parcial se puede reintentar o descartar. | Prueba App con reinicio, resumen de nombres, contenido necesario retenido hasta la elección y un pedido nuevo aceptado; interrupción justo después del renombre del sistema y antes de registrar su resultado. |
| N3 | Archivos/carpetas ilegibles se omiten; los demás mantienen copia. Entradas/profundidad limitadas son áreas desconocidas, nunca borrados inferidos. Aviso de limitación una vez y omisiones recordadas al deshacer. | Bloqueo exclusivo real con PowerShell absoluto de System32, ACL real de carpeta, límite de profundidad/entradas y pedido posterior sin repetir el aviso. |
| N4 | La ausencia de un archivo tras una falla no se interpreta como permiso de recrearlo. Se necesita evidencia de una retirada propia y, para reponer un archivo, un temporal completo. | Eliminación manual tras primer renombre fallido y eliminación de una acción posterior después de avance parcial y reinicio. |
| N5 | Re-comprobación real de padres/hoja antes y después de escribir/renombrar; temporales por archivo abierto, original apartado y rollback sin sobrescribir un destino nuevo. Atributos por archivo abierto con restauración de valores si se detecta desvío. | Pruebas antes y después de escritura/renombre con cambio de padre por junction; testigo conservado, contenido recuperable y salida por descarte cuando hay avance. |
| N6 | Junction en la hoja sin administrador; prueba específica del descendiente editado y de las comprobaciones inmediatamente previas. | [mutations-round3.json](mutations-round3.json): **3/3 mutantes detectados por AssertionError de las pruebas reales**, no por errores de importación. |
| Greptile: conflictos | Ya cubierto por la ronda anterior y confirmado otra vez: archivo convertido en carpeta con `.keep` se rechaza antes de cambiar otro archivo. | `file/directory conflict with hidden contents is rejected before any mutation`, en `undo-review.test.ts`. |
| Greptile: deshacer viejo | Marca independiente de invalidación antes de copiar/enviar; recibo de último pedido guardado con los trabajos antes de llamar al motor. Al arrancar se exige coincidencia entre recibo del host, marca y estado. Si la marca no se pudo guardar, no se ofrece Deshacer durante esa ejecución; sin prueba independiente no se recupera uno viejo. | Cinco pruebas en `undo-greptile.test.ts`: `state.json` bloqueado en ambos guardados, fallo adicional de la marca, envío real al motor falso y reinicio, ausencia de prueba, conservación legítima de un Deshacer tras un pedido sin cambios y deshabilitación de la ejecución. |

Reproducir mutaciones: `npx tsx scripts/verify-undo-round3-mutations.ts`. Sólo modifica
módulos descartables bajo `.local/`, nunca el código de producción. Mutantes:

1. Sin control de cambios posteriores dentro de una carpeta que va a volverse archivo.
2. Sin la re-comprobación de ruta justo antes de crear/escribir el temporal.
3. Sin las re-comprobaciones justo antes de renombrar.

Validación final: `npm run typecheck`, `npm run build` y tres corridas de `npm test`
(una desde `C:\Program Files\Git\bin\bash.exe --noprofile --norc -c "npm test"`):
**96 aprobadas, 1 omitida, 0 fallas** en cada corrida. La omitida es el enlace
simbólico de archivo sin elevación; no se modificaron permisos para habilitarlo.

El comentario de Greptile «Old undo returns after restart» también se reprodujo
como prueba roja antes de corregirlo: [greptile-red.txt](greptile-red.txt).
La prueba empieza con la carpeta vacía, guarda el primer resultado y luego bloquea
`state.json` con un proceso propio de PowerShell. La siguiente copia y los dos
intentos de guardado fallan; el pedido sin copia no puede rehabilitar el Deshacer
anterior al reiniciar. En la prueba adicional se bloquea también la marca con otro
proceso propio de PowerShell: el identificador guardado en `works.json` demuestra cuál fue el último pedido
que pudo enviarse, aunque el archivo de copia siga viejo. Si tampoco se pudieran
guardar los trabajos, el contrato existente no envía ese pedido al motor.

Los clientes internos que retoman `Backups` deben entregar el recibo que guardó el
host, no inferirlo leyendo el propio manifiesto de la copia. La app carga primero
los trabajos para obtener esa prueba independiente. Copias antiguas sin ese recibo
no se ofrecen. Una marca ilegible o ausente también invalida el ofrecimiento.

## Nombres y Unicode

No se asume que Windows normalice Unicode. La prueba nativa pudo mantener dos
archivos distintos, `año.txt` y `an\u0303o.txt`, con contenidos diferentes. Se agrupan
conservadoramente para detectar ambigüedad: no se fusionan ni se elige uno para
borrar. Un cambio sólo de representación o mayúsculas deja Deshacer sin ejecutar
y permite seguir trabajando. Si la representación cambió manualmente después del
pedido, se deja esa entrada intacta. Un nombre real que no pueda confirmarse también
impide la operación. Esto es deliberadamente más conservador que NTFS en algunos nombres.

## Pantalla

`npx tsx scripts/capture-undo-round3.ts` crea una fixture con FakeEngine y Edge en
**5184/4328** y elimina sus datos y procesos al terminar. La fixture introduce una
falla persistente al intentar reemplazar el segundo archivo, después de revertir
la imagen nueva. Es una falla inyectada, no una ventana real de Word.

- [round3-01-partial-options.png](round3-01-partial-options.png): avance parcial, motivo y ambas salidas.
- [round3-02-discarded-summary.png](round3-02-discarded-summary.png): se deja la carpeta actual; se informa `propuesta.png` revertida y `documento.docx` sin revertir.
- [round3-03-new-request.png](round3-03-new-request.png): nuevo pedido aceptado; la foto agregada a mano se conserva.

Las tres capturas se abrieron y revisaron. El preview compartido falló dos veces
con `Preview automation snapshot timed out after 15000ms`; se cerró y se usó Edge
mediante Playwright. El primer intento del script tuvo una espera de diálogo mal
sincronizada; se corrigió y la corrida completa pasó. La fixture también expone
`partial` en `verify-undo-browser.ts` para repetir el escenario manualmente.

## Límite de N5

Sin dependencias nativas no se dispone de una operación de Windows que combine
comprobar la ascendencia y modificar por un identificador de carpeta abierto.
Los controles y los rollbacks reducen la ventana y las pruebas verifican los
desvíos inyectados alrededor de esas llamadas. **No certifican una carrera arbitraria
entre la última comprobación y el sistema**, ni una secuencia adversarial que
reemplace también los destinos de recuperación. Un destino que aparece durante
un rollback nunca se sobrescribe; se conserva el original apartado y la copia,
y se ofrece reintentar o dejar la carpeta actual. No hay atomicidad global.

No se llenó físicamente el disco ni se cortó energía; las interrupciones de diario
son inyectadas. No se probó con el agente real ni Word real. El enlace simbólico
de archivo sigue sin estar permitido para este proceso sin elevación y su prueba
se omite explícitamente; las junctions, incluida la hoja, sí se probaron realmente.
Las mediciones de la segunda ronda quedan como históricas, sin volver a presentarlas
como mediciones del código nuevo.
