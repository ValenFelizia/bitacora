# Título automático de los trabajos (issue #22)

## Qué ofrece el motor

Codex 0.168.0 (la versión fijada) **no nombra los hilos solo**. Verificado
contra el binario instalado, sin inferencia:

- `thread/start` devuelve `thread.name: null`; el nombre no aparece después de
  un turno.
- `thread/name/set` guarda un nombre y emite `thread/name/updated`; el nombre
  sobrevive a `thread/read` y a `thread/resume`.
- `thread/sample` (experimental, ya habilitado por `experimentalApi: true`)
  corre **un pedido de modelo sobre una copia efímera del último turno
  terminado** y devuelve el texto y los tokens que gastó. No agrega un turno
  visible ni ensucia la conversación.

## Cómo se obtiene el título

1. Al crear un trabajo, el nombre provisorio es el comienzo del primer pedido
   (lo que ya había).
2. Cuando el **primer pedido termina bien**, la app pide un título con
   `thread/sample`: un pedido corto en castellano que pide entre 2 y 5 palabras
   con el tema concreto, sin comillas ni punto final y sin usar herramientas.
3. La respuesta se limpia (primera línea, sin «Título:», sin comillas, sin punto
   final, hasta 60 letras cortando en un espacio) y pasa a ser el nombre del
   trabajo.
4. El nombre también se guarda en el motor con `thread/name/set`, para que la
   conversación se vea igual si se retoma desde Codex.

Si el pedido falla o se pausa, no se gasta la llamada: el trabajo conserva el
nombre provisorio y el primer pedido que termine bien lo titula. Esa espera se
guarda con el trabajo (`titlePending` en `works.json`), así que también vale si
la app se cierra y se vuelve a abrir entre medio.

## Cuánto cuesta

Una llamada más al modelo, con el contexto de la conversación que acaba de
terminar (en la práctica, en su mayoría caché) y una salida de pocas palabras.
No hay un pedido visible extra para la usuaria.

El motor devuelve los tokens exactos de esa llamada y la app los deja en el
detalle plegado del trabajo:

```
Título automático: 1200 de entrada (1000 en caché), 12 de salida.
```

## La usuaria puede cambiarlo

El encabezado del trabajo tiene «Cambiar el nombre». El nombre elegido gana
sobre el automático (aunque la respuesta llegue después, y aunque sea el mismo
nombre provisorio), se guarda en `works.json` y se manda al motor con
`thread/name/set`. La elección queda marcada con el trabajo (`renamedByUser`),
así que sobrevive a cerrar y abrir la app y ningún nombre que informe el motor
después la reemplaza. Se aceptan hasta 60 letras; un nombre vacío o más largo se
rechaza con un aviso en castellano. Mientras la app se está reconectando, el
botón de guardar queda apagado y el formulario sigue abierto para no perder lo
escrito.

## Límites y qué queda para la inferencia real

- La calidad del título y el consumo real (cuánto entra en caché) solo se pueden
  ver con una cuenta conectada. Hasta el 18/11 no hay cuota de ChatGPT: la
  prueba con inferencia real queda pendiente y está anotada en el PR.
- El pedido de título hereda las herramientas del hilo. El pedido pide no
  usarlas y se manda `disableMcp: true`; si el modelo igual intenta una
  herramienta, la muestra no devuelve texto y el trabajo conserva el nombre
  provisorio.
- `thread/sample` exige que el hilo esté inactivo y que el turno indicado sea el
  último terminado. Si el hilo todavía se está cerrando, se reintenta una vez a
  los 200 ms; si la usuaria ya mandó otro pedido, se deja el nombre provisorio.
