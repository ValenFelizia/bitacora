# Recorrido desde una página de un operador

Este es un ejemplo de uso de las herramientas, no una propuesta para publicar.

1. Pedí a la usuaria la dirección de una oferta. Llamá `traer` con
   `{"url":"<dirección de la oferta>","destination":"propuestas/prueba"}`.
   No uses las tarifas ficticias de este ejemplo para completar datos faltantes.
2. Leé `propuestas/prueba/fuente.md` con sus números de línea físicos. Si la
   usuaria aporta un dato, agregalo con `traer`:
   `{"destination":"propuestas/prueba","notes":"<dato confirmado por la usuaria>"}`.
3. Copiá `pieza.html` a esa carpeta y reemplazá los datos ficticios por los que
   realmente están en la fuente. Actualizá cada `data-cites` con la línea
   correspondiente. Podés usar las fotos descargadas con rutas relativas.
   Copiá `rules.json` y agregá el nombre del operador para impedir que aparezca.
4. Llamá `controlar` con
   `{"html":"propuestas/prueba/pieza.html","source":"propuestas/prueba/fuente.md","report":"propuestas/prueba/control.md","rules":"propuestas/prueba/rules.json"}`.
   Si falla, corregí las citas o sacá el dato. Revisá también el sentido de
   cada línea: precio, hotel, unidad, fechas y base tienen que coincidir.
5. Cuando el control pase, llamá `dibujar` con
   `{"html":"propuestas/prueba/pieza.html","destination":"propuestas/prueba/salida","width":1080,"height":1920}`.
   Revisá `todas.png`, los avisos y el PDF. Si hay desbordes, acortá el texto,
   repetí el control y dibujá en una carpeta de salida nueva.

La app incluye lo necesario. No le pidas a la usuaria que instale programas.
