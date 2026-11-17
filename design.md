# Sistema de diseño de Bitácora

Dirección elegida el 16/11/2026: **«De a bordo»** (DEC-012). Maqueta de referencia en `docs/design/maqueta-de-a-bordo.html`; investigación en `docs/research/inspiracion-diseno.md`.

Este archivo manda sobre cualquier decisión visual de la interfaz (`web/`). Si algo no está acá, se resuelve con los principios y se agrega acá.

## Personalidad

Bitácora es el cuaderno de a bordo de la agencia: un registro de lo que se hizo, con fecha y hora. La personalidad sale de esa idea, no de adornos:

- **Papel y tinta.** Fondo cálido como papel, texto azul marino como tinta.
- **Naranja de boya.** Un solo color de acento: el punto de «Bitácora.» (`6 px`, `--accent`) como marcador único de estado, el paso en curso y la acción principal. Nada más.
- **Registro con hora.** El progreso del agente se cuenta como entradas del cuaderno, cerradas al terminar con una línea de asiento (`18:16` a la izquierda, «Listo.» a la derecha), no como píldoras ni barras.

## Principios (Valentín, #25)

1. No bombardear de información.
2. Nada de decoración genérica: sin degradados, brillos, sombras de adorno, puntitos que laten ni violeta o azul "de IA".
3. Los entregables del agente son el foco de la barra derecha y se descargan sin buscar.
4. Menos texto, más íconos.

## Colores

| Token | Valor | Uso |
| --- | --- | --- |
| `--paper` | `#f4efe4` | Fondo de la app |
| `--surface` | `#fffcf5` | Paneles, tarjetas, caja de texto, panel de entregables |
| `--ink` | `#1d2838` | Texto principal, botón de enviar, íconos activos |
| `--muted` | `#6a6558` | Texto secundario, horas, fechas, íconos en reposo |
| `--line` | `#e1d8c6` | Bordes y divisores de 1 px |
| `--soft` | `#ece4d3` | Fondo al pasar el mouse |
| `--accent` | `#d4612a` | Punto marcador de `6 px`, íconos de acento, subrayados, filete del trabajo activo (no para texto chico) |
| `--accent-ink` | `#b34a17` | Texto en naranja («ahora», avisos): 5,2:1 sobre `--surface` |
| `--ok` | `#2f7d5b` | Token reservado para confirmaciones |
| `--danger` | `#a63d2a` | Errores y borrar |

- **Contraste:** `--accent` da 3,7:1 sobre `--surface`, así que sirve solo para el punto de `6 px`, íconos, subrayados y textos grandes. El texto chico en naranja usa `--accent-ink`.
- **Modo oscuro:** no hay en el MVP.

## Tipografía

| Rol | Familia | Pesos | Uso |
| --- | --- | --- | --- |
| Títulos | **Young Serif** | 400 | Marca, título del trabajo, título del panel, ancla de estados vacíos |
| Texto | **Atkinson Hyperlegible** | 400, 700 | Todo lo demás |

- **Cero con raya:** Atkinson Hyperlegible dibuja así el cero (`0`), para que no se confunda con la O. Se acepta.
- **Números:** las horas y fechas usan `font-variant-numeric: tabular-nums`.
- **Sin itálica en títulos:** el énfasis va en negrita o en color.
- **Escala:** 13 (mínimo de interfaz) / 15 (base) / 17 / 20 / 25 px.
- **Empaquetado:** las letras van dentro de la app (`@fontsource/young-serif`, `@fontsource/atkinson-hyperlegible`), no desde Google Fonts.

## Forma y espacio

- **Esquinas:** radio de 6 px en todo; 3 px en las miniaturas de placas. Nada de esquinas muy redondeadas.
- **Líneas, no sombras:** divisores de 1 px en `--line`, sin sombras.
- **Espacios:** escala de 4 px (4, 8, 12, 16, 20, 24, 32).
- **Disposición:** tres columnas. Trabajos (unos 220 px), conversación (flexible), entregables (unos 300 px).

## Íconos

- **Familia:** Lucide (`lucide-react`), trazo 1,75, 18 px (16 px en `info` de detalle y flechas de fila). Una sola familia.
- **Área táctil:** botones de ícono de al menos 36 px en escritorio y 40 px por debajo de 960 px.
- **Acción principal:** ícono más texto («Descargar 4 placas», «Nuevo trabajo», «Conectar cuenta»).
- **Acciones repetidas o secundarias:** ícono solo, con `title` y `aria-label` (ver, copiar, detalle, «⋯»).

## Patrones

- **El punto del logo:** el círculo naranja de `6 px` (`--accent`) de «Bitácora.» es el marcador de estado en la barra izquierda (junto al trabajo en curso, en lugar de texto suelto como «ahora») y delante de cada respuesta de Bitácora.
- **Progreso del agente:**
  - **Cierre como asiento:** cuando termina una respuesta, el asiento final se dibuja como una línea horizontal completa de `1 px` en `--line`, con la hora a la izquierda (`tabular-nums`) y «Listo.» a la derecha.
  - **Paso en curso:** «ahora» con `pen-line`, en `--accent-ink`.
  - **Detalle:** cada respuesta puede abrir su detalle técnico con el botón de ícono `info` (`16 px`).
  - Sin porcentajes ni pasos técnicos visibles por defecto.
- **Trabajos:** en la barra izquierda, el nombre ocupa la línea completa y debajo va la fecha corta en `--muted` (junto al punto naranja si está en curso). El activo va en `--surface`, con un filete naranja a la izquierda.
- **Entregable:**
  - Grilla de placas con `gap` de 8 px: 2 columnas hasta 4 placas, 3 columnas con 5 o más (muestra hasta 6 miniaturas y un tile `+N` en la sexta para abrir desde la placa 7).
  - Debajo, la línea de meta («4 placas · 14:05»); no se repite el nombre del trabajo si coincide con el encabezado.
  - **Descargar:** texto con ícono `arrow-down-to-line`, subrayado en `--accent`, indicando la cantidad cuando el lote tiene varias placas o imágenes («Descargar 4 placas») y solo «Descargar» para un único archivo. No es un botón relleno.
  - Si el lote trae un PDF junto a las placas, va dentro de la misma tarjeta debajo de una línea fina en `--line`, como fila con el ícono `file-text` y su nombre.
  - Lo demás va en íconos a la derecha: ver, copiar y «⋯».
  - Entregables anteriores: una fila con su ícono de bajar.
- **Deshacer:** barra superior en flujo normal de una sola línea corta («Se cambiaron 4 placas» o el texto del pedido si no hay entregables) con el pedido completo en `title` y el botón «Deshacer».
- **Errores:** un solo aviso rojo sobre la caja de texto (ícono, una frase llana y «Reintentar»), sin duplicar líneas en el registro ni en el pie de la barra izquierda.
- **Cuenta:**
  - Conectada: abajo a la izquierda, el mail con el ícono `mail`. Sin puntito de estado.
  - Sin conectar: título en Young Serif («Conectá tu cuenta») con ícono `log-in`, una frase, un solo botón con borde («Conectar cuenta») y la caja de texto deshabilitada con un placeholder que explica el motivo.
- **Estados vacíos:** el título en Young Serif es el ancla, alineado al borde izquierdo de la caja de texto y sin cajita alrededor de un ícono. En el estado listo vacío, debajo de «¿En qué trabajamos hoy?» se muestran «Rumbos sugeridos»: exactamente 3 filas de texto plano separadas por líneas de `1 px` en `--line` con una flecha a la derecha (`arrow-right`) que cargan el texto en la caja y la enfocan sin enviar. Sigue prohibido usar tarjetas o cajas con borde para sugerencias.
- **Botones:**
  - Relleno en `--ink` (al 40 % de opacidad cuando está deshabilitado): solo para enviar.
  - Con borde de 1 px en `--ink`: acciones únicas, como «Conectar cuenta» o «Reintentar».
  - Lo demás es texto con ícono, o ícono solo.

## Movimiento

Casi nada. Cambios de opacidad de 150 ms como máximo, y ninguno con `prefers-reduced-motion: reduce`. Nada que lata, rebote ni brille. El paso en curso se reconoce por el color y la palabra «ahora», no por una animación.

## Queda para después

- **Ideas de la investigación:** generar en segundo plano, editar señalando una placa, historial con «Volver a esta» y elegir qué placas mandar. Están en #42 (Después del MVP).
- **Aplicar este sistema a `web/`:** es el issue #25.
