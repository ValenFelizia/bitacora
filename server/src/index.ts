import { paths, preparePaths } from "./paths";
import { CodexEngine } from "./codex/engine";
import { serve } from "./server";
import { WorkspaceSelection, type WorkspaceChoice } from "./workspace-selection";
import { isScreenSecret } from "./screen-session";
import { dirname, join } from "node:path";
import { protectedWorkspaceFolders } from "./protected-folders";
import { fileURLToPath } from "node:url";

const installed = process.argv.includes("--desktop");
const screenSecret = installed ? await readDesktopSecret() : undefined;

async function readDesktopSecret(): Promise<string> {
  // The shell releases startup only after owning this process tree.
  const line = await new Promise<string | undefined>((resolve) => {
    let input = "";
    const stdin = process.stdin;
    const onEnd = () => {
      stdin.off("data", onData);
      resolve(input === "" ? undefined : "");
    };
    const onData = (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (input.length < 65 && !input.includes("\n")) return;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      resolve(input.endsWith("\n") ? input.slice(0, -1) : "");
    };
    stdin.once("end", onEnd);
    stdin.on("data", onData);
  });
  if (line === undefined) process.exit(0);
  if (!isScreenSecret(line)) throw new Error("Missing or invalid desktop screen session");
  return line;
}
const runtime = fileURLToPath(new URL("../", import.meta.url));
const locations = await preparePaths(paths());
const desktop = installed ? {
  webRoot: join(runtime, "web"),
  kitSource: join(runtime, "kit", "turismo"),
} : undefined;
const configuredBinary = installed ? join(runtime, "codex", "bin", "codex.exe") : process.env.BITACORA_CODEX_BIN;
let binary = configuredBinary;
if (!binary) {
  try { binary = (await import("../../scripts/codex-runtime.mjs")).codexBinary(); }
  catch { /* The engine reports an unavailable binary on start. */ }
}
const appPaths = [installed ? runtime : fileURLToPath(new URL(".", import.meta.url))];
if (installed && process.env.BITACORA_INSTALL_DIR) appPaths.push(process.env.BITACORA_INSTALL_DIR);
if (binary) appPaths.push(dirname(binary));
const selection = new WorkspaceSelection(locations.workspace, locations.data, protectedWorkspaceFolders(appPaths));
// Only a configuration error can put the default folder here; a saved folder
// that cannot open falls back to the default instead of closing the app.
await selection.refuseProtected(locations.workspace);
const { choice, notice } = await selection.load();
const engineFor = (folder: WorkspaceChoice) => new CodexEngine({
  home: locations.codexHome,
  workspace: folder.root,
  workspaceData: folder.data,
  binary,
  verifyWorkspaceProtection: true,
  mcpEntry: installed ? join(runtime, "server", "mcp.mjs") : undefined,
});
const server = await serve(
  engineFor(choice),
  locations.data,
  installed ? 0 : Number(process.env.BITACORA_PORT || 4317),
  installed ? undefined : process.env.BITACORA_WEB_ORIGIN,
  choice.root,
  desktop,
  screenSecret,
  { selection, initial: choice, notice, engineFor },
);
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  void server.close().then(() => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => close());
if (installed) {
  process.stdin.once("end", close);
  if (process.stdin.readableEnded) {
    close();
  } else {
    console.log(`BITACORA_READY ${server.port}`);
    try {
      await server.startEngine();
      // The shell tells a first-start failure from a lost connection by this line.
      if (!closing) console.log("BITACORA_STARTED");
    } catch (error) {
      if (!closing) {
        console.error(error);
        close(1);
      }
    }
  }
} else console.log(`Bitácora lista en 127.0.0.1:${server.port}`);
