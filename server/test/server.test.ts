import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { get } from "node:http";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "../src/server";
import { FakeEngine } from "./fake-engine";

test("desktop serves only bundled assets and accepts the window's assigned origin", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/desktop-"));
  const webRoot = join(dir, "web");
  const data = join(dir, "data");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<title>Bitácora</title>");
  await writeFile(join(dir, "private.html"), "private");
  const server = await serve(new FakeEngine(), data, 0, undefined, undefined, {
    webRoot, kitSource: join(dir, "kit"),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /^text\/html/);
    assert.equal(await page.text(), "<title>Bitácora</title>");
    assert.equal((await fetch(origin + "/private.html")).status, 404);
    assert.equal((await fetch(origin + "/files")).status, 403);
    assert.equal((await fetch(origin, { headers: { Origin: "http://127.0.0.1:5173" } })).status, 403);
    const aliasStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(origin, { headers: { Host: `localhost:${server.port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    assert.equal(aliasStatus, 403);

    const url = `ws://127.0.0.1:${server.port}/ws`;
    const socket = new WebSocket(url, { origin });
    const message = await new Promise<string>((resolve, reject) => {
      socket.once("message", (data) => resolve(String(data)));
      socket.once("error", reject);
    });
    assert.equal(JSON.parse(message).type, "snapshot");
    await terminateAndClose(socket);
    const foreign = new WebSocket(url, { origin: "http://127.0.0.1:5173" });
    await assert.rejects(new Promise<void>((resolve, reject) => {
      foreign.once("open", resolve);
      foreign.once("error", reject);
    }));
    await waitForClose(foreign);
  } finally {
    await server.close();
    await rm(dir, { recursive: true });
  }
});

async function waitForClose(ws: WebSocket, timeoutMs = 15000) {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("close", onClose);
      reject(new Error(`WebSocket close timed out after ${timeoutMs}ms (readyState=${ws.readyState})`));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.once("close", onClose);
  });
}

async function terminateAndClose(ws: WebSocket) {
  const closing = waitForClose(ws);
  ws.terminate();
  await closing;
}

test("localhost websocket serves snapshots, connects an account and blocks foreign origins", async (t) => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/ws-"));
  const engine = new FakeEngine();
  engine.connected = false;
  const server = await serve(engine, dir, 0);
  const socketErrors: Error[] = [];
  const socketMessages: string[] = [];
  const waiters: (() => void)[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    origin: "http://127.0.0.1:5173",
  });
  socket.on("error", (err) => {
    socketErrors.push(err);
    for (const wake of waiters.splice(0)) wake();
  });
  socket.on("message", (data) => {
    socketMessages.push(String(data));
    for (const wake of waiters.splice(0)) wake();
  });
  const waitMessage = (predicate: (raw: string) => boolean, label: string, timeoutMs = 15000) =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        if (socketErrors.length) {
          clearTimeout(timer);
          reject(socketErrors[0]);
          return true;
        }
        const match = socketMessages.find(predicate);
        if (match !== undefined) {
          clearTimeout(timer);
          resolve(match);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(onEvent);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      const onEvent = () => {
        if (!check()) waiters.push(onEvent);
      };
      if (!check()) waiters.push(onEvent);
    });
  try {
    await t.test("serves initial snapshot and connects an account", async () => {
      const initial = await waitMessage(() => true, "initial snapshot");
      assert.equal(JSON.parse(initial).state.account.connected, false);
      socket.send(JSON.stringify({ type: "connect" }));
      await waitMessage((raw) => {
        const m = JSON.parse(raw);
        return m.type === "snapshot" && m.state.account.connected === true;
      }, "connected snapshot");
      assert.deepEqual(socketErrors, []);
    });

    await t.test("blocks foreign origins and untrusted hosts", async () => {
      for (const options of [
        {},
        { origin: "https://untrusted.example" },
        {
          origin: "http://127.0.0.1:5173",
          headers: { Host: `wrong.example:${server.port}` },
        },
        { origin: "http://localhost:5174" },
        { origin: "http://localhost.evil:5173" },
      ]) {
        const bad = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, options);
        let opened = false;
        let errored = false;
        bad.on("open", () => {
          opened = true;
          bad.terminate();
        });
        bad.on("error", () => {
          errored = true;
        });
        await waitForClose(bad);
        assert.equal(opened, false, `unexpected open for ${JSON.stringify(options)}`);
        assert.equal(errored, true, `expected upgrade rejection error for ${JSON.stringify(options)}`);
        assert.notEqual(bad.readyState, WebSocket.OPEN);
      }
    });

    await t.test("accepts localhost origin alias and survives abrupt client disconnect", async () => {
      const local = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
        origin: "http://localhost:5173",
        headers: { Host: `localhost:${server.port}` },
      });
      const localErrors: Error[] = [];
      let allowErrors = false;
      local.on("error", (err) => {
        if (!allowErrors) localErrors.push(err);
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for localhost alias open")), 15000);
        const onOpen = () => {
          clearTimeout(timer);
          local.off("error", onError);
          resolve();
        };
        const onError = (err: Error) => {
          clearTimeout(timer);
          local.off("open", onOpen);
          reject(err);
        };
        local.once("open", onOpen);
        local.once("error", onError);
      });
      allowErrors = true;
      await terminateAndClose(local);
      assert.deepEqual(localErrors, []);
      // Give pending nextTick/IO ticks a chance to deliver any server-side socket error.
      await delay(50);
    });

    await t.test("survives malformed client frame and keeps serving new clients", async () => {
      await new Promise<void>((resolve, reject) => {
        const raw = createConnection(server.port, "127.0.0.1");
        const timer = setTimeout(() => {
          raw.destroy();
          reject(new Error("Timed out waiting for malformed frame connection close"));
        }, 15000);
        let upgraded = false;
        let head = "";
        raw.on("error", () => {});
        raw.on("close", () => {
          clearTimeout(timer);
          if (!upgraded) reject(new Error("Connection closed before WebSocket upgrade"));
          else resolve();
        });
        raw.on("data", (chunk) => {
          if (upgraded) return;
          head += chunk.toString("latin1");
          if (head.includes("\r\n\r\n")) {
            assert.match(head, /^HTTP\/1\.1 101 Switching Protocols/);
            upgraded = true;
            // Unmasked client-to-server frame forces ws to emit a server-side 'error' event.
            raw.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
          }
        });
        raw.write(
          [
            "GET /ws HTTP/1.1",
            `Host: 127.0.0.1:${server.port}`,
            "Origin: http://127.0.0.1:5173",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });

      const healthy = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
        origin: "http://127.0.0.1:5173",
      });
      healthy.on("error", () => {});
      try {
        const snapshot = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timed out waiting for snapshot after malformed frame")), 15000);
          healthy.once("message", (data) => {
            clearTimeout(timer);
            resolve(String(data));
          });
          healthy.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        assert.equal(JSON.parse(snapshot).type, "snapshot");
      } finally {
        await terminateAndClose(healthy).catch(() => {});
      }
    });
  } finally {
    await terminateAndClose(socket).catch(() => {});
    await server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
