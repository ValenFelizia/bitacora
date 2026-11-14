# Integración del kit con Deshacer

Merge sin reescribir historia: `db90926`, padres `f44551d` y `c00d29e`.

Conflictos resueltos:

- `app.ts`: registrar links del texto original antes de enviar al motor, conservar
  el contexto de archivos deshechos separado del texto y su acuse posterior.
- `main.tsx`: conservar la protección de links http/https del kit y las claves
  con revisión de archivos para refrescar conversación y galería tras Deshacer.
- README: conservar ambas funciones y quitar afirmaciones obsoletas sobre lo que
  aún no estaba implementado.

Sin conflicto textual, `workspace-files.ts` excluía `ejemplo/` y
`fotos/operador/` de todo el recorrido. Se limita esa exclusión a los resultados;
las copias incluyen ambos. La misma clasificación se aplica a `isResult`, porque
el recorrido compartido alimenta también la detección de resultados.
`engine.ts` y `codex/engine.ts` conservan registro/progreso del kit y contexto de
Deshacer; no se introducen detalles de Codex fuera de su adaptador.

Pruebas nuevas (`server/test/kit-undo.test.ts`):

- Edición de `AGENTS.md` y `ejemplo/pieza.html`: se restaura la copia inicial.
- Temporales que desaparecen y guardas que aparecen durante la captura: no se
  incluyen ni invalidan la copia; la guarda permanece intacta después de Deshacer.
- Marca del kit y lista de links en datos: se conservan byte por byte tras
  Deshacer, tres copias posteriores, purga elegible y limpieza de objetos.
- App con motor falso y MCP real en proceso separado: `traer` obtiene una página
  y foto de un servidor local de prueba en puerto propio asignado por el sistema;
  `dibujar` usa Edge real. Ambos trabajan dentro del mismo pedido.
- La foto del operador no aparece como resultado; PNG/PDF/miniatura sí. Deshacer
  retira fuente, foto y salidas a la papelera. La conversación marca los resultados
  revertidos y el siguiente pedido recibe el aviso separado del mensaje de usuario.
- Se cuentan exactamente dos recorridos antes/después del pedido, y cuatro al
  completar el siguiente, sin recorrer aparte para copias y resultados.

`npm install`, typecheck y build: PASS. Dos corridas de npm test: 184 pruebas,
183 aprobadas, una omitida (enlace simbólico de archivo sin permiso disponible),
cero fallas. Las junctions y el MCP con Edge reales sí corren.
Las salidas completas se conservan en `main-integration-tests-1.txt` y
`main-integration-tests-2.txt`. Para las corridas completas, LOCALAPPDATA apunta a
una carpeta sintética dentro de `.local/`: los tests heredados del kit no dejan
nuevos datos fuera del repo ni tocan la instancia de la usuaria. No se usan los
puertos 5173/4317, no se solicita inferencia y no se modifica la configuración personal.

Quedó `.local/test-localappdata-kit-undo/` dentro del repo: la revisión automática
rechazó su borrado (`blocked by policy`), incluso con la ruta absoluta verificada.
No se dejaron procesos propios ni datos nuevos fuera del repo.
