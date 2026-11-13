import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { serve } from "../src/server";
import { FakeEngine } from "./fake-engine";

test("localhost websocket serves snapshots, connects an account and blocks foreign origins", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/ws-"));
  const engine = new FakeEngine();
  engine.connected = false;
  const server = await serve(engine, dir, 0);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    origin: "http://127.0.0.1:5173",
  });
  try {
    const initial = await new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(String(data))),
    );
    assert.equal(JSON.parse(initial).state.account.connected, false);
    const loggedIn = new Promise<void>((resolve) =>
      socket.on("message", (data) => {
        const m = JSON.parse(String(data));
        if (m.type === "snapshot" && m.state.account.connected) resolve();
      }),
    );
    socket.send(JSON.stringify({ type: "connect" }));
    await loggedIn;
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
      await new Promise<void>((resolve) => bad.once("error", () => resolve()));
      assert.notEqual(bad.readyState, WebSocket.OPEN);
    }
    const local = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      origin: "http://localhost:5173",
      headers: { Host: `localhost:${server.port}` },
    });
    await new Promise<void>((resolve, reject) => {
      local.once("open", () => resolve());
      local.once("error", reject);
    });
    local.terminate();
  } finally {
    socket.terminate();
    await server.close();
    await rm(dir, { recursive: true });
  }
});
