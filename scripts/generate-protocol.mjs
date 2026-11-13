import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const home = resolve(".local/generator-codex");
mkdirSync(home, { recursive: true });
const options = {
  env: { ...process.env, CODEX_HOME: home },
  encoding: "utf8",
  windowsHide: true,
};
const binary = process.env.BITACORA_CODEX_BIN || "codex";
const version = execFileSync(binary, ["--version"], options).trim();
if (version !== "codex-cli 0.168.0")
  throw new Error(`Se requiere codex-cli 0.168.0; instalado: ${version}`);
execFileSync(
  binary,
  ["app-server", "generate-ts", "--out", "server/src/codex/generated"],
  options,
);
writeFileSync("server/src/codex/VERSION", version + "\n");
