# Arreglos de la revisión del PR #14

Base comprobada: `9aad8d4`, rama `issue-5-adjuntos`. Se leyeron el comentario
de Claude Opus 5.5 y los nueve lugares señalados. Todos eran defectos o faltas
de verificación reales. Esta ronda usa solamente motores y procesos falsos:
**cero pedidos a ChatGPT**. No se accedió a la instancia `prueba`, al Codex
personal ni se modificaron `.csdd/`, 787 Rumbos o el control Origin (#16).

## Reproducción y mediciones

Antes de corregir, `npx tsx --test server/test/file-recovery.test.ts` falló con
`scan failure must never block another send`, `1 !== 2`. La prueba usa `icacls`
para denegar lectura a una subcarpeta de una agencia desechable y restaura la
ACL en `finally`, incluso si falla una aserción. Después de corregir, envía
otro pedido y vuelve a hacerlo tras reiniciar sin quitar antes la denegación.

El benchmark `npx tsx scripts/benchmark-files.ts after` crea dentro de `.local/`
2.000 archivos de 2 KB y ocho de 16 MB: 2.008 imágenes sintéticas por extensión,
138.313.728 bytes. No pretende medir decodificación de imágenes. En cada versión
se midieron tres recorridos: frío, sin cambios y con un archivo pequeño modificado.
Los fixtures se crean antes de medir y se borran al terminar.

| Recorrido | Antes (ms) | Después (ms) | Bytes hasheados después |
| --- | ---: | ---: | ---: |
| Inicial, sin caché | 2.893 | 2.777 | 138.313.728 |
| Sin cambios | 2.783 | 242 | 0 |
| Un archivo modificado | 2.761 | 180 | 2.049 |

Son muestras individuales en la misma máquina, no percentiles. El intervalo
máximo de un temporizador de 10 ms durante la medición nueva fue de 11 ms.
El primer recorrido sigue leyendo el contenido para establecer la referencia;
los posteriores comparan tamaño, modificación y cambio de metadatos, y sólo
hashean candidatos. El mapa nuevo ocupa unos 325 KB en el archivo separado
temporal, en vez de inflar cada reescritura de `works.json`. Una prueba confirma
que este último sólo contiene el identificador del pedido pendiente.

Registros: [antes](benchmark-before.json), [después](benchmark-after.json).
El benchmark anterior se ejecutó contra el código inicial, antes de editarlo.

## Cambios y evidencia

| Punto | Cambio | Prueba o evidencia |
| --- | --- | --- |
| 1 | Se saltea y anota cada elemento ilegible; una falla total avisa en castellano y limpia siempre el pendiente. Se eliminó el bloqueo global por pendientes fallidos. | ACL real, bloqueo exclusivo real de archivo en Windows, falla total simulada, nuevo envío y reinicio. |
| 2 | Caché de metadatos y hashes; E/S asíncrona en flujo; topes de entradas, archivos, profundidad y bytes. Referencia persistida aparte y eliminada al terminar. | Benchmark y pruebas de presupuesto, contenido sin cambios, recuperación del archivo separado y exclusión del mapa en `works.json`. |
| 3 | PDF conserva tipo fijo, `nosniff` y `default-src 'none'`, sin `sandbox`. | Pruebas GET/HEAD de cabeceras y PDF de una página visible en Edge. |
| 4 | `dragover` y `drop` de ventana cancelan navegación y adjuntan al pedido; se retiró el manejador duplicado del formulario. | Arrastre sobre el lateral, fuera del formulario. |
| 5 | Un GET autenticado crea un blob local; Abrir, copiar y guardar reutilizan ese contenido. Se revocan direcciones al desmontar. | La pestaña del PDF abre `blob:`, sin token; el visor de Edge muestra el documento. |
| 6 | Se corta el nombre antes de la extensión y se vuelven a quitar puntos y espacios finales del nombre cortado. | Caso de nombre largo con puntos y espacios en el borde de corte. |
| 7 | El trabajo nuevo se incorpora después del adjuntado y la revisión previa. Se revierten archivos parciales y adjuntos si falla antes de registrar el pedido. | Fallas en la segunda escritura, revisión previa y creación de la carpeta: cero archivos huérfanos y cero trabajos vacíos. |
| 8 | GET usa flujo acotado al tamaño comprobado; máximo 100 MB. HEAD comparte cabeceras y controles y no lee contenido. La tarjeta hace un GET, sin HEAD ni segunda descarga. | Límites HTTP, HEAD sin cuerpo, descarga idéntica y tres GET únicos para las tres tarjetas de la conversación. |
| 9 | Los tipos generados de Codex 0.168.0 ofrecen `mention` con `name` y `path`. Documentos usan esa entrada y ruta relativa; imágenes siguen como `localImage`. | Proceso falso: texto sin ruta añadida, mención con ñ y acento, ruta relativa e imagen local preservada. |

Los controles de ruta HTTP se verifican ahora con identificadores **registrados**
que apuntan a archivos existentes: ruta absoluta exterior, `..` y junction al
exterior. También se recorren junctions externos, rotos y en bucle, sin seguirlos.
Se comprueban resultados tras finalización interrumpida y fallida, y que sólo una
revisión activa demora el siguiente envío. Las pruebas de cabeceras fallan si se
quitan `nosniff`, CSP, tipo fijo, disposición, política de referente, caché o CORP.

## Navegador y controles finales

`npx tsx scripts/verify-files-browser.ts` ejecuta Edge con agencia y cuenta falsas.
Se verificaron arrastre fuera del pedido, miniatura, enlace, portapapeles de imagen,
descarga idéntica, navegación por teclado, galería, selección nativa, archivo borrado
y ancho de 460 px. Durante el pedido crea una subcarpeta denegada y muestra el
resultado accesible junto con el detalle del elemento salteado. Restaura la ACL,
cierra navegador y servidores y borra su carpeta al terminar.

Capturas abiertas y revisadas: [arrastre fuera de la caja](review-drop-outside.png),
[resultado con subcarpeta ilegible](review-denied-result.png),
[PDF visible en Edge](review-pdf-open.png).

- `npm run typecheck`: PASS.
- `npm test`: PASS en tres corridas consecutivas, 49 pruebas cada una.
- `npm run build`: PASS.

No se verificó inferencia real en esta ronda, por el límite explícito de cero
pedidos. La entrada `mention` está respaldada por los tipos fijados y el proceso
falso, sin una nueva prueba contra ChatGPT. Tampoco se probó pegar en WhatsApp
ni una recorrida con lector de pantalla. Los límites pueden omitir resultados
en árboles que los excedan; se deja constancia en el detalle técnico.
