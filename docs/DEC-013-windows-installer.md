# DEC-013 — Instalador de Bitácora para Windows

El issue #9 aplica DEC-003, DEC-008, DEC-009 y DEC-010. La cáscara Tauri 2
instala por usuario con NSIS en castellano. Si al equipo le falta WebView2,
el instalador lo descarga. El dibujo sigue usando Edge del sistema. La firma y las actualizaciones automáticas quedan fuera del issue.

El armado genera dos entradas JavaScript, una para el servidor y otra para
las herramientas del kit. Incluye Node 24.15.0, las dependencias de producción
del servidor fijadas en el lock de npm y el runtime de Codex 0.168.0
necesario para la agencia, sin el ejecutable de modo código ni los recursos
de voz. Con esto `koffi` mantiene su módulo nativo y Playwright puede
encontrar Edge. El `config.toml` de Bitácora usa rutas absolutas al Node y a la
entrada compilada del kit. `tsx` queda como dependencia de desarrollo.

Tauri abre una sola ventana y arranca el servidor con un puerto que asigna
Windows en `127.0.0.1`. El servidor entrega la pantalla compilada y sus
fuentes, el WebSocket y los archivos registrados desde el mismo origen.
La ventana abre el acceso de ChatGPT en el navegador predeterminado.
Los PDF se ven dentro de la app. Los marcos de vista previa sólo pueden
cargar archivos de la app y se bloquean las ventanas emergentes.
Se mantiene el control de Host y Origin. La cáscara recibe la señal de
arranque por un canal privado del proceso y conoce el origen exacto de su
ventana. El issue #16 puede usar ese punto para entregar una credencial en
memoria antes de que se conecte la pantalla.

La cáscara abre Node sin consola y espera hasta 90 segundos a que el servidor
anuncie su puerto. La ventana abre mientras Codex se prepara y los pedidos
siguen bloqueados hasta que arranque y se compruebe la protección. Si el
servidor se cae, la cáscara lo vuelve a abrir una vez y cambia al puerto nuevo.
Los errores quedan en `%APPDATA%\Bitacora\logs\servidor.log`.
Al cerrar la ventana, el servidor dispone de hasta 2,5 segundos para guardar
y cerrar Codex. Windows termina el árbol de procesos si vence el plazo o se
cierra la cáscara de golpe.

Codex registra el MCP por stdio desde su proceso, fuera de los comandos que
corren bajo el perfil `agencia`. El MCP conserva sus controles sobre la
carpeta de la agencia y sus fuentes. El perfil del agente conserva el bloqueo
de lecturas externas con MXC de DEC-010. Bitácora copia el kit desde los
recursos instalados la primera vez y conserva las rutas de datos existentes
en `%APPDATA%\Bitacora` y de trabajo en `%USERPROFILE%\Bitacora`, separadas
de la instalación y fuera del alcance del desinstalador.
