import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { codexBinary, codexVersion } from "./codex-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const stage = join(root, ".local", "installer-dependencies");
const payload = join(root, "src-tauri", "payload");
const npm = process.env.npm_execpath;
const nodeVersion = "24.15.0";
const hashes = {
  x64: "3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5",
  arm64: "49a54c103f4919ce64199a043ef5cd309507de491d718085edee089cd8e87543",
};
const hash = hashes[process.arch];
if (process.platform !== "win32" || !hash || !npm)
  throw new Error("Run npm run build:installer with native Windows x64 or arm64 tools.");

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
  await pipeline(response.body, createWriteStream(destination));
}

const cache = join(root, ".local", `node-${nodeVersion}-${process.arch}`);
await mkdir(cache, { recursive: true });
const node = join(cache, "node.exe");
if (await sha256(node).catch(() => "") !== hash) {
  if (await sha256(process.execPath) === hash) await copyFile(process.execPath, node);
  else await download(`https://nodejs.org/dist/v${nodeVersion}/win-${process.arch}/node.exe`, node);
  if (await sha256(node) !== hash) throw new Error("Unexpected SHA-256 for Node.js");
}
const nodeLicense = join(cache, "NODE-LICENSE.txt");
await download(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`, nodeLicense);

const codex = codexBinary();
const actualVersion = execFileSync(codex, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
if (actualVersion !== codexVersion) throw new Error(`Expected ${codexVersion}, got ${actualVersion}`);

// Install the server workspace from the repository lock. npm ci resets its
// dependency tree. The workspace link lives only in this temporary directory.
for (const path of ["package.json", "package-lock.json", "server/package.json", "web/package.json"]) {
  await mkdir(dirname(join(stage, path)), { recursive: true });
  await copyFile(join(root, path), join(stage, path));
}
execFileSync(process.execPath, [
  npm, "ci", "--workspace=server", "--include-workspace-root=false", "--omit=dev", "--no-audit", "--no-fund",
], { cwd: stage, stdio: "inherit" });

await rm(payload, { recursive: true, force: true });
await mkdir(payload, { recursive: true });
const runtime = join(payload, "runtime");
await mkdir(runtime, { recursive: true });
await Promise.all([
  copyFile(node, join(runtime, "node.exe")),
  copyFile(nodeLicense, join(runtime, "NODE-LICENSE.txt")),
  cp(dirname(dirname(codex)), join(runtime, "codex"), { recursive: true }),
  cp(join(root, "kit", "turismo"), join(runtime, "kit", "turismo"), { recursive: true }),
  cp(join(root, "web", "dist"), join(runtime, "web"), { recursive: true }),
  cp(join(stage, "node_modules"), join(runtime, "node_modules"), {
    recursive: true,
    filter: (path) => ![".bin", ".package-lock.json", "@bitacora"].includes(basename(path)),
  }),
  mkdir(join(runtime, "server", "src", "codex"), { recursive: true }),
  mkdir(join(runtime, "scripts"), { recursive: true }),
]);
await copyFile(join(root, "server", "src", "codex", "VERSION"), join(runtime, "server", "src", "codex", "VERSION"));
await copyFile(join(root, "scripts", "codex-runtime.mjs"), join(runtime, "scripts", "codex-runtime.mjs"));
await build({
  absWorkingDir: root,
  entryPoints: { index: "server/src/index.ts", mcp: "server/src/tools/mcp.ts" },
  outdir: join(runtime, "server"),
  outExtension: { ".js": ".mjs" },
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  packages: "external",
  plugins: [{
    name: "codex-runtime-path",
    setup(build) {
      build.onResolve({ filter: /\/scripts\/codex-runtime\.mjs$/ }, () => ({
        path: "../scripts/codex-runtime.mjs",
        external: true,
      }));
    },
  }],
});

await download(`https://raw.githubusercontent.com/openai/codex/rust-v${codexVersion.split(" ")[1]}/LICENSE`,
  join(runtime, "codex", "LICENSE"));
const fontLicenses = join(runtime, "licenses");
await mkdir(fontLicenses);
for (const font of ["atkinson-hyperlegible", "young-serif"]) {
  await copyFile(join(root, "node_modules", "@fontsource", font, "LICENSE"), join(fontLicenses, `${font}.txt`));
}
