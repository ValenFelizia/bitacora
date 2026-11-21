import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { get } from "node:http";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "../src/server";
import { FakeEngine } from "./fake-engine";
import { DEV_SESSION_PATH, SCREEN_PROTOCOL } from "../src/screen-session";
import { screenProtocols, screenSecret } from "./screen-fixture";

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
  }, screenSecret);
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
    const socket = new WebSocket(url, screenProtocols, { origin });
    const message = await new Promise<string>((resolve, reject) => {
      socket.once("message", (data) => resolve(String(data)));
      socket.once("error", reject);
    });
    assert.equal(JSON.parse(message).type, "snapshot");
    assert.ok(!message.includes(screenSecret));
    assert.equal(socket.protocol, SCREEN_PROTOCOL);
    await terminateAndClose(socket);

    const dev = await fetch(origin + DEV_SESSION_PATH, { method: "POST", headers: { Origin: origin } });
    assert.equal(dev.status, 404);
    assert.equal(await dev.text(), "");
    for (const [protocols, claimedOrigin] of [
      [[], origin],
      [[SCREEN_PROTOCOL, "0".repeat(64)], origin],
      [[SCREEN_PROTOCOL, screenSecret.slice(1)], origin],
      [[SCREEN_PROTOCOL, screenSecret.toUpperCase()], origin],
      [[screenSecret], origin],
      [[screenSecret, SCREEN_PROTOCOL], origin],
      [[SCREEN_PROTOCOL, screenSecret, "extra"], origin],
      [screenProtocols, "http://127.0.0.1:5173"],
    ] as const) {
      const denied = new WebSocket(url, [...protocols], { origin: claimedOrigin });
      await assert.rejects(new Promise<void>((resolve, reject) => {
        denied.once("open", () => {
          denied.terminate();
          resolve();
        });
        denied.once("error", reject);
      }));
      await waitForClose(denied);

      const healthy = new WebSocket(url, screenProtocols, { origin });
      try {
        const [data] = await once(healthy, "message", { signal: AbortSignal.timeout(15_000) });
        assert.equal(JSON.parse(String(data)).type, "snapshot");
        assert.equal(healthy.protocol, SCREEN_PROTOCOL);
      } finally {
        await terminateAndClose(healthy);
      }
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true });
  }
});

test("development bootstrap issues the server's credential to the Vite origin", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/dev-session-"));
  const server = await serve(new FakeEngine(), dir, 0);
  const base = `http://127.0.0.1:${server.port}`;
  const origin = "http://localhost:5173";
  try {
    const request = (origin?: string) => fetch(base + DEV_SESSION_PATH, {
      method: "POST", headers: origin ? { Origin: origin } : {},
    });
    assert.equal((await request()).status, 403);
    assert.equal((await request("https://untrusted.example")).status, 403);
    const response = await request(origin);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const secret = await response.text();
    assert.match(secret, /^[0-9a-f]{64}$/);
    const socket = new WebSocket(base.replace("http:", "ws:") + "/ws", [SCREEN_PROTOCOL, secret], { origin });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
    } finally {
      await terminateAndClose(socket);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("markOpened WebSocket command requires the screen secret and broadcasts openedAt", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/mark-opened-ws-"));
  await writeFile(join(dir, "works.json"), JSON.stringify({
    version: 2,
    works: [{
      id: "w-1",
      conversationId: "conv-1",
      title: "Prueba",
      createdAt: "2026-11-20T10:00:00.000Z",
      updatedAt: "2026-11-20T10:00:00.000Z",
      details: "",
      busy: false,
      progress: "Listo.",
      messages: [{
        id: "m-1",
        role: "assistant",
        text: "Placa",
        results: [{ id: "res-1", path: "pieza-1.png", name: "pieza-1.png", mime: "image/png", createdAt: "2026-11-20T10:00:00.000Z" }],
      }],
    }],
  }));
  const origin = "http://127.0.0.1:5173";
  const server = await serve(new FakeEngine(), dir, 0, origin, undefined, undefined, screenSecret);
  const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  try {
    // Without the screen secret, WebSocket connections (and thus markOpened) are rejected.
    const unauth = new WebSocket(wsUrl, [SCREEN_PROTOCOL, "0".repeat(64)], { origin });
    await assert.rejects(new Promise<void>((resolve, reject) => {
      unauth.once("open", () => { unauth.terminate(); resolve(); });
      unauth.once("error", reject);
    }));
    await waitForClose(unauth);

    const authed = new WebSocket(wsUrl, screenProtocols, { origin });
    try {
      const [initialRaw] = await once(authed, "message", { signal: AbortSignal.timeout(10_000) });
      const initial = JSON.parse(String(initialRaw));
      assert.equal(initial.state.works[0].messages[0].results[0].openedAt, undefined);

      authed.send(JSON.stringify({ type: "markOpened", fileIds: ["res-1"] }));
      const [updatedRaw] = await once(authed, "message", { signal: AbortSignal.timeout(10_000) });
      const updated = JSON.parse(String(updatedRaw));
      assert.ok(updated.state.works[0].messages[0].results[0].openedAt);
    } finally {
      await terminateAndClose(authed);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup uses the reported account while Codex is being replaced", async () => {
  class ReplacingEngine extends FakeEngine {
    override async start() {
      this.emit({ type: "account", account: { connected: true } });
    }
    override async account(): Promise<never> {
      throw new Error("Codex is being replaced");
    }
  }

  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/account-"));
  try {
    const server = await serve(new ReplacingEngine(), dir, 0);
    try {
      assert.equal(server.app.snapshot().account.connected, true);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
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
  const server = await serve(engine, dir, 0, undefined, undefined, undefined, screenSecret);
  const socketErrors: Error[] = [];
  const socketMessages: string[] = [];
  const waiters: (() => void)[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, screenProtocols, {
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
        const bad = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, screenProtocols, options);
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
      const local = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, screenProtocols, {
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
            `Sec-WebSocket-Protocol: ${screenProtocols.join(", ")}`,
            "",
            "",
          ].join("\r\n"),
        );
      });

      const healthy = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, screenProtocols, {
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
