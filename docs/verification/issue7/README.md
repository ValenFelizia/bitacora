# Entrevista inicial: prueba sin inferencia

Se ejecutó `npx tsx server/test/issue7-verification.ts` en Windows con Edge,
usando el cliente MCP stdio real y el punto de entrada de producción. No se
abrió la app ni se gastó inferencia. La agencia temporal se creó bajo
`%LOCALAPPDATA%/Bitacora-dev/issue7`, con `initializeKit`, igual que en la app.
El script cierra su cliente, su proceso MCP y Edge, y elimina esa carpeta.

## Conversación simulada siguiendo entrevista.md

Cada renglón corresponde a un intercambio, sin adelantar la elección visual.
Las respuestas son ficticias y fueron provistas por quien implementó la prueba.

1. Nombre y firma → Rumbo Sur Viajes; Escribime y lo armamos — Laura.
2. Contactos → WhatsApp 11 4567 8901, legajo 12345, Instagram @rumbosurviajes.
   Se confirman esos datos; no aporta correo ni dirección, no se inventan.
3. Logo → adjunta `adjuntos/logo.png`, dibujado con formas y texto mediante
   HTML y captura de Edge. Sin IA de imágenes.
4. Material actual → adjunta `adjuntos/captura.png`, también inventado y
   dibujado con HTML. Se interpreta como bloques en verde y arena, texto claro.
5. Canales → respuesta simulada: WhatsApp e historias.
6. Voz → de vos, cálida, sin emojis; usa «Escribime y lo armamos».
   No indica frases prohibidas: se registra que no indicó ninguna.
7. Se dibujan tres opciones con exactamente el mismo texto, salvo los rótulos
   1, 2, 3: editorial Lora/Manrope, bloques Outfit/Source Sans 3 (respeta la
   captura actual), y centrada Manrope/Caveat. Las tres parten de los colores
   del logo. Se controlan también sus números contra una fuente de muestra.
8. Elección simulada → «La 2». Solo entonces se guardan `marca/` y `plantillas/`.
9. Oferta → no tiene link. Se usa `ejemplo/fuente.md`, ficticio y marcado como
   tal en cada pieza. La plantilla se copia a `propuestas/prueba/` y se corrigen
   rutas relativas. Se controla con fuente de oferta y marca y se dibuja.
10. Cierre simulado → quedan marca, tono y plantilla; puede pedir cambios.

## Evidencia

- [Opción 1](muestras/salida-1/pieza-1.png),
  [opción 2](muestras/salida-2/pieza-1.png),
  [opción 3](muestras/salida-3/pieza-1.png).
- [Portada](propuestas/prueba/salida/pieza-1.png),
  [detalle](propuestas/prueba/salida/pieza-2.png),
  [precio](propuestas/prueba/salida/pieza-3.png) y
  [PDF](propuestas/prueba/salida/piezas.pdf).
- [Control](propuestas/prueba/control.md): 14 números respaldados, sin errores
  ni avisos; cada uno identifica el archivo y línea correspondiente.
- [Datos](marca/datos.md), [estilo](marca/estilo.json), [voz](marca/voz.md),
  [logo](marca/logo.png) y [plantilla estática](plantillas/vertical.html).
- [Llamadas MCP y respuestas](mcp.json): nueve llamadas. La última falla
  intencionalmente al ocultar el WOFF2 de Outfit y lo restaura después.
- Las seis familias cargaron en Edge con texto acentuado y ñ; las pruebas
  comparan byte por byte las fuentes del kit y de la agencia recién creada.

Se miraron las tres opciones y las tres piezas finales. Los PNG tienen
1080 × 1920 y los dibujos no informan desbordes ni fotos pequeñas. La vista
`todas.png` del dibujador existente apila las secciones en vertical y deja
espacio a la derecha; para evaluar cada diseño se usaron los PNG individuales.

## Dudas y correcciones del recorrido

- El WhatsApp con espacios no es un token único: se aclaró citar cada grupo
  visible en la misma línea, sin quitar espacios al dato confirmado.
- Las opciones tienen numeración visible que no pertenece a una oferta: se
  aclaró guardar una fuente separada para esos rótulos. No se altera la oferta.
- Copiar una plantilla desde `plantillas/` a una propuesta anidada cambia la
  profundidad: se agregó revisar las rutas de fuentes y logo.
- El JSON de estilo no se ejecuta: se aclaró que el agente debe trasladar sus
  valores al HTML y mantener ambos archivos de acuerdo al editar.
- El control de dibujo detectó dos píxeles de recorte de glifos en el título
  Manrope de la opción 3; se agregó espacio al título y se repitió el recorrido.

## Límites

Verificación local: `npm install` completado, `npm run typecheck` y
`npm run build` pasan. `npm test` pasó dos veces: 117/117 en cada corrida,
sin fallos ni omisiones. No apareció el fallo de tiempos conocido de #24.
`git diff --check` pasó. No se inició ningún servidor de la app ni se usaron
los puertos reservados; no se detuvieron procesos ajenos.

No se verificó la entrevista con una persona real, la interpretación autónoma
del agente real dentro de la app, ni la interacción del botón en una ventana
real. El estado de marca y el envío del pedido tienen prueba con motor falso;
el botón conserva los bloqueos del envío normal. No se probaron ofertas reales
ni cambios de marca elegidos por una persona. La aceptación editorial sigue
pendiente. No se migran agencias ya inicializadas a una versión nueva del kit.
