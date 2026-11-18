import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { parse } from "smol-toml";
import { codexBinary } from "../../scripts/codex-runtime.mjs";
import { registerKit } from "../src/codex/kit";

async function fixture() {
  await mkdir(".local", { recursive: true });
  return mkdtemp(resolve(".local/desktop-entry-"));
}

test("registers the installed MCP entry with the current Node executable", async () => {
  const home = await fixture();
  try {
    const workspace = join(home, "agencia");
    const entry = join(home, "Bitácora", "runtime", "server", "mcp.mjs");
    await registerKit(home, workspace, entry);
    const config = parse(await readFile(join(home, "config.toml"), "utf8"));
    assert.partialDeepStrictEqual(config, {
      mcp_servers: {
        bitacora: {
          command: process.execPath,
          args: [entry, workspace, join(dirname(home), "allowed-urls.json")],
        },
      },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("desktop entry waits for stdin, announces its port, and closes on EOF", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await fixture();
  const runtime = join(root, "runtime");
  const entry = join(runtime, "server", "index.mjs");
  const version = join(runtime, "server", "src", "codex", "VERSION");
  const web = join(runtime, "web");
  const data = join(root, "datos");
  const workspace = join(root, "agencia");
  const env = { ...process.env, BITACORA_DATA_DIR: data, BITACORA_WORKSPACE: workspace };
  try {
    await mkdir(dirname(version), { recursive: true });
    await mkdir(web, { recursive: true });
    await mkdir(join(runtime, "kit", "turismo"), { recursive: true });
    await copyFile("server/src/codex/VERSION", version);
    await writeFile(join(web, "index.html"), "<title>Bitácora</title>");
    await symlink(dirname(dirname(codexBinary())), join(runtime, "codex"), "junction");
    await build({
      entryPoints: ["server/src/index.ts"],
      outfile: entry, platform: "node", format: "esm", bundle: true, packages: "external",
    });

    const child = spawn(process.execPath, [entry, "--desktop"], { env, windowsHide: true });
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    const stdout = createInterface({ input: child.stdout });
    const lines: string[] = [];
    stdout.on("line", (line) => lines.push(line));
    try {
      // Starting without the shell's handshake should leave the data dir untouched.
      await delay(300);
      assert.equal(child.exitCode, null, stderr);
      assert.deepEqual(lines, []);
      await assert.rejects(readFile(join(data, "codex", "config.toml")), { code: "ENOENT" });
      const ready = once(stdout, "line", { signal: AbortSignal.timeout(40_000) })
        .then(([line]) => line);
      child.stdin.write("\n");
      const line = await Promise.race([ready, closed.then(() => { throw new Error(stderr); })]);
      const port = /^BITACORA_READY (\d+)$/.exec(line)?.[1];
      assert.ok(port, line);
      const url = `http://127.0.0.1:${port}/`;
      assert.equal(await (await fetch(url)).text(), "<title>Bitácora</title>");
      child.stdin.end();
      assert.deepEqual(await closed, [0, null], stderr);
      await assert.rejects(fetch(url));
    } finally {
      child.stdin.end();
      const kill = setTimeout(() => child.kill(), 5_000);
      try { await closed; } finally { clearTimeout(kill); }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
