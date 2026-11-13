# Bitácora

Nombre provisorio. App de escritorio para que una agencia de turismo arme y use
su propio entorno de trabajo con agentes, usando la suscripción de ChatGPT que
ya paga. Pensada para personas no técnicas.

Estado: esqueleto local para Windows. Todavía no hay instalador.

## Desarrollo

Requiere Node.js 22 o posterior y npm. `npm install` instala **Codex CLI 0.168.0**
como dependencia de desarrollo exacta. La app y el generador de tipos usan su
ejecutable nativo, independientemente del Codex del PATH. `BITACORA_CODEX_BIN`
permite seleccionar otra copia, que debe tener esa misma versión.

```powershell
npm install
npm run dev
```

Abrí la dirección de entrada que imprime `npm run dev` (empieza con
`http://127.0.0.1:5173/entry#`). Sirve una sola vez y vence en dos minutos.
Después podés recargar y abrir otra pestaña en `http://127.0.0.1:5173`.
Usá siempre ese mismo nombre: `localhost` tiene otras cookies. Si vence antes
de entrar, reiniciá el servidor para obtener otra dirección.
Tocá **Conectar ChatGPT** y completá el acceso
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
Usa datos desechables en `.local/issue16-verify-browser` y capturas en `.local/`.
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

El aislamiento
estricto de lecturas, las copias y deshacer corresponden al issue #4 y no
están implementados. Todavía no hay kit ni instalador.

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
**Copiar** lleva la imagen al portapapeles para pegar en WhatsApp Web;
**Guardar** la descarga con su nombre. Los PDFs tienen **Abrir** y **Guardar**.
En **Galería** están agrupados por trabajo, con los resultados más nuevos
primero y **Ir al trabajo** para continuar. Si borraste un archivo, se muestra
un aviso. La asociación sobrevive al cierre de la app; si un resultado se
modifica más adelante, las tarjetas muestran el archivo actual, no una copia
histórica (copias y deshacer pertenecen al issue #4).

La detección compara contenido antes y después del pedido; no depende de los
avisos del motor. Excluye `adjuntos/`, carpetas ocultas, enlaces simbólicos y
`node_modules`. Los elementos que no se pueden leer se saltean y se anotan en
el detalle. Si falla toda la revisión, se avisa y se puede seguir trabajando.
El recorrido compara tamaño y fechas antes de calcular hashes y tiene topes:
20.000 entradas, 5.000 imágenes/PDFs, 64 niveles, 512 MB de lectura de contenido
por revisión y 100 MB por resultado. Los límites alcanzados quedan en el detalle.
El estado previo se guarda aparte de los trabajos, en `pending-files/` dentro de
la carpeta de datos, y se elimina al terminar la revisión. No identifica quién hizo un cambio concurrente en esa carpeta.
Los adjuntos viajan por la conexión local autenticada; las lecturas requieren
la misma cookie de sesión que la pantalla, sin otro token de archivos. Al abrir un PDF
se usa una dirección temporal sin ese token. Sólo se
sirven archivos registrados, comprobando su ruta real dentro de la agencia.

`npx tsx scripts/verify-files-browser.ts` levanta una instancia falsa y Edge,
prueba adjuntos, portapapeles, descarga, galería y archivos borrados; guarda
capturas en `docs/verification/issue5/` y limpia sus datos y procesos al terminar.
Requiere libres los puertos 5173 y 4317. La evidencia y los límites están en
[la verificación del issue #5](docs/verification/issue5/verification.md).

## Acceso local y límites de protección (issue #16)

El servidor genera un secreto aleatorio de 256 bits por arranque, sólo en memoria.
No lo imprime ni lo agrega a trabajos, archivos de datos, respuestas de la
pantalla o direcciones. La entrada impresa contiene otro código aleatorio:
sirve una sola vez durante dos minutos. Va en el fragmento `#`, que no viaja
en el pedido HTTP; la página lo borra con `history.replaceState` antes de
canjearlo por POST y vuelve a la pantalla con `location.replace`.
Las respuestas de entrada, sesión y archivos indican `no-store` y `no-referrer`.
No se usa almacenamiento persistente desde JavaScript.

El canje entrega una cookie `HttpOnly; SameSite=Strict; Path=/`, sin Domain,
Expires ni Max-Age. No lleva Secure porque este desarrollo usa HTTP local.
WebSocket, estado de sesión y archivos exigen esa misma cookie, además de los
controles actuales de Host y Origin. Los secretos y códigos se comparan en
tiempo constante con entradas de tamaño fijo. JavaScript no recibe el secreto.
Dos pestañas del mismo navegador y nombre local comparten la sesión. Al
reiniciar cambia el secreto: las pestañas dejan de reintentar cuando el servidor
vuelve y muestran «Volvé a entrar a Bitácora». Hay que abrir la nueva entrada.

**Garantía actual:** un proceso local que sólo falsifica Host/Origin no puede
operar la app ni conseguir archivos. Tampoco puede recuperar el secreto de
`works.json` o del estado de Bitácora. Esto no es una frontera completa frente
a un agente que lee cualquier archivo del usuario: el navegador puede guardar
incluso cookies de sesión en su base, restauración de sesiones, copias o volcados.
HttpOnly impide leer desde JavaScript, no desde disco. No se confía en que esa
base esté cifrada o cerrada. El fragmento se reemplaza en el historial normal,
pero un navegador, extensión o sincronización puede registrar la URL antes.
Si se filtra el código antes del canje, gana el primero que lo use, incluso
un proceso local que falsifique Origin; los dos minutos sólo acotan la ventana.
La terminal y su historial de salida también deben considerarse sensibles
hasta el canje o vencimiento. Otros servicios del mismo host comparten cookies
por nombre, no por puerto. No se promete aislamiento frente a esos servicios,
a extensiones, a inyección de código o a lectura de memoria del proceso.

**App empaquetada (#9):** la cáscara Tauri podría entregar una credencial en
memoria por un canal privado a la pantalla, sin cookie persistible ni URL de
entrada. Eso permitiría separar la credencial de los archivos que lee el agente;
requiere implementar y verificar ese canal y el aislamiento de procesos. No
está implementado acá y no protege por sí solo contra lectura de memoria.

La prueba real de MXC, sin login ni inferencia, y las capturas de entrada,
recarga, segunda pestaña y reinicio están en
[la verificación del issue #16](docs/verification/issue16/verification.md).
Para repetirla: `npx tsx scripts/verify-loopback.ts` y
`npx tsx scripts/verify-session-browser.ts`. Usan datos desechables dentro de
`.local/`, el Codex fijado y Edge instalado; no usan la cuenta personal.
