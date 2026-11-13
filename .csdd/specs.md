# Specifications

<!--
Record only evidence-backed durable truth. Code and tests may describe behavior
but do not independently establish durable intent. Do not invent requirements,
constraints, invariants, or stable interfaces. Sparse or empty sections are
valid. Add, remove, or rename domain-specific sections when appropriate.
-->

## Project Summary

Bitácora (nombre provisorio) es una app de escritorio de código abierto para que
una persona no técnica, al principio la dueña de una agencia de turismo chica,
arme y use su propio entorno de trabajo con agentes. La inferencia sale de la
suscripción de ChatGPT que la persona ya paga. La app no cobra inferencia ni
pide claves de API.

La primera usuaria es Fer, dueña de 787 Rumbos, que hoy usa Codex sobre el repo
`787-propuestas`.

## Requirements

El MVP está logrado cuando Fer arma una propuesta real en la app, sin Codex y
sin ayuda de Valentín.

- **R1. Conectar la suscripción.** La usuaria conecta su cuenta de ChatGPT con un
  botón, usando el login oficial de Codex. Nunca ve una clave de API.
- **R2. Un solo espacio de trabajo.** Una agencia es un espacio. No hay proyectos
  ni hilos. Cada conversación es un "trabajo" que se titula solo.
- **R3. Conversación sin ruido técnico.** El progreso se muestra en castellano
  simple, en una línea. Comandos, diffs y errores quedan plegados.
- **R4. Sin carteles de permiso.** El agente trabaja libre dentro de la carpeta de
  la agencia y no puede salir de ella. La app guarda copias automáticas y ofrece
  deshacer.
- **R5. Archivos y resultados a la vista.** La usuaria adjunta logo, fotos y
  links. Las imágenes y PDFs que produce el agente aparecen en la conversación,
  con copiar y guardar, y en una galería con todo lo producido.
- **R6. Kit base de turismo.** El espacio de trabajo parte de una base probada:
  traer el texto y las fotos de la página de un operador, controlar cada número
  contra la fuente citando la línea de donde sale, y dibujar a PNG y PDF.
- **R7. Entrevista inicial.** La usuaria le pide al agente que la ayude a empezar
  y el agente arma marca, plantillas y tono conversando con ella. Después puede
  cambiar cualquier cosa hablándole, sin depender del seteo de un tercero.
- **R8. Instalador único.** Un instalador de Windows deja todo andando. La
  usuaria no instala Node, Git, Codex ni un navegador por separado.

## Constraints

- La app corre en la compu de la usuaria. No hay versión hosteada.
- La app es gratuita y de código abierto. La documentación oficial de Codex
  app-server (consultada el 2026-11-13) permite su autenticación en aplicaciones
  locales o de código abierto y dice que nunca estuvo permitida para servicios
  comerciales u hosteados. Cobrar por la app o hostearla exige otra vía (Sign in
  with ChatGPT, con lista de espera para partners).
- Cada usuaria usa su propia cuenta de ChatGPT. La app no comparte ni
  redistribuye credenciales.
- Solo Windows en el MVP.
- Solo ChatGPT/Codex como proveedor en el MVP.
- El público no es programador: nada en la interfaz puede exigir conocer git,
  terminal, archivos de código o permisos.
- No se generan imágenes con IA. Las piezas se dibujan con código.

## Invariants

- El motor de agente queda detrás de una única interfaz, para poder sumar otros
  proveedores sin tocar la UI ni el kit.
- Todo lo que el kit trae armado se puede modificar hablándole al agente.
- Todo número visible en una pieza tiene que estar respaldado por la fuente.

## Interfaces and Contracts

