import type { ExecutionSafety } from "../../server/src/engine";
export function protectionText(safety: ExecutionSafety): string {
  if (safety.issue) return {
    check: "No pude comprobar la protección. Tocá Reintentar para volver a comprobarla.",
    setup: safety.needsPermission ? "No pude terminar la preparación. Si cancelaste el permiso, podés reintentar." : "No pude terminar la preparación. Podés reintentar.",
    uncertain: "Windows todavía no confirmó si terminó. Esperá a que cierre el cartel de permiso. Con Reintentar voy a comprobar cómo quedó.",
    interrupted: "Se interrumpió la preparación y todavía no está lista. Podés reintentar.",
    restart: "No pude volver a arrancar el motor después de preparar la protección.",
    readBlock: "No pude activar el bloqueo que impide leer archivos fuera de tu carpeta. Sin eso no puedo empezar tus pedidos. Tocá Reintentar para volver a intentarlo.",
  }[safety.issue];
  return safety.status === "preparing" ? "Preparando todo…" : "Hasta que esté lista, no se pueden enviar pedidos.";
}
/**
 * What this computer cannot protect, in plain words. Empty when the agent
 * cannot read outside the folder. It is a warning, not a failure: the work is
 * allowed with the write protection the app always had.
 */
export function protectionWarning(safety: ExecutionSafety): string {
  return safety.readBlock === false
    ? "En esta compu no puedo impedir que el agente lea archivos fuera de tu carpeta. Igual no puede cambiarlos ni borrarlos."
    : "";
}
