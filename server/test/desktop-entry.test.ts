import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { on, once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { parse } from "smol-toml";
import { WebSocket } from "ws";
import { screenProtocols, screenSecret } from "./screen-fixture";
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
      // A partial handshake should leave the data dir untouched.
      child.stdin.write(screenSecret.slice(0, 32));
      await delay(300);
      assert.equal(child.exitCode, null, stderr);
      assert.equal(lines.length, 0);
      await assert.rejects(readFile(join(data, "codex", "config.toml")), { code: "ENOENT" });
      const ready = once(stdout, "line", { signal: AbortSignal.timeout(40_000) })
        .then(([line]) => line);
      child.stdin.write(screenSecret.slice(32) + "\n");
      const line = await Promise.race([ready, closed.then(() => { throw new Error(stderr); })]);
      const port = /^BITACORA_READY (\d+)$/.exec(line)?.[1];
      assert.ok(port, line);
      const url = `http://127.0.0.1:${port}/`;
      assert.equal(await (await fetch(url)).text(), "<title>Bitácora</title>");
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, screenProtocols, { origin: new URL(url).origin });
      try {
        for await (const [raw] of on(socket, "message", { signal: AbortSignal.timeout(45_000) })) {
          const message = JSON.parse(String(raw));
          if (message.type === "snapshot" && message.state.engine.available) break;
        }
      } finally {
        socket.terminate();
      }
      child.stdin.end();
      assert.deepEqual(await closed, [0, null], stderr);
      assert.ok(!lines.some((line) => line.includes(screenSecret)));
      assert.ok(!stderr.includes(screenSecret));
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

test("desktop serves while Codex prepares, then saves buffered changes on stdin EOF", async () => {
  const root = await fixture();
  const entry = join(root, "runtime", "server", "index.mjs");
  const web = join(root, "runtime", "web");
  const data = join(root, "datos");
  const workspace = join(root, "agencia");
  const works = join(data, "works.json");
  try {
    await mkdir(web, { recursive: true });
    await mkdir(join(root, "runtime", "kit", "turismo"), { recursive: true });
    await writeFile(join(web, "index.html"), "<title>Bitácora</title>");
    await build({
      entryPoints: ["server/src/index.ts"],
      outfile: entry, platform: "node", format: "esm", bundle: true, packages: "external",
      plugins: [{
        name: "fake-desktop-engine",
        setup(build) {
          build.onResolve({ filter: /^\.\/codex\/engine$/ }, () => ({
            path: "engine", namespace: "fake-desktop",
          }));
          build.onLoad({ filter: /.*/, namespace: "fake-desktop" }, () => ({
            resolveDir: resolve("server/test"),
            contents: `
              import { FakeEngine } from "./fake-engine";
              export class CodexEngine extends FakeEngine {
                async start() {
                  if (process.env.BITACORA_SCREEN_SECRET !== undefined)
                    throw new Error("Screen session leaked into the engine environment");
                  await new Promise(resolve => process.once("message", resolve));
                }
                async send(id, text) {
                  await super.send(id, text);
                  this.emit({ type: "message", conversationId: id, id: "reply", text: "Respuesta parcial", delta: true });
                }
                async close() {
                  await new Promise(resolve => setTimeout(resolve, 900));
                  await super.close();
                  process.send("engine closed");
                }
              }
            `,
          }));
        },
      }],
    });

    const child = spawn(process.execPath, [entry, "--desktop"], {
      env: { ...process.env, BITACORA_DATA_DIR: data, BITACORA_WORKSPACE: workspace },
      stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    const closed = once(child, "close");
    const { stdin, stdout: output, stderr: errors } = child;
    assert.ok(stdin && output && errors);
    let stderr = "";
    errors.on("data", (bytes) => { stderr += bytes; });
    const stdout = createInterface({ input: output });
    try {
      const ready = once(stdout, "line", { signal: AbortSignal.timeout(10_000) });
      stdin.write(screenSecret + "\n");
      const [line] = await Promise.race([ready, closed.then(() => { throw new Error(stderr); })]);
      const port = /^BITACORA_READY (\d+)$/.exec(line)?.[1];
      assert.ok(port, line);
      const origin = `http://127.0.0.1:${port}`;
      assert.equal(await (await fetch(origin)).text(), "<title>Bitácora</title>");
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, screenProtocols, { origin });
      const messages = on(socket, "message", { signal: AbortSignal.timeout(10_000) });
      async function next(type: string, accept = (_message: { state?: { engine: { available: boolean } } }) => true) {
        for (;;) {
          const result = await messages.next();
          assert.ok(!result.done);
          const message = JSON.parse(String(result.value[0]));
          if (message.type === type && accept(message)) return message;
        }
      }
      const send = (text: string) => socket.send(JSON.stringify({ type: "send", text }));
      try {
        const initial = await next("snapshot");
        assert.ok(!JSON.stringify(initial).includes(screenSecret));
        assert.equal(initial.state.engine.available, false);
        assert.equal(initial.state.engine.starting, true);
        send("Pedido antes de que esté lista");
        assert.match((await next("problem")).text, /termine de prepararse/);
        child.send("finish startup");
        const ready = await next("snapshot", (message) => message.state?.engine.available === true);
        assert.deepEqual(ready.state.works, []);
        send("Pedido de prueba");
        assert.equal((await next("message")).text, "Respuesta parcial");
        const before = JSON.parse(await readFile(works, "utf8"));
        assert.equal(before.works[0].busy, true);
        assert.deepEqual(before.works[0].messages.map((message: { text: string }) => message.text), ["Pedido de prueba"]);

        const engineClosed = once(child, "message", { signal: AbortSignal.timeout(2_500) }).then(([message]) => message);
        const exitWithinGrace = once(child, "close", { signal: AbortSignal.timeout(2_500) });
        stdin.end();
        assert.deepEqual(await Promise.all([engineClosed, exitWithinGrace]), ["engine closed", [0, null]], stderr);
        const saved = await readFile(works, "utf8");
        assert.ok(!saved.includes(screenSecret));
        assert.ok(!stderr.includes(screenSecret));
        const after = JSON.parse(saved);
        assert.equal(after.version, 2);
        assert.equal(after.works.length, 1);
        assert.equal(after.works[0].busy, false);
        assert.match(after.works[0].progress, /se detuvo al cerrar/);
        assert.deepEqual(after.works[0].messages.map((message: { text: string }) => message.text), ["Pedido de prueba", "Respuesta parcial"]);
      } finally {
        await messages.return?.();
        socket.terminate();
      }
    } finally {
      stdin.end();
      const kill = setTimeout(() => child.kill(), 5_000);
      try { await closed; } finally { clearTimeout(kill); }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
