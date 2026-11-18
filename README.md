# Bitácora

Nombre provisorio. App de escritorio para que una agencia de turismo arme y use
su propio entorno de trabajo con agentes, usando la suscripción de ChatGPT que
ya paga. Pensada para personas no técnicas.

## Instalación en Windows

Ejecutá **Bitácora … setup** y abrí **Bitácora** desde el menú Inicio.
El instalador trae lo necesario para abrir la app. Para dibujar las piezas,
Bitácora usa Microsoft Edge, que viene con Windows.
Tocá **Conectar cuenta** y seguí los pasos de ChatGPT en tu navegador.
Si ya tenés Bitácora abierta, abrir el ícono de nuevo vuelve a esa ventana.
Si desinstalás la app, se conservan tus trabajos, tu cuenta y la carpeta de la agencia.

Para **generar el instalador** en Windows, instalá Rust con el destino MSVC
de tu equipo y Visual Studio Build Tools con la carga de trabajo de C++ de
escritorio. Con Node.js 24 y npm, corré `npm ci` y `npm run build:installer`.
El instalador queda en `src-tauri/target/release/bundle/nsis/`. El armado
descarga dependencias y WebView2, y verifica el ejecutable de Node contra el
SHA-256 de su versión oficial. La instalación es por usuario. Ver
[DEC-013](docs/DEC-013-windows-installer.md).

## Desarrollo

Requiere Node.js 22 o posterior y npm. `npm install` instala **Codex CLI 0.168.0**
como dependencia de desarrollo exacta. La app y el generador de tipos usan su
ejecutable nativo, independientemente del Codex del PATH. `BITACORA_CODEX_BIN`
permite seleccionar otra copia, que debe tener esa misma versión.

```powershell
npm install
npm run dev
```

Abrí http://127.0.0.1:5173 o http://localhost:5173, tocá **Conectar ChatGPT** y completá el acceso
oficial. Si el navegador bloquea la ventana, usá **Continuar en el navegador**.
Bitácora prepara MXC automáticamente cuando está disponible, sin pedir permisos.
Si hace falta un permiso de administrador, muestra **Antes de empezar** y explica
el cambio antes de habilitar **Preparar la protección**. Si falla, bloquea los
pedidos y permite reintentar. Una falla de consulta vuelve a consultar el estado.
En cada arranque de la app comprueba nuevamente la disponibilidad de MXC.
Después escribí un pedido. Cada trabajo aparece a la izquierda: podés abrirlo
y seguirlo, también después de cerrar y volver a levantar el servidor.
**Pausar pedido** detiene el pedido actual; no deshace cambios en archivos.

La carpeta de la agencia se crea en `%USERPROFILE%\Bitacora`. Los trabajos se
guardan en `%APPDATA%\Bitacora\works.json`; el estado y las credenciales de
Codex se guardan por separado en `%APPDATA%\Bitacora\codex` (archivo de
credenciales administrado por Codex). No se usa el Codex personal de la PC.
No compartas esa carpeta de datos ni sus credenciales.

Para pruebas se pueden cambiar `BITACORA_WORKSPACE` (carpeta de trabajo) y
`BITACORA_DATA_DIR` (datos y cuenta). Deben ser carpetas separadas, sin estar
una dentro de la otra. El servidor escucha sólo en `127.0.0.1:4317` y acepta
la interfaz de `127.0.0.1:5173` o `localhost:5173`, exclusivamente. `BITACORA_PORT` y `BITACORA_WEB_ORIGIN`
permiten cambiar el servidor; si cambiás su puerto, ajustá también el destino
de desarrollo en `web/vite.config.ts`.

```powershell
npm run typecheck
npm test
npm run build
npm run generate:protocol
```

Las pruebas automáticas usan un motor falso y un proceso que simula el protocolo
por stdio, sin consumir ChatGPT. Con Vite levantado (`npm run dev -w web`),
`npx tsx scripts/verify-browser.ts` comprueba la pantalla con Edge, la caída del
motor, la reconexión, los dos nombres locales y el acceso en una ventana nueva.
Usa datos de prueba en `%LOCALAPPDATA%\Bitacora-dev\pr11-browser` y capturas en `.local/`.
Los tipos
de Codex están generados y versionados en `server/src/codex/generated`, con
la versión en `server/src/codex/VERSION`. El generador y el servidor rechazan
otras versiones. Referencia: [protocolo oficial](https://learn.chatgpt.com/docs/app-server).

Este paso usa `workspace-write` y `approvalPolicy: never`. El aislamiento
se consulta al arrancar: si Windows no confirma una protección real, la app
avisa y bloquea los pedidos. El detalle del motor indica el estado y el modo.
El paso guiado prepara la protección (issue #12); no usa el modo `unelevated`
ni continúa sin protección. La versión sigue fijada en 0.168.0: el Codex
del PATH puede tener otra versión sin afectar la app.
`npx tsx scripts/verify-protection.ts` verifica el paso guiado con un proceso
falso y Edge, sin inferencia. Guarda capturas en `docs/verification/issue12/`
y elimina sus datos de prueba fuera del repo al terminar.
Si el motor se cae, intenta relanzarlo hasta cinco veces, con espera creciente;
no reenvía pedidos automáticamente. Si no vuelve, reiniciá la app.
Un archivo de trabajos dañado se conserva como `works.corrupt-<fecha>.json` y
la app abre una lista vacía con un aviso. Si falla un guardado, muestra un aviso
y el siguiente guardado puede recuperarse.

Las copias y Deshacer están implementados. El perfil beta de lecturas se probó
por separado y queda desactivado en la app. El kit está integrado con adjuntos,
galería y Deshacer.

## Kit de turismo

Al iniciar la app, antes del motor y del primer escaneo, se copia `kit/turismo/` a la carpeta de la agencia
una sola vez, sin reemplazar archivos existentes, y deja la marca
`kit-initialized-<identidad de la agencia>.json` en la carpeta de datos, fuera de
la agencia. No repone archivos borrados aunque se vacíe toda la agencia.
Las instrucciones, el HTML de ejemplo y las reglas son
archivos que el agente puede modificar conversando con la usuaria. No incluyen
marca ni tono de una agencia: eso corresponde a #7.

La app registra un servidor MCP por stdio en **su propio** `CODEX_HOME`.
`server/src/codex/kit.ts` configura exclusivamente `traer`, `controlar` y
`dibujar` con `approval_mode = "approve"`, compatible con Codex 0.168.0 y
`approvalPolicy: never`. No habilita red del shell ni otros permisos.
El servidor MCP es un envoltorio de los módulos neutrales de `server/src/tools/`.

- **Traer:** recibe `url` y `destination`. Guarda `fuente.md` y hasta 12 fotos
  (JPEG, PNG o WebP). Límite de página: 2 MB; por foto: 5 MB; operación: 45 s;
  las fotos se guardan en `<destino>/fotos/operador/` como material de entrada.
  Prioriza imágenes grandes de contenido (incluidos data-src, srcset, picture,
  data-bg-image y fondos CSS del HTML), evita logos/botones y descarta imágenes
  menores de 1500 bytes, con lado corto menor de 400 px o lado largo menor de
  800 px, o relación de lados mayor de 4. Devuelve ruta, origen, bytes y dimensiones
  en `photoDetails`; si no hay fotos útiles pide que la usuaria aporte fotos.
  hasta 5 redirecciones. Valida cada destino y fija la dirección DNS validada
  al conectar (incluida la resolución de nombres en Node 24). Decodifica el
  charset de la cabecera o del meta HTML y decide el tipo de cada foto por sus
  bytes, aunque la cabecera diga image/jpg u octet-stream. Envía User-Agent de
  navegador y Accept para páginas y fotos.
  Rechaza redes privadas, locales y loopback. Sin `url`, `notes`
  agrega datos de la usuaria con fecha al final de la fuente existente.
- **Controlar:** recibe `html`, `source`, `report` y opcionalmente `rules`.
  Tanto `source` como `report` deben terminar en `.md`; otras extensiones se rechazan.
  Lee el texto del HTML en Edge y exige citas explícitas con el formato
  `data-cites='{"1.250":3}'`: el número visible debe aparecer en la línea
  física 3 de la fuente. Normaliza miles con punto y decimales con coma.
  Acepta miles con punto o coma y decimales sin confundir números completos.
  El informe muestra número, ubicación, línea citada y su texto; avisa sobre
  citas que sobran. Las reglas
  editables permiten prohibir nombres del operador y emojis, y advertir sobre
  afirmaciones de experiencia personal. La correspondencia de hotel, unidad,
  base y fecha todavía exige revisión del agente: la coincidencia numérica
  no prueba esas relaciones ni la veracidad de la fuente.
  Los números partidos entre nodos en línea se leen juntos; la cita completa va
  en el ancestro común que abarca todo el número. Bloques, br, celdas y separación
  visible separan números. El informe no puede coincidir con sus entradas, aun
  usando mayúsculas, separadores distintos o segmentos ./ y ../ equivalentes.
- **Dibujar:** recibe `html`, `destination`, `width` y `height` (por defecto
  1080 × 1920). Lee un archivo HTML estático con piezas `data-piece`, sin
  ejecutar sus scripts. Se rechazan shadow DOM declarativo, paneles internos
  (iframe, object, embed), formularios y content con counter/counters: usá texto
  con citas en el HTML principal. También rechaza listas con texto/números
  generados, @counter-style, reglas @page y head/title visibles. Reconoce dígitos
  Unicode; no controla números en imágenes ni escritos con palabras (no usarlos
  para precios o fechas). Usa `playwright-core`, Edge del sistema y escala 1,
  sin descargar navegador. Verifica fuentes, medidas, desbordes y fotos chicas;
  genera un PNG por pieza, PDF y `todas.png`. Rechaza recursos que no sean
  archivos dentro de la agencia. Usá una carpeta nueva para cada dibujo:
  las salidas existentes no se sobrescriben.
  El PDF usa el mismo medio de pantalla que se controló, para evitar que reglas
  de impresión oculten o cambien las piezas. También se rechaza una salida que
  coincida con el archivo de entrada del dibujo.

La app extrae los links http/https escritos en el texto de cada pedido de la usuaria y los
guarda en `allowed-urls.json` en la carpeta de **datos**, fuera de la agencia.
No extrae URLs de nombres ni contenido de adjuntos, ni de las menciones o textos
que el adaptador agregue al convertir ese pedido a la entrada del motor.
El MCP recibe esa ruta y solo la lee. `traer` requiere una coincidencia exacta
tras normalizar con URL (esquema, host, puerto, ruta y consulta; fragmento ignorado).
Cambiar la consulta, ruta, puerto o esquema no queda autorizado. Si falta el link,
el agente debe pedirle a la usuaria que lo pegue en su pedido. Solo la descarga
puede seguir redirecciones y fotos extraídas de esa página, siempre con validación
de direcciones; el agente no propone URLs de fotos para descargar.
La extracción admite comillas angulares/tipográficas, paréntesis balanceados y
links `www.` sin esquema (se guardan con https). Si la lista se daña, la app la
aparta con un nombre `corrupt-*` y crea una lista nueva; el MCP falla cerrado
mientras tanto. Antes de arrancar se comprueba que datos y agencia están separados
por sus rutas reales, incluidas las rutas con alias del sistema.

Todas las rutas de herramientas son relativas a la agencia: se rechazan
escapes, rutas absolutas, enlaces simbólicos, junctions, enlaces múltiples y
nombres especiales de Windows. Las lecturas comprueban la ruta real y la identidad
del archivo abierto; Edge recibe esos bytes verificados desde su URL de archivo.
Las escrituras protegen cada directorio con handles de Windows sin compartir
borrado y un archivo transitorio protegido contra borrado que impide convertirlo
en junction. Se mantienen desde antes de crear subcarpetas hasta terminar la
limpieza. Usan temporal verificado en el mismo directorio y publicación
atómica (rename para reemplazo, enlace transitorio sin sobrescritura para archivos
nuevos), y vuelven a comprobar la ruta final. El kit no genera imágenes con IA ni busca fotos.
Los archivos HTML pueden usar fuentes locales y fotos guardadas en la agencia.

`npm test` incluye un cliente MCP real, un operador HTTP de prueba con permiso
de loopback explícito solo dentro del test, y dibujo real con Edge.
`npx tsx scripts/verify-kit.ts` comprueba además el catálogo y las llamadas a las
tres herramientas por app-server, sin iniciar un turno de modelo ni usar login.
Guarda evidencia en `docs/verification/issue6/` y usa datos descartables dentro
de `%LOCALAPPDATA%\Bitacora-dev\issue6\`. No usa puertos de la app.
`npx tsx scripts/verify-fetch.ts <URL>` comprueba además una descarga pública real y
registra resolución DNS, fuente y firma en `public-fetch-<host>.json`.
`npx tsx scripts/verify-kit-mutations.ts` comprueba que quitar la protección de
escritura o las dependencias de producción hace fallar sus respectivas pruebas;
restaura los archivos originales al terminar.
`npx tsx scripts/verify-kit-integration.ts` prueba la app con motor falso y un
cliente MCP real por stdio: pedido con adjunto, página HTTP local, control,
dibujo y resultados visibles en conversación y galería. Usa un puerto de servidor
asignado por el sistema y la interfaz en 5326. Guarda capturas y salidas en
`docs/verification/issue6/integration/`; no consume inferencia. Conserva sus
carpetas de prueba en issue6 para que el operador las limpie.

`controlar` protege contra errores honestos, no contra un agente que edite la
fuente. Ni una cita ni un número coincidente prueban la veracidad de esa fuente.
`tsx`, `playwright-core`, `koffi` y las dependencias del MCP son dependencias de producción
del servidor. Para #9 falta empaquetar ese paquete con sus dependencias, Node,
el Codex fijado, scripts/recursos necesarios y `kit/turismo`, conservando las
rutas relativas o adaptándolas al paquete. Se seguirá usando Edge del sistema,
sin descargar navegador; no se implementó el instalador en este issue.
El paquete debe incluir además el binario precompilado de Koffi para la arquitectura
Windows correspondiente; se usa para los handles del sistema, sin compilador ni
instalación adicional por parte de la usuaria.

- Qué tiene que hacer el MVP: [`.csdd/specs.md`](.csdd/specs.md)
- Por qué está armado así: [`.csdd/decisions.md`](.csdd/decisions.md)
- Qué falta: los issues del milestone **MVP**


## Adjuntos y resultados

Podés elegir **Adjuntar archivos** o soltarlos en cualquier parte de la ventana: imágenes PNG, JPG,
JPEG y WebP, PDF y texto UTF-8 (TXT, MD, CSV y JSON). Hasta 10 archivos, 20 MB
por archivo y 40 MB entre todos. Los links se pegan en el pedido y quedan como
enlaces. Los adjuntos se copian a `adjuntos/<trabajo>/` dentro de la agencia,
con nombres únicos para conservar los anteriores.

Al terminar cada pedido aparecen las imágenes y PDFs nuevos o modificados.
El agente no debe escribir rutas ni enlaces a archivos: sus botones aparecen
solos. Los enlaces de respuestas que no sean http/https se muestran como texto.
**Copiar** lleva la imagen al portapapeles para pegar en WhatsApp Web;
**Guardar** la descarga con su nombre. Los PDFs tienen **Abrir** y **Guardar**.
En **Galería** están agrupados por trabajo, con los resultados más nuevos
primero y **Ir al trabajo** para continuar. Si borraste un archivo, se muestra
un aviso. La asociación sobrevive al cierre de la app; si un resultado se
modifica más adelante, las tarjetas muestran el archivo actual, no una copia
histórica. Deshacer vuelve a consultar los archivos de las tarjetas y la galería.

La detección compara contenido antes y después del pedido; no depende de los
avisos del motor. Excluye `adjuntos/`, carpetas ocultas, enlaces simbólicos y
`node_modules`, la carpeta raíz `ejemplo/` del kit y las subcarpetas
`fotos/operador/` en cualquier oferta. Estas últimas contienen fotos de entrada
de traer, no piezas producidas. Los temporales y guardas `.kit-*` quedan excluidos
por su nombre oculto. Los elementos que no se pueden leer se saltean y se anotan en
el detalle. Si falla toda la revisión, se avisa y se puede seguir trabajando.
El recorrido compara tamaño y fechas antes de calcular hashes y tiene topes:
20.000 entradas, 5.000 imágenes/PDFs, 64 niveles, 512 MB de lectura de contenido
por revisión y 100 MB por resultado. Los límites alcanzados quedan en el detalle.
El estado previo se guarda aparte de los trabajos, en `pending-files/` dentro de
la carpeta de datos, y se elimina al terminar la revisión. No identifica quién hizo un cambio concurrente en esa carpeta.
Los adjuntos viajan por la conexión local autenticada; las lecturas requieren
un token impredecible por arranque que sólo entrega esa conexión. Al abrir un PDF
se usa una dirección temporal sin ese token. Sólo se
sirven archivos registrados, comprobando su ruta real dentro de la agencia.

`npx tsx scripts/verify-files-browser.ts` levanta una instancia falsa y Edge,
prueba adjuntos, portapapeles, descarga, galería y archivos borrados; guarda
capturas en `docs/verification/issue5/` y limpia sus datos y procesos al terminar.
Requiere libres los puertos 5173 y 4317. La evidencia y los límites están en
[la verificación del issue #5](docs/verification/issue5/verification.md).

## Copias y Deshacer

Antes de cada pedido se guarda una copia en `backups/` dentro de la carpeta de
datos de Bitácora, fuera de la agencia. No necesita Git ni otros programas.
Cada contenido se guarda una sola vez por SHA-256 y en flujo, sin cargar archivos
enteros en memoria. Tamaño y fechas evitan volver a leer archivos intactos. La
copia y la detección de resultados comparten un único recorrido antes del pedido
y otro al terminar. Se conservan ambas fotos del último pedido con cambios y una
caché del estado actual. No se usan enlaces duros.

Las fotos que trae el kit en `fotos/operador/` y el ejemplo editable se excluyen
de los resultados, pero entran en la copia. Deshacer también revierte archivos
creados por `traer` o `dibujar` durante el pedido, y ediciones de `AGENTS.md` y
`ejemplo/`. Los temporales `.kit-*` quedan fuera; la marca inicial y la lista de
links permitidos viven en la carpeta de datos y no se tocan al deshacer ni limpiar.

Antes de tomar la copia se escribe una marca de invalidación independiente de
`state.json`. Cada pedido recibe además un identificador que la app guarda con
los trabajos antes de enviarlo al motor. Al arrancar, sólo se acepta una copia si
su identificador, la marca y el último pedido guardado coinciden. Así, un archivo
de estado bloqueado no hace reaparecer un Deshacer viejo. Si tampoco se puede
escribir la marca, Deshacer queda deshabilitado durante esa ejecución; los pedidos
pueden seguir si se pueden guardar sus trabajos. Sin prueba independiente del
último pedido, las copias anteriores no se vuelven a ofrecer al reiniciar.

**Deshacer** se ofrece cuando no hay pedidos en curso. La confirmación identifica
el trabajo y pedido, aunque estés en otro trabajo. Sólo revierte las rutas que
cambiaron entre las fotos de antes y después de ese pedido, y cuyo estado actual
todavía coincide con la foto de después. Lo que agregaste, editaste, moviste o
borraste a mano después no se toca, incluso si enviaste otro pedido sin cambios.
La pantalla informa cuántos cambios revirtió y cuántos dejó sin tocar, con sus
nombres, sin rutas. Sólo hay un nivel de Deshacer.

Las comparaciones de nombres respetan mayúsculas equivalentes de Windows y usan
una agrupación Unicode conservadora (NFC y mayúsculas). Si el pedido renombró algo
sólo por mayúsculas o por la forma de un acento, Deshacer se niega antes de tocar
nada y deja seguir trabajando. Si ese renombrado fue manual, conserva esa entrada.
Los nombres reales se comprueban en disco antes de mover o borrar. No se fusionan
archivos: en esta máquina `ñ` compuesta y descompuesta pueden ser nombres distintos;
si ambos coexisten, cada entrada ambigua queda fuera de la copia y ninguna se
modifica. Lo mismo vale para `ß`/`SS` e `ı`/`I`: el resto conserva Deshacer.

Retomar una conversación no cambia archivos. En el siguiente pedido del trabajo
revertido se envía un aviso al motor como otra entrada de ese único turno; no se
agrega al mensaje guardado de la usuaria ni a las instrucciones de la conversación.
Los resultados del pedido revertido muestran «Este archivo ya no está disponible»
en conversación y galería; otros resultados anteriores recuperados siguen accesibles.

Se excluyen componentes que empiezan con punto, `node_modules` y `adjuntos`
(sin distinguir mayúsculas), enlaces simbólicos y junctions. Deshacer nunca borra
ni pisa esos elementos, incluidos enlaces creados por el agente y adjuntos originales.
Se guarda el atributo de sólo lectura de los archivos incluidos.

Topes: 20.000 entradas, 64 niveles, 5.000 archivos incluidos, 256 MiB por archivo
y 2 GiB de contenido por foto, incluso con caché. Los archivos que superan los
topes de archivo/cantidad/bytes quedan fuera, y el resto conserva Deshacer. Si el
pedido cambió un archivo omitido se avisa por nombre; no se repite la advertencia
en cada pedido. También quedan fuera los archivos y carpetas ilegibles, sin apagar
las copias del resto. Los topes de entradas/profundidad marcan áreas desconocidas:
no se confunde lo que no se alcanzó a mirar con un archivo borrado. Se avisa al
aparecer la limitación y se recuerda lo omitido al deshacer, sin repetir el mismo
aviso en todos los pedidos. Una falla de todo el almacén sigue avisando que esa vez
no se pudo guardar copia; no bloquea por sí misma el motor.

Antes de cambiar archivos al restaurar se verifican hashes necesarios, destinos,
enlaces por cada componente, conflictos archivo/carpeta con todos sus restos y
acceso de escritura hasta donde Node permite comprobarlo. Un bloqueo conocido
impide empezar y no deja un Deshacer pendiente que bloquee pedidos. Se comprueba
también que los padres existan o estén previstos, y se trata el atributo de sólo
lectura por separado de un bloqueo. Sólo después de superar esas comprobaciones
se preparan temporales y se registra la intención de cada operación. El original
se aparta a un nombre privado antes de instalar el reemplazo; si falla la instalación,
se intenta devolverlo sin pisar otro archivo. No se truncan enlaces duros ni se
comparten con ellos los contenidos de las copias. Se comprueban las rutas reales
inmediatamente antes y después de escribir o renombrar; las escrituras usan un
archivo abierto para evitar seguir un enlace nuevo en cada bloque de contenido.

Si aparece una falla durante la restauración, se conserva el plan, el progreso y
ambas copias. **Reintentar deshacer** continúa sin repetir operaciones terminadas,
también después de reiniciar. Una intención sin avance no se ofrece como
restauración pendiente. Si ya hubo cambios, también se ofrece **Dejar la carpeta
como está**: sólo repone una ruta faltante por un reemplazo sin terminar, con su
versión apartada y la copia de reemplazo todavía preparada. Respeta las
eliminaciones ya completadas y las que hiciste a mano después. Si no puede
reponer un reemplazo interrumpido, explica el motivo y conserva el reintento.
Recién después descarta ese Deshacer y permite enviar pedidos nuevos.
El resumen dice qué quedó revertido y qué no, por nombre. Mientras tanto se
conserva el contenido necesario para reintentar o decidir. Una eliminación manual
entre falla y reintento se respeta; no alcanza con que una operación figurara iniciada.
La opción se consume recién al completar y guardar el cierre, o al descartarla;
sin borrar contenidos en esos caminos. Los temporales incompletos se apartan y
se reconstruyen desde la copia. Los avisos se limpian con el siguiente pedido.

**Papelera de Bitácora.** Deshacer, reintentar y descartar conservan lo retirado,
los originales apartados y los temporales en `backups/trash/`, dentro de la carpeta
de datos y fuera de la agencia. Cada entrada registra origen, pedido, acción,
fecha y huellas. Su ubicación aparece sólo en el detalle técnico plegado del
trabajo. Todavía no hay una pantalla para recuperar desde esa papelera.
La recuperación comprueba archivo, apartado, temporal y papelera en disco para
cada acción iniciada, aunque el diario no haya alcanzado a marcar el avance.
También recupera un cambio interrumpido del atributo de sólo lectura.

En un mismo volumen se mueve por renombrado. Entre volúmenes se copia en flujo a
un temporal privado, se sincroniza y verifica por huellas, y recién entonces se
quita el origen, comprobando cada archivo. Si se interrumpe, queda el origen, la
copia completa verificada o ambos; nunca se usa una copia parcial como reemplazo.
La purga es independiente: sólo puede borrar una entrada cuando pasaron **al
menos siete días y tres pedidos posteriores con copia completada correctamente**.
No purga entradas del Deshacer disponible o pendiente; las transferencias
incompletas se conservan. Se ejecuta después de una copia posterior correcta.
Si falla el contador de copias correctas, la copia y Deshacer siguen disponibles;
esa vuelta no avanza la retención ni ejecuta la purga.
El almacén de contenidos tampoco se limpia al deshacer, reintentar ni descartar:
sólo después de otra copia correcta, respetando referencias de copias y papelera.
La caché sólo reutiliza una huella si sus bytes siguen guardados.

Esto conserva el contenido anterior a tocar Deshacer en la agencia, la papelera
o el almacén ante las interrupciones probadas. No garantiza restaurar archivos
excluidos ni una transacción de toda la carpeta. La retención ocupa espacio extra;
no reemplaza una copia externa frente a rotura del disco.

No es una transacción atómica de toda la carpeta: un error nuevo puede dejar un
avance parcial, que sigue siendo retomable. No se certifica una carrera entre una
comprobación y la llamada al sistema ni la supervivencia a un corte físico de energía.
Los desvíos detectados intentan revertir la escritura o el movimiento propio sin
sobrescribir un destino nuevo. Sin una API nativa con acceso relativo a una carpeta
abierta no hay una garantía atómica contra carreras arbitrarias; si la corrección
no puede terminar, se conserva la recuperación y sigue disponible descartar.
Si falta la foto de después al reiniciar un pedido interrumpido, no se inventa
esa foto a partir de posibles cambios manuales posteriores y no se ofrece Deshacer.
Las copias del esquema anterior del PR se conservan como manifiestos `legacy-*`,
pero no se ofrecen porque no tenían la foto de después.

Para otra instancia de desarrollo, `BITACORA_WEB_PORT` cambia el puerto de Vite
y `BITACORA_PORT` cambia el servidor y el destino de ambos proxies. Se conservan
5173/4317 por defecto. Configurar también `BITACORA_WEB_ORIGIN` para el nuevo origen.

Evidencia y límites actuales: [tercera ronda](docs/verification/issue4/round3.md).
Mediciones históricas: [segunda ronda](docs/verification/issue4/rework.md).
