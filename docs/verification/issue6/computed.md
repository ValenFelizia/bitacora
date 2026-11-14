# Visibilidad según estilos computados

Base 20149b5. `computed-red.txt` conserva las fallas anteriores: hidden vuelto
visible por CSS, script/noscript visibles, pseudo-elemento visible bajo dueño
hidden y pseudo-elementos con display:none o visibility:hidden propios.

4c5c97b elimina los dos filtros por atributos/nombres de etiqueta. El recorrido
ya no se limita a body: parte de documentElement y aplica solamente display:none
computado del elemento o sus ancestros y visibility computada del elemento del
texto. No incorpora exclusiones por geometría u opacidad.

El recorrido generado no usa la visibility del dueño para descartar sus pseudos:
cada before/after/marker consulta su propio display, visibility y content. El
dueño o ancestros solo lo excluyen por display:none. Se eliminó el marcador
sintético redundante: las listas numéricas ya se rechazan antes de inspeccionar.
Se mantienen los rechazos de construcciones no inspeccionables, incluido head
visible, contadores, shadow DOM, SVG con texto y los paneles/formularios.

No se modificaron el kit, las fotos, la UI ni el motor. Sin dependencias nuevas,
turnos de modelo ni verificaciones manuales largas. Se conserva la falla temporal
preexistente de codex.test.ts:286 en `computed-timing-failure.txt`, sin editar ese
test. Los demás registros muestran las verificaciones de esta ronda.

Se conservó además `computed-mcp-failure.txt`: una corrida terminó 113/114 por
cierre de conexión MCP en la integración. La repetición aislada de kit-merge pasó
2/2 y la repetición completa pasó; no se determinó la causa ni se cambió código
ajeno a la visibilidad. `computed-tests-1.txt` y `computed-tests-2.txt` terminaron
114/114 cada una; typecheck y build aprobados. La revisión automática del último
commit se solicita después de responder ambos hilos; no se mergea.
