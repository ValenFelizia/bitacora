import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
export const codexVersion = readFileSync(new URL("../server/src/codex/VERSION", import.meta.url), "utf8").trim();
export function codexBinary() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Bitacora requires Windows x64 or arm64");
  const root = dirname(require.resolve("@openai/codex/package.json"));
  let vendor = join(root, "vendor");
  try { vendor = join(dirname(require.resolve(`@openai/codex-win32-${process.arch}/package.json`)), "vendor"); } catch {}
  const binary = join(vendor, `${process.arch === "x64" ? "x86_64" : "aarch64"}-pc-windows-msvc`, "bin", "codex.exe");
  if (!existsSync(binary)) throw new Error("Missing pinned Codex binary. Run npm install.");
  return binary;
}
