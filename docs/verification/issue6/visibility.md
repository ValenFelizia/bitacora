# Ronda corta: visibilidad y tamaño real de fotos

Base 42653fc. `visibility-red.txt` conserva la falla anterior de display:contents
(simple, anidado y en bloque mixto), SVG/pseudo-elementos y foto grande declarada
chica. La prueba verifica también display:none, visibility:hidden, hidden, opacidad
cero y recorte completo: no se cuentan como números visibles.

Arreglo f1388ce: se requieren rectángulos del rango de texto, no una caja de su
padre; se comprueban visibilidad del texto, opacidad de ancestros y recortes por
overflow. Texto SVG y pseudo-elementos en display:contents se rechazan con un
mensaje que indica qué sacar. Los atributos width/height del HTML ya no descartan
fotos: solo orientan el orden; decide el filtro de dimensiones de los bytes.
La regresión usa una foto real de fixture 1600 × 1200 declarada 320 × 240 y un
ícono real 16 × 16 declarado grande: solo se conserva la primera.

`visibility-tests-1.txt` y `visibility-tests-2.txt`: 99/99 en ambas corridas de
`npm test -- --test-concurrency=1`. Typecheck y build aprobados en sus registros.
Sin nuevas dependencias, turnos de modelo, descargas públicas ni nueva prueba de
UI. Se responde a los dos hilos y se solicita revisión automática del último
commit; no se mergea el PR.
