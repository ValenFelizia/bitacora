# Sistema de diseño de Bitácora

Dirección elegida el 16/11/2026: **«De a bordo»** (DEC-012). Maqueta de referencia en `docs/design/maqueta-de-a-bordo.html`; investigación en `docs/research/inspiracion-diseno.md`.

Este archivo manda sobre cualquier decisión visual de la interfaz (`web/`). Si algo no está acá, se resuelve con los principios y se agrega acá.

## Personalidad

Bitácora es el cuaderno de a bordo de la agencia: un registro de lo que se hizo, con fecha y hora. La personalidad sale de esa idea, no de adornos:

- **Papel y tinta.** Fondo cálido como papel, texto azul marino como tinta.
- **Naranja de boya.** Un solo color de acento, que marca lo que está pasando ahora y la acción principal. Nada más.
- **Registro con hora.** El progreso del agente se cuenta como entradas del cuaderno (`14:02 ✓ Leí la página del hotel`), no como píldoras ni barras.

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
| `--accent` | `#d4612a` | Íconos de acento, subrayados, filete del trabajo activo (no para texto chico) |
| `--accent-ink` | `#b34a17` | Texto en naranja («ahora», avisos): 5,2:1 sobre `--surface` |
| `--ok` | `#2f7d5b` | Tilde de un paso terminado |
| `--danger` | `#a63d2a` | Errores y borrar |

- **Contraste:** `--accent` da 3,7:1 sobre `--surface`, así que sirve solo para íconos, subrayados y textos grandes. El texto chico en naranja usa `--accent-ink`.
- **Modo oscuro:** no hay en el MVP.

## Tipografía

| Rol | Familia | Pesos | Uso |
| --- | --- | --- | --- |
| Títulos | **Young Serif** | 400 | Marca, título del trabajo, título del panel, nombre del entregable |
| Texto | **Atkinson Hyperlegible** | 400, 700 | Todo lo demás |

- **Cero con raya:** Atkinson Hyperlegible dibuja así el cero (`0`), para que no se confunda con la O. Se acepta.
- **Números:** las horas y fechas usan `font-variant-numeric: tabular-nums`.
- **Sin itálica en títulos:** el énfasis va en negrita o en color.
- **Escala:** 13 / 15 (base) / 17 / 20 / 25 px.
- **Empaquetado:** las letras van dentro de la app (`@fontsource/young-serif`, `@fontsource/atkinson-hyperlegible`), no desde Google Fonts.

## Forma y espacio

- **Esquinas:** radio de 6 px en todo; 3 px en las miniaturas de placas. Nada de esquinas muy redondeadas.
- **Líneas, no sombras:** divisores de 1 px en `--line`, sin sombras.
- **Espacios:** escala de 4 px (4, 8, 12, 16, 20, 24, 32).
- **Disposición:** tres columnas. Trabajos (unos 220 px), conversación (flexible), entregables (unos 300 px).

## Íconos

- **Familia:** Lucide (`lucide-react`), trazo 1,75, 18 px. Una sola familia.
- **Acción principal:** ícono más texto («Descargar», «Nuevo trabajo», «Conectar cuenta»).
- **Acciones repetidas o secundarias:** ícono solo, con `title` y `aria-label` (ver, abrir carpeta, cambiar el nombre, «⋯»).

## Patrones

- **Progreso del agente:** una lista de entradas con hora, ícono y una frase corta.
  - Paso terminado: `check` en `--ok`.
  - Paso en curso: «ahora» con `pen-line`, en `--accent-ink`.
  - Sin porcentajes ni pasos técnicos.
- **Trabajos:** en la barra izquierda, nombre y fecha corta («hoy», «14 nov»). El activo va en `--surface`, con un filete naranja a la izquierda.
- **Entregable:**
  - La miniatura grande es la protagonista; una propuesta es una tarjeta con sus placas.
  - Debajo: nombre en Young Serif y «4 placas · 14:05».
  - **Descargar:** texto con ícono `arrow-down-to-line`, subrayado en `--accent`. No es un botón relleno.
  - Lo demás va en íconos a la derecha: ver, carpeta y «⋯».
  - Entregables anteriores: una fila con su ícono de bajar.
- **Cuenta:**
  - Conectada: abajo a la izquierda, el mail con el ícono `mail`. Sin puntito de estado.
  - Sin conectar: una frase («Para trabajar, conectá tu cuenta de ChatGPT») y un solo botón con borde, «Conectar cuenta».
- **Estados vacíos:** un ícono, una frase y una acción. Nada de tarjetas de sugerencias.
- **Botones:**
  - Relleno en `--ink`: solo para enviar.
  - Con borde de 1 px en `--ink`: acciones únicas, como «Conectar cuenta».
  - Lo demás es texto con ícono, o ícono solo.

## Movimiento

Casi nada. Cambios de opacidad de 150 ms como máximo, y ninguno con `prefers-reduced-motion: reduce`. Nada que lata, rebote ni brille. El paso en curso se reconoce por el color y la palabra «ahora», no por una animación.

## Queda para después

- **Ideas de la investigación:** generar en segundo plano, editar señalando una placa, historial con «Volver a esta» y elegir qué placas mandar. Están en #42 (Después del MVP).
- **Aplicar este sistema a `web/`:** es el issue #25.
