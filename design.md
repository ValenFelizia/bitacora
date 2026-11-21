# Sistema de diseño de Bitácora

Dirección elegida el 16/11/2026: **«De a bordo»** (DEC-012). Maqueta de referencia en `docs/design/maqueta-de-a-bordo.html`; investigación en `docs/research/inspiracion-diseno.md`.

Este archivo manda sobre cualquier decisión visual de la interfaz (`web/`). Si algo no está acá, se resuelve con los principios y se agrega acá.

## Personalidad

Bitácora es el cuaderno de a bordo de la agencia: un registro de lo que se hizo, con fecha y hora. La personalidad sale de esa idea, no de adornos:

- **Papel y tinta.** Fondo cálido como papel, texto azul marino como tinta.
- **Naranja de boya.** Un solo color de acento (`#d4612a`, `--accent`). El punto naranja tiene un único significado en toda la app: **el agente o algo nuevo de él**. Aparece solo en tres lugares: al lado del nombre («Bitácora.»), delante de cada mensaje del agente y sobre los entregables que todavía no se abrieron (se borra al abrir, previsualizar, copiar o descargar). No se usa en ningún otro lado.
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
| `--accent-ink` | `#b34a17` | Texto en naranja (paso en curso, avisos): 5,2:1 sobre `--surface` |
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
- **Disposición:** tres columnas. Trabajos (unos 220 px), conversación (flexible), entregables (300 px de entrada; se ensancha arrastrando, ver «Entregable»).

## Íconos

- **Familia:** Lucide (`lucide-react`), trazo 1,75, 18 px (16 px en `info` de detalle y flechas de fila). Una sola familia.
- **Área táctil:** botones de ícono de al menos 36 px en escritorio y 40 px por debajo de 960 px.
- **Acción principal:** ícono más texto («Descargar las 4», «Nuevo trabajo», «Conectar cuenta»).
- **Acciones repetidas o secundarias:** ícono solo, con `title` y `aria-label` (ver, copiar, detalle, «⋯»).

## Patrones

- **Regla del punto naranja:** el círculo naranja (`6 px`, `--accent`) significa únicamente *el agente o algo nuevo de él*. Solo aparece:
  1. Al lado de la marca («Bitácora.»).
  2. Delante de cada respuesta de Bitácora en la conversación.
  3. En la esquina superior derecha de los entregables (o junto a la fila si es un PDF o lista) que todavía no se abrieron en este visor; se limpia al abrir, previsualizar o descargar.
  No se usa en botones, títulos ni en la barra de trabajos (el trabajo en curso en la barra izquierda usa `pen-line`).
- **Progreso del agente:**
  - **Cierre como asiento:** cuando termina una respuesta, el asiento final se dibuja como una línea horizontal completa de `1 px` en `--line`, con la hora a la izquierda (`tabular-nums`) y «Listo.» a la derecha.
  - **Paso en curso:** al final de la conversación, `pen-line` y el texto del paso en `--accent-ink`, sin hora. El lápiz se mueve como si escribiera y los tres puntos aparecen de a uno (Valentín, 20/11/2026). Mientras hay una pregunta abierta no se muestra: la tarjeta ya dice que Bitácora espera.
  - **Detalle:** cada respuesta puede abrir su detalle técnico con el botón de ícono `info` (`16 px`).
  - Sin porcentajes ni pasos técnicos visibles por defecto.
- **Carpeta de trabajo.** En la bienvenida y en la barra de trabajos, un botón con ícono de carpeta abre el selector de Windows. Debajo del nombre del botón se muestra la ubicación actual. El botón usa tinta y papel.
- **Trabajos:** en la barra izquierda, bajo el título de sección «Trabajos» (`13 px`, `--muted`). Cada trabajo es una fila separada por líneas de `1 px` en `--line`: el nombre en `--ink` ocupa la línea y debajo va la fecha corta en `--muted` (junto al ícono `pen-line` si está en curso). Los que no están abiertos llevan `chevron-right` (`16 px`, `--muted`) a la derecha, para que se vean tocables sin pasar el mouse. El activo va en `--surface`, en negrita y con un filete naranja a la izquierda, sin flecha.
- **Traer chats de Codex:** acción de texto con ícono en la barra izquierda. Abre un diálogo en `--surface` con título Young Serif y una lista de casillas, con título y fecha en cada fila. Primero van los chats de la carpeta actual. Los demás muestran además el nombre de su carpeta. Los chats que ya están en Bitácora quedan marcados. La acción de traer tiene borde en `--ink`.
- **Mensajes de Bitácora:** debajo de cada respuesta terminada, el botón de ícono `copy` («Copiar mensaje») copia el texto tal cual. Al copiar, el ícono pasa a `check` y al lado aparece «Copiado» en `13 px` `--muted` durante 2 segundos, en una región `status`.
- **Cuadro de texto:** arriba el texto; abajo, en una fila, adjuntar, el modelo y enviar. Enter envía y Shift+Enter hace un párrafo nuevo. Enter no envía mientras se compone un carácter (acentos, métodos de entrada); cuando el botón de enviar está apagado (por ejemplo, con un pedido en curso), Enter hace el salto de línea de siempre.
  - **Dictado:** al lado de adjuntar, el ícono `mic` («Dictar»). Al grabar cambia a `square` («Terminar dictado») con fondo `--soft`. Arriba del texto aparece «Escuchando…» o «Transcribiendo…» en `--accent-ink`, sin movimiento. Los errores van en `--danger`. Al terminar, el foco vuelve al texto con el cursor después del dictado. La usuaria decide cuándo enviar.
- **Modelo:** junto a adjuntar, el nombre del modelo en negrita de `13 px` con `chevron-down` (`16 px`). Abre hacia arriba un menú en `--surface` con borde de `1 px` en `--line`: «Con qué modelo trabajo» en `--muted`, una fila por modelo con `check` en el elegido, el nombre en negrita (y «· Recomendado» en `--muted` en el predeterminado) y una línea en `13 px` `--muted` sobre para qué conviene. Abajo, separado por una línea, cuánto piensa antes de responder (en palabras llanas, sin términos técnicos) y que el cambio vale para todos los trabajos desde el próximo pedido. Flechas para moverse, Enter para elegir, Escape para cerrar. Si todavía no está la lista de la cuenta, el pie lo dice y ofrece «Volver a intentar» (botón con borde en `--ink` y `rotate-ccw`); abrir el menú ya la pide de nuevo. Si la lista llegó pero no trae ningún modelo permitido, el pie dice «Tu cuenta no tiene modelos disponibles para Bitácora.» sin ofrecer el reintento. Si el modelo elegido no está en la cuenta, una línea con `alert-circle` en `--accent-ink` debajo del cuadro de texto dice cuál se usa.
- **Entregable («Para mandar»):**
  - **Ancho del panel:** en escritorio, la línea divisoria se arrastra entre 280 y 640 px, y nunca deja la conversación con menos de 420 px. Una pastilla de `3 × 40 px` en `--line` en el medio de la línea la hace visible; con el mouse encima pasa a `--muted` y, al arrastrar o con el foco, la línea entera va en `--accent`. Con el teclado es un separador: flechas de a 16 px (64 px con Shift), Inicio y Fin. El ancho se recuerda entre sesiones. Por debajo de 960 px el panel sigue siendo el cajón de siempre.
  - Agrupados por propuesta/lote bajo el título **«Para mandar»**: el lote más nuevo (o enfocado) va arriba con la pieza principal grande, seguida por la línea de meta («4 placas · 14:05») y los íconos a la derecha (ver, copiar y «⋯»), el botón principal de descarga y debajo una grilla de 3 columnas con el resto de las placas (muestra hasta 6 miniaturas; si hay más, la sexta lleva `+N` con las ocultas desde esa placa inclusive para abrir desde ahí). Los lotes anteriores van debajo, agrupados por propuesta con su meta y descarga del lote.
  - **Miniaturas nítidas:** cada miniatura se vuelve a dibujar al tamaño que ocupa en pantalla por la densidad de la pantalla, con el filtro de alta calidad del navegador, solo cuando está cerca de verse y de a dos por vez. Achicar una placa de 1080 × 1920 de una sola vez dentro de una celda chica borra las líneas finas y la letra chica.
  - **Descargar:** botón relleno en `--ink` con texto `--surface` e ícono `arrow-down-to-line` para el lote destacado: «Descargar las N» cuando tiene varias placas o imágenes, y «Descargar» para un único archivo. En lotes anteriores, enlace con subrayado en `--accent` («Descargar las N»).
  - Si el lote trae un PDF junto a las placas, va dentro de la misma tarjeta debajo de una línea fina en `--line`, como fila con el ícono `file-text` y su nombre.
  - Cada entregable sin abrir lleva el punto naranja hasta que la usuaria lo abre, previsualiza, copia o descarga.
- **Deshacer:** barra superior en flujo normal de una sola línea corta («Se cambiaron 4 placas» o el texto del pedido si no hay entregables) con el pedido completo en `title` y el botón «Deshacer».
- **Preguntas del agente:**
  - Tarjeta al final de la conversación, en `--surface` con borde de `1 px` en `--line` y, mientras espera, el filete naranja a la izquierda del trabajo activo. Arriba, el ícono `message-circle-question` en `--accent` y «Te hago una pregunta» en `13 px` `--muted`.
  - Cada pregunta es un grupo con su texto en `17 px` negrita (y el rótulo corto arriba, en `--muted`). Las opciones son filas de texto separadas por líneas de `1 px`, con su botón de opción nativo, el nombre en negrita y la explicación en `13 px` `--muted`. La sugerida por el agente lleva «Recomendada» en `--muted`, sin color.
  - «Otra» es la última fila y abre un campo para escribir. Se responde con un botón con borde, «Responder» con `check`; a su izquierda, «Ahora no» con borde en `--line` saltea la pregunta sin pausar. Si falta elegir, un aviso corto en `--danger` debajo de la pregunta y el foco va ahí.
  - Si el agente pregunta otra vez antes de la respuesta, las preguntas se muestran de a una, en orden.
  - Lo respondido queda como mensaje de la usuaria («Trato: Vos», o «Ahora no.»). Si ya no se puede responder (pausa, Bitácora detenida o cerrada), la tarjeta queda sin filete, con la pregunta en `--muted` y el aviso con `alert-circle`; se borra con el pedido siguiente.
  - Foco: una pregunta nueva lo toma en su título; al responder vuelve a la caja de texto; si la tarjeta se cierra, va a su título. El aviso de cierre vive en una región `status` que existe desde que se muestra la tarjeta, para que el lector de pantalla lo anuncie.
- **Errores:** un solo aviso rojo sobre la caja de texto (ícono, una frase llana y «Reintentar»), sin duplicar líneas en el registro ni en el pie de la barra izquierda.
- **Cuenta:**
  - Conectada: abajo a la izquierda, el mail con el ícono `mail`. Sin puntito de estado.
  - Sin conectar: título en Young Serif («Conectá tu cuenta») con ícono `log-in`, una frase, un solo botón con borde («Conectar cuenta») y la caja de texto deshabilitada con un placeholder que explica el motivo.
- **Estados vacíos:** el título en Young Serif es el ancla, alineado al borde izquierdo de la caja de texto y sin cajita alrededor de un ícono. En el estado listo vacío, debajo de «¿En qué trabajamos hoy?» se muestran «Rumbos sugeridos»: exactamente 3 filas de texto plano separadas por líneas de `1 px` en `--line` con una flecha a la derecha (`arrow-right`) que cargan el texto en la caja y la enfocan sin enviar. Sigue prohibido usar tarjetas o cajas con borde para sugerencias.
- **Bienvenida (primer arranque):** tres preguntas, una por pantalla, sin agente
  y antes de conectar la cuenta. Volanta «Antes de empezar» en `--muted`, la
  pregunta en Young Serif `25 px` y una línea de ayuda en `15 px` `--muted`, en
  una columna de 560 px sobre `--paper`, sin tarjetas. Arriba a la derecha, «1 de
  3» con `tabular-nums` (al lector de pantalla, «Paso 1 de 3»). La tercera
  pregunta es una lista de casillas separadas por líneas de `1 px` en `--line`,
  con «Otra» al final que abre un campo. Abajo: «Atrás» como texto con flecha
  desde el segundo paso, «Saltear» con borde en `--line` y «Seguir»/«Listo» con
  borde en `--ink`. El error de validación va en `--danger` debajo del campo y se
  borra al cambiar de paso. Si se corta la conexión, la pantalla queda como está,
  avisa con `wifi-off` y «Reintentar», y no deja enviar hasta que vuelva. En la
  última pregunta, «Saltear» guarda la agencia y el nombre ya escritos; en las
  anteriores no guarda nada.
- **Botones:**
  - Relleno en `--ink` (al 40 % de opacidad cuando está deshabilitado): para enviar y para la descarga principal del lote en «Para mandar» («Descargar las N»).
  - Con borde de 1 px en `--ink`: acciones únicas, como «Conectar cuenta» o «Reintentar».
  - Lo demás es texto con ícono, o ícono solo.

## Movimiento

Casi nada. Cambios de opacidad de 150 ms como máximo, y ninguno con `prefers-reduced-motion: reduce`. Nada que lata, rebote ni brille. La única animación continua es la del paso en curso (lápiz y puntos), y se apaga con `prefers-reduced-motion: reduce`.

## Queda para después

- **Ideas de la investigación:** generar en segundo plano, editar señalando una placa, historial con «Volver a esta» y elegir qué placas mandar. Están en #42 (Después del MVP).
- **Aplicar este sistema a `web/`:** es el issue #25.
