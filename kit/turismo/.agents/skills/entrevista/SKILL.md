---
name: entrevista
description: Recorrido para armar la agencia con la usuaria (nombre y firma, contactos, logo, qué manda hoy, canales, tono y plantillas). Usala cuando pide ayuda para empezar o acepta armar la agencia.
---

# Armar tu agencia

Seguí este recorrido cuando la usuaria pide ayuda para empezar, o acepta la
invitación. Conversá: una o dos preguntas por mensaje y esperá la respuesta.
No mandes un cuestionario entero ni elijas por ella. Si ya hay marca, leela y
preguntá qué quiere completar. Nunca reemplaces acuerdos previos sin avisar.

Cuando la respuesta sea elegir entre pocas opciones, preguntá con opciones
(`request_user_input`): Bitácora le muestra una tarjeta para tocar una y
siempre suma «Otra» para que escriba lo suyo. Usalas donde se marcan abajo.
Los datos abiertos (nombre, firma, contactos, frases) preguntalos en el
mensaje, sin opciones: no le propongas datos para que elija.

## Conocernos

Antes de preguntar, leé `perfil.md` en la raíz de la carpeta. Si ya trae el
nombre de la agencia y el nombre de la usuaria, no los vuelvas a preguntar:
usá esos nombres y preguntá solo cómo le gusta firmar los mensajes. Lo que
marcó como uso de Bitácora orienta qué ofrecer primero: si marcó imágenes para
vender, empezá por las plantillas para historias y WhatsApp; si marcó
presupuestos, por la de propuestas; si marcó responder consultas, por los
mensajes para clientes.

1. «¿Cómo se llama tu agencia y cómo te gusta firmar los mensajes?» Si el
   perfil ya tiene la agencia, preguntá solo la firma.
2. «¿Qué datos querés que vean tus clientes para contactarte?» Preguntá por
   WhatsApp, correo, dirección, redes y legajo u otros datos legales que quiera
   dar. No son obligatorios. Repetí lo recibido para confirmar; nunca inventes.
3. «¿Tenés un logo? Podés adjuntarlo acá.» Si no tiene, seguí con el nombre
   escrito; no generes un logo con IA ni frenes la entrevista.
4. «¿Me mostrás algo que les mandes hoy? Puede ser una captura, una foto o un
   PDF.» Mirá el adjunto para inferir composición, colores y tono. Confirmá lo
   que inferiste. Si no tiene, seguí desde cero.
5. «¿Dónde lo mandás más?» Preguntalo con opciones: «WhatsApp», «Historias»
   y «Publicaciones»; si es otro (por ejemplo PDF), lo escribe en «Otra».
   Siempre dejá al menos una plantilla vertical de 1080 × 1920 para WhatsApp e
   historias; sumá otros formatos solo si los necesita.
6. «¿Les hablás de vos o de usted?» y «¿Preferís algo cálido o más formal?»
   Preguntalas con opciones, en la misma tarjeta. Después preguntá en el
   mensaje si usa emojis y si hay frases que usa o prefiere evitar. Podés
   proponer ejemplos de redacción para que confirme, sin atribuirle experiencia.

## Elegir mirando

No le pidas que describa un diseño. Prepará tres direcciones y llamá `dibujar`
para que vea las muestras antes de decidir. Cada una combina una paleta, un par
de fuentes de `fuentes/` y una composición realmente distinta (por ejemplo:
editorial con título serif, bloques con título display, y cercana con acento
manuscrito). La manuscrita se usa en frases cortas, nunca para precio o detalle.
Si hay logo, tomá sus colores como punto de partida. Si mostró algo que manda
hoy, una dirección debe respetar ese estilo, sin copiar datos de la oferta.

Usá exactamente el mismo texto y los mismos datos en las tres muestras; solo
cambia el número de opción «1», «2», «3», escrito dentro de cada pieza. Si no
hay oferta, usá `ejemplo/fuente.md` y escribí «Datos ficticios. No publicar.» en
todas. Esas numeraciones son rótulos de comparación, no datos de una oferta:
guardalas en una fuente de muestra separada con procedencia y citas si las
controlás. Nunca las agregues a la fuente de una oferta real para pasar el control.
Guardá muestras y dibujos fuera de `ejemplo/` para que la app los muestre.

Usá HTML estático con `data-piece`, tamaño explícito y sin scripts. Cargá
`fuentes/fuentes.css` con una ruta relativa desde el HTML; el kit ya lo copia
a la agencia. No uses URLs ni fuentes instaladas en la compu. Llamá `dibujar`
con width 1080, height 1920 y destinos nuevos. Mirá los PNG y corregí desbordes.
Preguntale con opciones «¿Cuál te gusta más?»: «La 1», «La 2» y «La 3», cada
una con una frase corta que la describa; si quiere mezclar, lo escribe en
«Otra». Esperá su elección. Si pide una mezcla, dibujala y pedile que la
confirme.

## Guardar lo elegido

Después de la elección creá estos archivos editables dentro de la agencia:

- `marca/datos.md`: texto simple, una línea por dato confirmado (nombre, firma,
  contactos, redes, legales). Para teléfonos que agrupan dígitos con espacios,
  citá cada token visible: «11 4567 8901» necesita las claves «11», «4567» y
  «8901», todas a la misma línea. No cambies datos para facilitar el control.
- `marca/estilo.json`: colores con nombre, valor y uso; fuentes elegidas,
  tamaños y ajustes de composición. Es una referencia para editar HTML, no
  un motor de plantillas. Registrá cuál opción eligió.
- `marca/voz.md`: vos o usted, tono, emojis, frases que usa y que evita, firma.
- `marca/logo.*`: copiá el adjunto de `adjuntos/` si lo dio. No inventes otro.
- `plantillas/vertical.html`: HTML estático de 1080 × 1920, con portada,
  detalle y precio como secciones `data-piece`. Partí de
  `ejemplo/plantilla-vertical.html`, adaptá lo visual a lo elegido y poné los
  contactos confirmados, con citas `m:` a `marca/datos.md`. Si no hay un dato,
  sacalo de la pieza, sin inventarlo. Si hay logo usalo con ruta relativa.

Las plantillas no leen JSON al abrirse: vos volcás los valores de estilo y los
datos en el HTML. Para usarlas, copiá el HTML a la carpeta de la propuesta,
editá textos y citas, y corregí las rutas relativas a fuentes y logo según la
profundidad nueva. No crees un JSON intermedio ni un programa que las rellene.
Si cambia una línea de marca, actualizá las citas de los HTML que modifiques.
No reescribas fuentes de ofertas ni resultados viejos sin que te lo pidan.

## Probar y cerrar

Pedí un link de una oferta real si tiene; usá `traer`. Si no, copiá la plantilla
a `propuestas/prueba/pieza.html` y usá los datos de `ejemplo/fuente.md`, marcados
como ficticios en cada sección. Citá las líneas reales de esa fuente y las de
marca. Llamá `controlar` con `html`, `source`, `brand: "marca/datos.md"`,
`rules: "ejemplo/rules.json"` (adaptadas al operador y al tono) y `report`.
Corregí todos los errores y revisá el sentido de las citas antes de `dibujar`.
Mirá cada imagen y ofrecé ajustar lo que no le guste.

Cerrá en palabras simples, sin rutas: «Quedaron guardados tu marca, tu forma de
hablar y una plantilla para tus propuestas. Podés cambiar cualquier cosa
pidiéndomelo, por ejemplo “cambiá el verde por un azul” o “agregá mi Instagram”.»
No digas que algo quedó guardado hasta haberlo escrito y comprobado.

## Cambiar después

Leé marca y plantilla antes de editar. Un dato nuevo va a `datos.md` y a los
HTML que esté usando, con sus citas; una forma de hablar va a `voz.md`. Si
cambia el nombre de la agencia o de la persona, actualizalo en `perfil.md`
además de `datos.md`.
Antes de cambiar el estilo guardado, dibujá una muestra con el cambio y esperá
su elección. Después actualizá `estilo.json` y las plantillas para que sigan
coincidiendo. Conservá los originales hasta la confirmación. Volvé a controlar
y dibujar toda pieza que cambies; no prometas actualizar entregas anteriores.
