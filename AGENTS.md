# Instrucciones para agentes

Antes de trabajar leé `.csdd/specs.md` (qué tiene que hacer el MVP) y
`.csdd/decisions.md` (por qué está armado así). No los contradigas: si una tarea
choca con ellos, frená y avisá.

- Antes de crear un issue, una rama o un PR, leé `CONTRIBUTING.md` y seguí sus
  convenciones de títulos, labels y nombres.
- La lista de trabajo son los issues de GitHub del milestone "MVP". Trabajá
  sobre el issue que te asignaron y no amplíes el alcance.
- No inventes requisitos ni decisiones, y no edites `.csdd/` salvo que la tarea
  lo pida.
- La usuaria final no es programadora. Todo texto que ella vea va en castellano
  rioplatense, simple y sin términos técnicos.
- Código y nombres de archivos en inglés. Issues, documentación y mensajes de
  commit en castellano rioplatense, con el prefijo del tipo en inglés, según
  `CONTRIBUTING.md`.
  Excepción: el contenido de `kit/` se copia a la carpeta de la agencia, donde
  lo lee la usuaria; sus nombres de archivos y carpetas van en castellano
  (`marca/`, `plantillas/`, `fuentes/`, `.agents/skills/entrevista/`).
- Solo Windows. Leé y escribí archivos en UTF-8.
- Las APIs de Codex y Tauri cambian seguido: verificá en la documentación
  oficial o en el binario instalado antes de asumir cómo funcionan.
- Antes de mergear un PR se esperan dos revisiones: la de Macroscope (bot de GitHub, revisa al abrir el PR) y la del consejo, dos modelos de familias distintas que revisan el último commit. Cada comentario se responde (arreglado, ya cubierto, o por qué no aplica). Leé los comentarios de Macroscope con `gh api repos/ValenFelizia/bitacora/pulls/<n>/comments`.
