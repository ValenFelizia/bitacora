# Hallazgos finales: issue #21 y Greptile

Base: fd37399. No se integró main ni se cambió la configuración personal de Codex.
No se hicieron turnos de modelo. La prueba humana con agente real fue informada
por el operador: llamó a las tres herramientas, corrigió un desborde y publicó
una pieza; no se presenta como una prueba ejecutada por este hilo.

## Pruebas antes de arreglar

- `issue21-red-1.txt`: cuatro casos de precios partidos pasaban con citas de
  fragmentos y dos citas de número completo fallaban. Se corrigió la extracción
  para agrupar nodos adyacentes en línea antes de reconocer tokens.
- `issue21-red-2.txt`: informes que coincidían con fuente/reglas o pieza no eran
  rechazados de forma segura; el dibujo tampoco detectaba el alias de entrada.
- `issue21-red-3.txt`: el PDF contenía PRINT_CHANGED en lugar de SCREEN_A. Ahora
  se comprueban dos páginas, MediaBox 810 × 1440 puntos (1080 × 1920 CSS px) y
  el texto de pantalla de ambas páginas, sin el texto alternativo de impresión.
- `issue21-red-4.txt`: la UI creaba un enlace relativo para Descargar PNG.
  Tras el cambio mínimo en ReactMarkdown es texto; un link http sigue funcionando
  y mailto también queda como texto. Capturas nuevas en `integration/`.
- `issue21-red-5.txt`: la descarga sintética perdía las fotos lazy/picture/fondo y
  guardaba logo y placeholder. Ahora prueba las cuatro vías, dimensiones y el
  resumen de ausencia de fotos útiles.

Las pruebas son de las interfaces controlar/dibujar/traer y del resultado visible
de Markdown, según lo pedido. Sin dependencias nuevas. El PDF de prueba se
inspecciona con zlib y los mapas ToUnicode de los streams que emite Edge.

## Números y rutas

El extractor junta texto en línea adyacente, también b, sup e inline-block. Mantiene
límites de bloque, br y celda; una separación geométrica visible también separa.
Un token que abarca varios nodos toma su cita del elemento con data-cites más
cercano que contiene todo el token (ancestro común). Casos comunes de citas en p
o span siguen funcionando. Se mantienen dígitos Unicode y comparación de token
entero: 5 no respalda 15. Las citas sobrantes siguen informándose.

El informe se compara con fuente, HTML y reglas antes de leer contenido, sin
distinguir mayúsculas y después de resolver separadores y ./ o a/../. El dibujo
comprueba de la misma forma sus posibles PNG/PDF frente al HTML de entrada.
Traer ya usaba creación exclusiva para fuente y fotos; no podía pisar archivos
existentes. Su operación sin URL agrega notas a fuente.md a propósito, conservando
el texto previo; no es una sobrescritura accidental de una entrada elegida.

## Página real del operador

URL usada con lista temporal:
https://360regional.com/360/viaje/preventa-charter-aereo-a-porto-de-galinhas-maragogi-y-cabo-de-santo-agostinho-rec-desde-cor-2027/

La descarga anterior guardaba cuatro imágenes: logos y botón de impresión. En el
HTML hay siete img, varios repetidos; **las fotos del carrusel están en div con
data-bg-image**, con originales y miniaturas. No hay picture en esa página. Los
fondos inline restantes incluyen spinners de búsqueda; no eran fotos del destino.
No se ejecutó JavaScript ni se obtuvo información del navegador para decidirlo.

El nuevo selector reconoce img con data-src/srcset, picture, data-bg-image y
fondos inline/embebidos. Prefiere candidatos del contenido y originales grandes,
evita navegación/logos/botones y deduplica miniaturas. No ejecuta CSS ni scripts,
ni descarga hojas externas. Mantiene límites de 12 intentos de foto, 5 MB por
foto, página de 2 MB, 45 s y redirecciones/IP fijada y validación privada.

El filtro de utilidad exige al menos 1500 bytes, lado largo de 800 px, lado corto
de 400 px y relación de lados no mayor que 4. Las dimensiones se leen de cabeceras
PNG, JPEG o WebP, sin descomprimir ni ejecutar imágenes. Por cada foto se devuelven
ruta, URL, bytes y dimensiones en photoDetails; photos conserva su lista de rutas.
Sin fotos útiles, el resumen pide que la usuaria aporte fotos.

`public-fetch-360regional.com.json`: nueva descarga real de 27910 bytes de fuente,
**10 candidatas grandes**, sin avisos. Incluye seis JPEG de Recife (800 × 525 a
1920 × 1300) y cuatro PNG de 1920 × 1300. No se certifica que cada imagen esté
libre de texto o marcas: el agente debe revisarlas antes de elegir. El registro
incluye origen, dimensiones, tamaño y SHA-256 de la fuente.

## Respuestas y límites

Se responde en los cinco hilos de Greptile indicando commit: escrituras fuera de
la agencia y codificación ya estaban cubiertas por las rondas anteriores; los
otros tres se corrigen acá. Issue #21 queda abierto por pedido del operador.
Al terminar se solicita revisión nueva mediante el comentario literal @greptileai.
No se mergea el PR. La revisión automática del último commit queda pendiente.

`issue21-tests-1.txt`, `issue21-tests-2.txt` y `issue21-tests-3.txt`: 87/87 en
cada corrida (`npm test -- --test-concurrency=1`). `issue21-typecheck.txt` y
`issue21-build.txt`: aprobados. No se presentó la falla temporal conocida en
estas tres corridas. Los cinco registros red preservan las fallas esperadas
antes de sus arreglos, no fallas de la entrega.

La protección sigue orientada a errores honestos: un agente puede editar la
fuente. No se probó instalador; no se agregaron dependencias ni requisitos de
instalación. No se tocaron Origin, la copia principal ni .csdd/.
