# Verificación del issue #5

Fecha: 2026-11-13. Base: `main` en `4ad9032`. Sin subagentes ni cambios en
`.csdd/`, el Codex personal o el proyecto 787 Rumbos.

## Resultado

- PASS: `npm run typecheck`.
- PASS: `npm test`, tres corridas consecutivas de 37 pruebas cada una.
- PASS: `npm run build`.
- PASS: `npx tsx scripts/verify-files-browser.ts`, con Edge real y motor falso.
- PASS: dos pedidos cortos con Codex 0.168.0 instalado por npm, en la instancia
  `prueba` autorizada. Cuenta conectada y protección habilitada. No se pidió
  login, acceso total ni preparación administrativa. Se conservaron sus datos.
  [Registro sin credenciales](real-check.json).

## Cobertura automática

El motor falso verifica copia única, espacios, acentos y ñ, tipos admitidos,
firmas básicas de formato, UTF-8, formatos inválidos, base64 inválido, 20 MB por
archivo, 40 MB por pedido y hasta 10 adjuntos. Verifica resultados nuevos y
modificados por contenido, exclusión de adjuntos, dependencias y carpetas
ocultas, persistencia tras reiniciar y archivo borrado. El proceso falso verifica
que el adaptador transforma las imágenes locales y menciona las rutas de PDF
sin perder acentos ni espacios. Engine recibe texto y una lista genérica de archivos.

Los archivos se piden por identificador registrado, nunca por una ruta elegida
por el navegador. Las pruebas HTTP verifican token ausente/equivocado, Origin
ajeno y Host ajeno, nombres con acentos, descarga idéntica y archivo eliminado.
También se prueban rutas absolutas, `..` y junctions fuera de la agencia al leer
y al adjuntar. No hay listado HTTP ni CORS abierto. La subida usa el WebSocket
que comprueba Origin y Host; la lectura usa un token aleatorio de 256 bits por
arranque, entregado por esa conexión. El token no se persiste y las respuestas
llevan `no-store`, `nosniff` y una política restrictiva.

## Navegador

El guion reproducible crea sus datos dentro de `.local/`, los elimina y cierra
Edge y los dos servidores en `finally`. Prueba:

1. Arrastrar una imagen válida y verla adjunta con su nombre.
2. Pegar un link, enviar y comprobar que es un enlace.
3. Ver la miniatura del pedido y los resultados PNG y PDF en la conversación.
4. Copiar y leer del portapapeles una imagen PNG real.
5. Descargar, comparar los bytes con el original y comprobar el nombre.
6. Abrir la galería con Enter, comprobar acciones y volver al trabajo con Enter.
7. Recargar, elegir un archivo con el control nativo y comprobar el aviso al
   borrar un resultado.
8. Comprobar que no hay desborde horizontal a 460 px.

Capturas: [arrastre](drop.png), [conversación](conversation.png),
[galería](gallery.png), [archivo borrado](missing.png),
[galería angosta](gallery-mobile.png).

El navegador compartido falló dos veces al automatizar clics; la prueba final
se hizo con Playwright y Edge. La muestra inicial de un PNG mínimo no era
decodificable para el portapapeles; la final se dibuja en canvas y se copia.

## Codex real y límites

El primer pedido adjuntó una captura sintética de Bitácora y obtuvo una descripción
correcta en una oración. El segundo pidió dibujar con un comando un PNG verde de
200 × 120. `issue5-prueba-verde.png` quedó registrado como resultado del segundo
pedido. No se hicieron más pedidos. El guion real exige habilitación explícita
por variable de entorno para evitar una ejecución accidental; no integra las
pruebas habituales.

No se probó pegar en WhatsApp Web ni se hizo una recorrida con lector de pantalla.
El PDF sintético comprueba su tarjeta y acciones, no el visor PDF del sistema.
La detección ocurre al terminar, fallar o pausar un pedido, y al volver a abrir
un pedido interrumpido por cierre. No hay previsualización durante la ejecución.
Un cambio concurrente ajeno al agente puede quedar asociado al pedido activo.
Las tarjetas apuntan al archivo actual; las versiones históricas pertenecen a #4.
Se conservó el diseño base.
