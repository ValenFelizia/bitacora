# Criterio conservador de texto: P1 de Greptile

Base 1d4d7f5. `certainty-red.txt` registra las regresiones fallando antes del
arreglo: recorte, posición absoluta fuera del recorte, opacidad y fuente de
tamaño cero podían dejar números sin controlar.

b37d6ff elimina toda exclusión geométrica. Solo se omite texto bajo display:none,
atributo hidden o template/script/style/noscript/head no mostrado, o con visibility
hidden/collapse computada en su propio elemento. Visibility visible en un hijo
cuenta aunque su ancestro sea hidden. Los rangos solo separan fragmentos con
geometría conocida; nunca deciden si se omite un número.

Se conservan rechazos de construcciones no inspeccionables y las regresiones de
texto partido y display:contents. La línea del kit indica quitar del HTML lo que
no se quiera mostrar. El ejemplo del kit sigue pasando sin modificaciones.

Typecheck, dos corridas completas de 106/106 (`npm test -- --test-concurrency=1`)
y build aprobados; registros certainty-*. Sin nueva prueba de UI, descargas
públicas, dependencias ni turnos de modelo. Se responde el hilo y se solicita
revisión automática del último commit; no se mergea.
