import type { ExecutionSafety } from "../../server/src/engine";
export function protectionText(safety: ExecutionSafety): string {
  if (safety.issue) return {
    check: "No pude comprobar la protección. Tocá Reintentar para volver a comprobarla.",
    setup: safety.needsPermission ? "No pude terminar la preparación. Si cancelaste el permiso, podés reintentar." : "No pude terminar la preparación. Podés reintentar.",
    uncertain: "Windows todavía no confirmó si terminó. Esperá a que cierre el cartel de permiso. Con Reintentar voy a comprobar cómo quedó.",
    interrupted: "Se interrumpió la preparación y todavía no está lista. Podés reintentar.",
    restart: "No pude volver a arrancar el motor después de preparar la protección.",
  }[safety.issue];
  return safety.status === "preparing" ? "Preparando todo…" : "Hasta que esté lista, no se pueden enviar pedidos.";
}
