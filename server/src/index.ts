import { paths, preparePaths } from "./paths";
import { CodexEngine } from "./codex/engine";
import { serve } from "./server";
import { initializeKit } from './tools/kit';
const locations = await preparePaths(paths());
await initializeKit(locations.workspace,locations.data);
const server = await serve(
  new CodexEngine({
    home: locations.codexHome,
    workspace: locations.workspace,
    binary: process.env.BITACORA_CODEX_BIN,
  }),
  locations.data,
  Number(process.env.BITACORA_PORT || 4317),
  process.env.BITACORA_WEB_ORIGIN,
);
console.log(`Bitácora lista en 127.0.0.1:${server.port}`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    if (!closing) {
      closing = true;
      void server.close().then(() => process.exit(0));
    }
  });
