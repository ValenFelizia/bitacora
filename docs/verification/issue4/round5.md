# Ronda corta sobre 326a837

Primero se reprodujeron cuatro fallas: eliminación completada que reaparecía al
descartar, eliminación manual que reaparecía, contador bloqueado que invalidaba
Deshacer, y scripts de mutación que no arrancaban (`round5-red.txt`).

| Greptile | Cambio | Evidencia |
| --- | --- | --- |
| Discard brings files back | Descartar sólo repone un reemplazo iniciado sin terminar, con su temporal todavía preparado. Las eliminaciones completadas y manuales siguen ausentes. El resto va a la papelera sin cambiar su retención. | Dos pruebas R5 y propiedad ampliada: después de cada corte se compara el disco con el estado al elegir descartar, salvo los huecos de reemplazos incompletos. Incluye imagen nueva y eliminación manual de un archivo ya restaurado. |
| Counter failure removes undo | El contador y la purga quedan fuera de la validez de la copia guardada. Si el contador falla, no se purga ni se avanza su generación. | `clock.json` bloqueado con un bloqueo nativo: finish correcto, contador intacto, Deshacer disponible y restauración exitosa. |
| Mutation checks cannot start | Ambos runners resuelven también el import de backup-trash. El mutante histórico de todos los controles de rutas incluye ahora el segundo control añadido en rondas posteriores. | Ambos scripts ejecutados: tres mutantes de ronda 3 y uno histórico detectados. También corren como prueba R5, quitando el contexto de node:test del subproceso para evitar una ejecución recursiva. |

No se cambian las reglas de conservación de datos ni retención. Las mediciones
de ronda 4 son históricas; esta ronda no vuelve a medir ni usa navegador o motor real.
Validación: dos corridas de 117 pruebas: 116 aprobadas, una omitida por EPERM del
enlace simbólico de archivo en Windows. Las junctions sí corren. La propiedad
cubre 60 puntos de corte × reintentar/descartar: 120 salidas reales del proceso,
con conservación de huellas y estado de disco verificado al descartar. Ver
`round5-tests-1.txt` y `round5-tests-2.txt`. Typecheck y build aprobados.
Sin inferencia ni dependencias nuevas; sin procesos propios pendientes.
