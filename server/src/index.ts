import { paths } from "./paths";
import { CodexEngine } from "./codex/engine";
import { serve } from "./server";
const locations = paths();
const server = await serve(
  new CodexEngine({
    home: locations.codexHome,
    workspace: locations.workspace,
    binary: process.env.BITACORA_CODEX_BIN,
  }),
  locations.data,
  Number(process.env.BITACORA_PORT || 4317),
  process.env.BITACORA_WEB_ORIGIN,
  locations.workspace,
);
console.log(`Para entrar a Bitácora, abrí esta dirección antes de dos minutos (sirve una sola vez):\n${server.entryUrl}`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    if (!closing) {
      closing = true;
      void server.close().then(() => process.exit(0));
    }
  });
