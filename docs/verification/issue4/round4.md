# Cuarta ronda — conservación y recuperación

Base revisada: `9d72923`. Reproducciones antes del cambio: ocho fallas y una
prueba que ya pasaba (junction interna), registradas en `round4-red.txt` y en el
commit `fd47dc2`. Se mantuvieron las pruebas anteriores de conflicto con `.keep`.

| Punto | Qué cambió | Evidencia |
| --- | --- | --- |
| Opus 1, A y B | Descartar repone las rutas faltantes desde su apartado o papelera antes de cerrar. Si la reposición falla, conserva plan y reintento. Directorios retirados se apartan, no se eliminan. | `R4 Opus A`, `R4 Opus B`, bloqueo nativo del apartado durante descarte y reintento exitoso. |
| Invariante | Originales y temporales pasan a papelera con registro independiente de procedencia y huellas. Sin limpieza de objetos dentro de deshacer/reintentar/descartar. | Prueba de propiedad: 52 puntos de salida real del proceso, cada uno seguido de reinicio y reintento o descarte: 104 salidas, conservación de todas las huellas anteriores a Deshacer y pedidos habilitados. |
| Retención | Siete días **y** tres copias posteriores correctas. La purga separada protege el Deshacer vigente; la limpieza posterior respeta referencias de papelera. | Pruebas de ambas condiciones por separado, protección del pedido pendiente y limpieza diferida de objetos. |
| Opus 2 | Nombres equivalentes para nuestra comparación, distintos en NTFS, se omiten individualmente. | `ñ` NFC/NFD, `ß`/`SS`, `ı`/`I`: seis entradas intactas y archivo restante deshecho. |
| Opus 3 | Se recalcula el progreso efectivo desde el disco; un original devuelto no deja un bloqueo ficticio. | Falla de instalación con original devuelto, copia conservada y pedido nuevo aceptado. |
| Opus 4 | Junction interna y externa con contenido idéntico, para que el rechazo no dependa de una diferencia de huellas. | `mutations-round4.json`: cinco mutantes detectados por AssertionError, incluidos quitar enlaces y quitar conjuntamente enlaces/contención (incluida la comprobación de componentes excluidos). |
| Opus 5 | Se deduplican rutas antes de presentar nombres; dos `x.txt` cuentan como dos. Una eliminación manual sin acción iniciada no se atribuye a Deshacer. | Pruebas separadas de nombres repetidos y de archivo nuevo eliminado manualmente antes del descarte. |
| Greptile — contenidos de copias posteriores | Se desactiva explícitamente la caché implícita y sólo se reutilizan huellas cuyo objeto está presente. | Archivo ajeno intacto durante Deshacer, eliminado en el pedido siguiente y restaurado. |
| Greptile — apartado interrumpido | Se reconcilian todas las acciones iniciadas aunque otra ya haya activado el plan. | Corte tras segundo apartado, reinicio, restauración y conservación de ambas versiones del agente. |
| Greptile — sólo lectura | Se recupera el atributo antes de comparar la acción iniciada. | Diario de intención + chmod interrumpido y cortes reales de la prueba de propiedad. |

La propiedad comprueba las huellas antes y después de recuperar en agencia,
papelera o almacén; la carpeta incluye un archivo manual, un archivo sólo lectura,
varias modificaciones y un cambio archivo→carpeta con contenido. Inyecta salidas
en las operaciones de contenido y publicación del diario instrumentadas, no en
cada llamada interna de Node ni en cada instrucción del sistema operativo.

Mismo volumen: renombrado. Entre volúmenes: copia en flujo, sincronización,
verificación completa y publicación antes de quitar el origen, revalidando cada
archivo. La prueba fuerza `EXDEV` sobre el sistema de archivos real; no se dispuso
de un segundo volumen físico. Las transferencias incompletas se retienen.

## Mediciones

`node --import tsx scripts/benchmark-undo-round4.ts`: 2.000 imágenes de 16 KiB
distintas y cuatro de 16 MiB; 99.876.864 bytes (95,25 MiB), misma carpeta sintética.
Código anterior exacto cargado desde Git, sin cambiar de checkout. Cinco pedidos
sin cambios por versión; cambio y Deshacer tienen una muestra cada uno.

| Operación | `9d72923` | Cuarta ronda |
| --- | ---: | ---: |
| Primera copia antes del pedido | 6.018 ms | 6.555 ms |
| Sin cambios, antes + después, mediana | 350 ms | 389 ms |
| Un archivo cambiado, antes + después | 387 ms | 381 ms |
| Deshacer | 633 ms | 132 ms |
| Datos conservados después de Deshacer | 253 bytes | 99.910.508 bytes |
| Papelera, incluido registro y contador | 0 | 17.007 bytes |

El incremento sin cambios fue 39 ms. Deshacer ya no paga una limpieza destructiva
de los 2.005 objetos: conserva 99.893.248 bytes de objetos y la versión retirada
de 16 KiB en la papelera. Son tamaños lógicos de archivos, sin redondeo por
clúster ni compresión de NTFS. Los JSON completos están en `benchmark-round4.json`.

## Verificación y límites

`npm run typecheck` y `npm run build`: PASS. Tres corridas de `npm test`, una desde
Git Bash: 113 pruebas, 112 aprobadas, una omitida, cero fallas. La omitida requiere
enlace simbólico de archivo sin permiso disponible; las junctions sí se probaron.
Las salidas se conservan en `round4-tests-1.txt`, `round4-tests-2.txt` y
`round4-tests-3-git-bash.txt`.

Cero inferencia; sin agente real, Word real, disco lleno físico ni corte de
energía. No se repitió navegador en esta ronda. El detalle técnico plegado recibe
la ubicación de la papelera; recuperar desde allí mediante pantalla queda pendiente.
No se restauran atributos oculto/sistema. Subsiste la ventana de carrera frente
a procesos externos entre comprobación y llamada al sistema: sin primitivas
nativas no se certifica atomicidad contra cambios concurrentes arbitrarios.
Las pruebas no constituyen una garantía frente a rotura del disco o manipulación
externa del almacén. No se tocó el perfil de lecturas del issue #19.
