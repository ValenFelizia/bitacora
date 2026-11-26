# Cómo colaborar en Bitácora

Bitácora es un proyecto de código abierto. Estas reglas están para que cualquier persona o agente que entre al repo encuentre los mismos títulos, las mismas labels y el mismo flujo de trabajo. No hace falta permiso especial para proponer un cambio: se abre un issue o un pull request y se sigue este documento.

## La regla de los títulos

Todo título de issue, pull request y commit tiene esta forma:

```text
tipo: descripción en castellano
```

El tipo va en inglés, en minúsculas, pegado a los dos puntos y con un espacio después. La descripción va en castellano rioplatense, simple y sin términos técnicos de más. No usamos ámbitos, es decir, no escribimos `feat(ui): ...` sino `feat: ...`.

Si el cambio rompe algo que antes funcionaba, se agrega `!` antes de los dos puntos, por ejemplo `fix!: ...`, y se explica en el cuerpo qué cambia para quien usaba la versión anterior.

Ejemplo: `feat: Plantillas reutilizables en Bitácora`.

### Tipos

| Tipo | Cuándo se usa |
| --- | --- |
| `feat` | Una función nueva. |
| `fix` | Un arreglo de algo que no funcionaba. |
| `docs` | Documentación y textos del proyecto. |
| `refactor` | Cambio de estructura sin cambiar lo que hace. |
| `test` | Pruebas nuevas o ajustadas. |
| `chore` | Mantenimiento, seguimiento y decisiones. |
| `build` | Empaquetado, instalador y dependencias. |
| `ci` | Automatizaciones y flujo de trabajo. |
| `perf` | Mejoras de rendimiento. |
| `revert` | Volver atrás un cambio. |

## Issues

El título sigue la regla de arriba. El cuerpo lleva estas partes, en este orden:

- **Qué.** Qué hay que hacer.
- **Por qué.** Para qué sirve.
- **Listo cuando.** Cómo se comprueba que terminó.
- **Depende de.** Otros issues, si los hay.

Cada issue lleva una label de tipo y una de área. Los issues de producto van en uno de los dos milestones: **MVP** o **Después del MVP**. Las mejoras del propio repo pueden quedar sin milestone.

Los issues cerrados no se retitulan. Su título es parte del historial.

## Ramas

El nombre sigue este patrón:

```text
issue-<número>-<slug>
```

Por ejemplo, `issue-93-convenciones`. El slug va en minúsculas, con guiones y corto. La rama se crea desde `main` y se nombra igual que el issue que atiende.

## Pull requests

El título sigue la regla general y lleva el número del issue al final:

```text
feat: Plantillas reutilizables en Bitácora (#90)
```

Cada PR vincula su issue con la línea `Closes #90` en el cuerpo. GitHub cierra el issue al mergear solo con palabras clave en inglés, por eso esa línea no se traduce.

El cuerpo lleva estas partes:

- **Por qué.** Qué problema resuelve.
- **Qué cambió.** Qué hace ahora y qué dejó de hacer.
- **Verificación.** Cómo se comprobó, con los comandos y las pruebas que se corrieron.
- **Closes #número**.
- Casilleros para las dos revisiones esperadas: la de Macroscope, que revisa al abrir el PR, y la del consejo, dos modelos de familias distintas que revisan el último commit. Cada comentario se responde con arreglado, ya cubierto o por qué no aplica.

Antes de abrir el PR, corré `npm run typecheck`, `npm test` y `npm run build` cuando corresponda. Si el cambio no toca código, lo decís en **Verificación**.

Los PRs se mergean por *squash*. El título del PR pasa a ser el mensaje del commit en `main`, así que conviene escribirlo bien desde el principio.

## Commits

El mensaje de commit usa la misma regla que el título. Como se mergea por squash, normalmente no hay que escribirlo a mano: Bitácora lo toma del título del PR. Si hacés commits directos en una rama, usá `tipo: descripción` también.

No hace falta reescribir los commits ni los títulos cerrados que existían antes de estas reglas.

## Labels

Cada issue y PR abierto lleva una label de tipo y una de área. Las labels por defecto de GitHub quedan sin usar.

### Tipo

| Label | Se usa para |
| --- | --- |
| `tipo: función` | Cambios `feat`. |
| `tipo: falla` | Cambios `fix`. |
| `tipo: tarea` | Cambios `chore`, `test`, `refactor`, `build`, `ci`, `perf` y `revert`. |
| `tipo: documentación` | Cambios `docs`. |

### Área

| Label | Se usa para |
| --- | --- |
| `área: interfaz` | Pantalla, textos y experiencia de uso. |
| `área: servidor` | Servidor, motor, espacio de trabajo y entorno de Codex. |
| `área: kit` | Kit de turismo y sus herramientas. |
| `área: instalador` | Instalador, actualizaciones y ventana de escritorio. |
| `área: pruebas` | Pruebas automáticas y verificaciones. |
| `área: proyecto` | Flujo de trabajo, seguimiento y decisiones del repo. |
