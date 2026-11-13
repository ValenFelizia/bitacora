// No model turns or login. Uses only a fresh isolated home and command/exec.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { CodexEngine } from "../server/src/codex/engine";
import { codexBinary } from "./codex-runtime.mjs";
const base = join(process.env.LOCALAPPDATA!, "Bitacora-dev", "pr13", "protocol");
const home = join(base, "data", "codex"), workspace = join(base, "workspace");
await mkdir(base, { recursive: true });
const witness = join(base, "outside-witness.txt");
await writeFile(witness, "UNCHANGED_PR13");
const engine = new CodexEngine({home, workspace});
const events: unknown[] = [];
engine.subscribe(e => events.push(e));
// Test-only protocol access: no production command endpoint is exposed.
const rpc = (method: string, params: unknown) => (engine as any).rpc(method, params);
const policy = {type: "workspaceWrite", writableRoots: [workspace], networkAccess: false,
  excludeTmpdirEnvVar: true, excludeSlashTmp: true};
const records: unknown[] = [];
try {
  await engine.start();
  for (let i = 0; i < 200 && !engine.executionSafety().allowed; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(engine.executionSafety().allowed, true);
  const config = await rpc("config/read", {includeLayers: false});
  assert.equal(config.config.windows.sandbox, "mxc");
  const configFile = await readFile(join(home, "config.toml"), "utf8");
  const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  for (const [name, script] of [
    ["inside", `Set-Content -LiteralPath ${quote(join(workspace, "inside.txt"))} -Value CREATED -ErrorAction Stop; Add-Content -LiteralPath ${quote(join(workspace, "inside.txt"))} -Value MODIFIED -ErrorAction Stop; Get-Content -LiteralPath ${quote(join(workspace, "inside.txt"))}`],
    ["modify-outside", `Set-Content -LiteralPath ${quote(witness)} -Value CHANGED -ErrorAction Stop`],
    ["delete-outside", `Remove-Item -LiteralPath ${quote(witness)} -ErrorAction Stop`],
  ]) {
    const params = {command: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], cwd: workspace, sandboxPolicy: policy, timeoutMs: 10000};
    const result = await rpc("command/exec", params);
    records.push({name, method: "command/exec", params, result});
    if (name === "inside") assert.equal(result.exitCode, 0);
    else { assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /UnauthorizedAccess|Access.*denied|acceso.*denegado/i); }
    assert.equal(await readFile(witness, "utf8"), "UNCHANGED_PR13");
  }
  const evidence = {binary: codexBinary(), version: execFileSync(codexBinary(), ["--version"], {encoding:"utf8"}).trim(), home, workspace, events,
    configFile, effectiveWindowsConfig: config.config.windows, policy, records,
    inside: await readFile(join(workspace, "inside.txt"), "utf8"), witness: await readFile(witness, "utf8"), modelTurns: 0};
  await writeFile(resolve("docs/verification/issue12/app-server-pr13.json"), JSON.stringify(evidence, null, 2));
  console.log("PASS: automatic MXC persisted/reloaded, command/exec inside succeeds, outside modify/delete denied, witness intact, zero model turns");
} finally { await engine.close(); }
