import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
export const codexVersion = readFileSync(new URL("../server/src/codex/VERSION", import.meta.url), "utf8").trim();
export function codexBinary() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Bitacora requires Windows x64 or arm64");
  const target = process.arch === "x64" ? "x86_64" : "aarch64";
  for (const pkg of [`@openai/codex-win32-${process.arch}`, "@openai/codex"]) {
    let manifest;
    try { manifest = require.resolve(`${pkg}/package.json`); }
    catch (error) { if (error.code === "MODULE_NOT_FOUND") continue; throw error; }
    const binary = join(dirname(manifest), "vendor", `${target}-pc-windows-msvc`, "bin", "codex.exe");
    if (existsSync(binary)) return binary;
  }
  throw new Error("No encontré la versión de Codex que necesita Bitácora. Volvé a instalar la app.");
}
