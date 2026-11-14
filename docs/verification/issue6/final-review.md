# Tercera ronda: arreglos acotados

Se verificaron N1–N7 y los puntos 5/8 contra `5502148`. Todos tenían respaldo.
No se modificó el control de Origin (#16), ni se integró main (#14 sigue pendiente).

## Descargas reales

Se ejecutó `npx tsx scripts/verify-fetch.ts <URL>` con una lista temporal externa
a la agencia, usando la extracción de la app y la función traer real. Ambas
descargas validaron las direcciones resueltas y fijaron la conexión a una de ellas:

- `https://www.wikipedia.org/`: 4603 bytes de fuente y siete fotos. Registro en
  `public-fetch-www.wikipedia.org.json`.
- `http://neverssl.com/`: 82 bytes de fuente, sin fotos. Registro en
  `public-fetch-neverssl.com.json`. La página inicial devolvió solo «NeverSSL»
  como texto extraíble: no se ejecuta JavaScript de sitios externos. Un primer
  intento tuvo timeout de conexión; el segundo terminó correctamente.

La función solo acepta respuesta HTTP 200 para guardar la fuente. Ahora todos
los pedidos, también fotos y redirecciones, llevan User-Agent de navegador y
Accept para HTML e imágenes. La prueba HTTP local comprueba ambas cabeceras.
El formato de fotos se decide por la firma de bytes, sin exigir un MIME exacto:
se prueban image/jpg, application/octet-stream y MIME contradictorio; los bytes
que no son JPEG/PNG/WebP se siguen rechazando.

## Escrituras: carrera y limpieza

La revalidación posterior no alcanzaba para evitar un mkdir o temporal vacío
afuera. Ahora `directory-lock.ts` usa Koffi para llamar a CreateFileW y conservar
handles reales de Windows durante toda la escritura:

1. Abre cada directorio sin seguir reparse points, inicialmente sin compartir
   escritura ni borrado. Antes de crear cada hijo, el padre ya está protegido.
2. Crea un archivo de guarda que permanece abierto sin compartir borrado. Con
   esa guarda no se puede vaciar el directorio para convertirlo en junction.
3. Conserva el handle del directorio sin compartir borrado. Comparte escritura
   para permitir sus propias operaciones link/rename. No es un lock cooperativo.
4. Protege el temporal contra borrado mientras escribe. Cierra, publica y limpia
   dentro de los directorios aún protegidos. Todos los handles se cierran incluso
   al fallar; solo se elimina un temporal si fue creado por esta operación.

La prueba inyecta un intento real de rename + junction al exterior ENTRE control
y mutación, antes del mkdir de un hijo y antes del open del temporal. Windows
lo bloquea. Se comprueba que afuera no existe ni carpeta ni archivo vacío, y
que no quedan temporales/guardas. También se inyectan fallos después del open y
después de escribir para comprobar limpieza.

`verify-kit-mutations.ts` retira temporalmente la protección y conserva solo
comprobaciones de existencia: la prueba falla porque aparece `child` afuera.
También retira las dependencias de producción de tsx/playwright-core y verifica
que falla la prueba del punto 10. Restaura ambos archivos en finally. Evidencia:
`final-mutations.json`. Esas fallas son intencionales, no fallas del código entregado.

Referencias primarias del mecanismo:
[CreateFileW: compartir DELETE controla rename/borrado](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
y [restricciones de reparse points: directorio vacío](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points).
Se verificó en esta máquina con operaciones reales, sin administrador ni compilador.
Para #9 hay que distribuir también el binario precompilado Koffi correspondiente
a la arquitectura Windows; el instalador no se implementa acá.

## Datos y control

- Marca de kit en datos, por identidad real de agencia: borrar todo el contenido
  de la agencia y volver a inicializar no repone nada.
- Arranque con `preparePaths`: compara rutas reales antes de copiar el kit o
  arrancar Codex. Una junction que hace que los datos queden dentro se rechaza,
  incluso si el hijo todavía no existe.
- Extracción con comillas angulares/tipográficas, paréntesis balanceados y www
  sin esquema. Se mantiene comparación exacta; cambiar consulta o esquema falla.
- Lista dañada: MCP falla cerrado; solo la app la aparta y crea una lista nueva.
  Se preserva el archivo dañado y no se recuperan autorizaciones anteriores.
- El control rechaza list-style-type con texto/numeración, @counter-style,
  head/title visibles y reglas @page, también en estilos de impresión. Mensaje
  que indica qué sacar. El dibujo genera su propia regla de tamaño después de validar.
- Dígitos Unicode se cuentan y necesitan cita. El operador vuelve a controlarse
  en pseudo-elementos; se quitan caracteres de formato invisibles al comparar.
- Kit actualizado: números en imágenes o escritos con palabras no se controlan
  y no se deben usar para precios ni fechas. Sigue siendo un control de errores
  honestos, no una prueba contra un agente que edite la fuente.

## Comprobaciones y límites

`verify-kit.ts` volvió a pasar: Edge real con fuente local, PNG exacto, PDF,
fuente rota y desbordes; app-server lista y llama las tres herramientas sin
aprobación. Cero turnos de modelo. La conversación real con una persona y el
instalador siguen sin verificarse.

Se conserva `final-tests-timing-failure.txt`: una corrida con verificación Edge
simultánea falló en la afirmación temporal preexistente de codex.test.ts:286
(backoff). No se modificó ese archivo ni se ocultó la corrida fallida.

`final-tests-1.txt`, `final-tests-2.txt` y `final-tests-3.txt` terminaron con
49/49 pruebas aprobadas cada una. `final-typecheck.txt` y `final-build.txt`:
aprobados. No quedaron procesos propios. La limpieza de
`%LOCALAPPDATA%\Bitacora-dev\issue6` fue rechazada por revisión automática
(«blocked by policy»). Quedan `agencia ñ á OVc6Ad`, `agencia ñ á udMNXZ` de la
primera entrega y `lock-probe-moved` del ensayo exploratorio de handles. Los
casos y scripts de verificación terminados sí eliminaron sus datos descartables.
