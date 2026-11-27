import assert from "node:assert/strict";
import { on, once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { ServerMessage } from "../src/contracts";
import { serve } from "../src/server";
import { Templates } from "../src/templates";
import { WorkspaceSelection, type WorkspaceChoice } from "../src/workspace-selection";
import { FakeEngine } from "./fake-engine";
import { screenHeaders, screenProtocols, screenSecret } from "./screen-fixture";

const origin = "http://127.0.0.1:5173";

class GatedTemplates extends Templates {
  static entered: (() => void) | undefined;
  static release: (() => void) | undefined;
  override async previewHtml() {
    GatedTemplates.entered?.();
    await new Promise<void>(resolve => { GatedTemplates.release = resolve; });
    return Buffer.from("vista");
  }
}

test("a template preview counts as work in progress and blocks a folder change", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await realpath(await mkdtemp(resolve(".local/preview-")));
  const home = join(dir, "default");
  const other = join(dir, "otra");
  const data = join(dir, "datos");
  await Promise.all([home, other, data].map(path => mkdir(path)));
  const selection = new WorkspaceSelection(home, data);
  const initial = selection.defaultChoice;
  const engineFor = (_choice: WorkspaceChoice) => new FakeEngine();
  const server = await serve(
    engineFor(initial), data, 0, origin, home, undefined, screenSecret,
    { selection, initial, engineFor }, undefined, files => new GatedTemplates(files),
  );
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, screenProtocols, { origin });
  const messages = on(socket, "message", { signal: AbortSignal.timeout(20_000) });
  async function nextChoice() {
    for (;;) {
      const result = await messages.next();
      assert.ok(!result.done);
      const message = JSON.parse(String(result.value[0])) as ServerMessage;
      if (message.type === "workspaceChoice") return message;
    }
  }
  const send = (workspace: string, path: string) =>
    socket.send(JSON.stringify({ type: "chooseWorkspace", path, workspace }));
  const entered = new Promise<void>(resolve => { GatedTemplates.entered = resolve; });
  const preview = fetch(
    `http://127.0.0.1:${server.port}/templates?` + new URLSearchParams({
      workspace: home, id: "x", version: "y", file: "modelo.html", preview: "1",
    }),
    { headers: screenHeaders },
  );
  try {
    await once(socket, "open");
    await entered;
    send(home, other);
    assert.match((await nextChoice()).problem ?? "", /termine el pedido actual/);
    GatedTemplates.release?.();
    const response = await preview;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "vista");
    send(home, other);
    const moved = await nextChoice();
    assert.equal(moved.problem, undefined);
  } finally {
    GatedTemplates.release?.();
    GatedTemplates.entered = undefined;
    GatedTemplates.release = undefined;
    const disconnected = once(socket, "close");
    socket.terminate();
    await disconnected;
    await messages.return?.();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a template preview waits while a request or an update is in progress", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await realpath(await mkdtemp(resolve(".local/preview-busy-")));
  const home = join(dir, "default");
  const data = join(dir, "datos");
  await Promise.all([home, data].map(path => mkdir(path)));
  const selection = new WorkspaceSelection(home, data);
  const initial = selection.defaultChoice;
  const engine = new FakeEngine();
  const server = await serve(
    engine, data, 0, origin, home, undefined, screenSecret,
    { selection, initial, engineFor: () => engine },
  );
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, screenProtocols, { origin });
  const messages = on(socket, "message", { signal: AbortSignal.timeout(20_000) });
  const preview = () => fetch(
    `http://127.0.0.1:${server.port}/templates?` + new URLSearchParams({
      workspace: home, id: "x", version: "y", file: "modelo.html", preview: "1",
    }),
    { headers: screenHeaders },
  );
  async function snapshot(accept: (state: Extract<ServerMessage, { type: "snapshot" }>["state"]) => boolean) {
    for (;;) {
      const result = await messages.next();
      assert.ok(!result.done);
      const message = JSON.parse(String(result.value[0])) as ServerMessage;
      if (message.type === "snapshot" && accept(message.state)) return message.state;
    }
  }
  try {
    await once(socket, "open");
    assert.equal(server.beginUpdate(), true);
    const updating = await preview();
    assert.equal(updating.status, 409);
    const updatingBody = await updating.json() as { error: string };
    assert.match(updatingBody.error, /termine lo que está en curso para ver la plantilla/);
    server.cancelUpdate();
    socket.send(JSON.stringify({ type: "send", text: "Armá una pieza", workspace: home }));
    const state = await snapshot(item => item.works.some(work => work.busy));
    const busy = await preview();
    assert.equal(busy.status, 409);
    const busyBody = await busy.json() as { error: string };
    assert.match(busyBody.error, /termine lo que está en curso para ver la plantilla/);
    socket.send(JSON.stringify({ type: "interrupt", workId: state.works.find(work => work.busy)?.id, workspace: home }));
    await snapshot(item => !item.works.some(work => work.busy));
  } finally {
    const disconnected = once(socket, "close");
    socket.terminate();
    await disconnected;
    await messages.return?.();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class SlowAdd extends Templates {
  static entered: (() => void) | undefined;
  static release: (() => void) | undefined;
  override async add(...args: Parameters<Templates["add"]>) {
    SlowAdd.entered?.();
    await new Promise<void>(resolve => { SlowAdd.release = resolve; });
    return super.add(...args);
  }
}

test("a template preview waits while the catalogue is being written", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await realpath(await mkdtemp(resolve(".local/preview-write-")));
  const home = join(dir, "default");
  const data = join(dir, "datos");
  await Promise.all([home, data].map(path => mkdir(path)));
  const selection = new WorkspaceSelection(home, data);
  const initial = selection.defaultChoice;
  const engine = new FakeEngine();
  const server = await serve(
    engine, data, 0, origin, home, undefined, screenSecret,
    { selection, initial, engineFor: () => engine }, undefined, files => new SlowAdd(files),
  );
  const entered = new Promise<void>(resolve => { SlowAdd.entered = resolve; });
  const write = fetch(
    `http://127.0.0.1:${server.port}/templates?` + new URLSearchParams({ workspace: home }),
    {
      method: "POST",
      headers: { ...screenHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "add",
        name: "Cotización",
        purpose: "Viajes",
        file: { name: "modelo.txt", data: Buffer.from("hola").toString("base64") },
      }),
    },
  );
  try {
    await entered;
    const preview = await fetch(
      `http://127.0.0.1:${server.port}/templates?` + new URLSearchParams({
        workspace: home, id: "x", version: "y", file: "modelo.html", preview: "1",
      }),
      { headers: screenHeaders },
    );
    assert.equal(preview.status, 409);
    const body = await preview.json() as { error: string };
    assert.match(body.error, /termine lo que está en curso para ver la plantilla/);
    SlowAdd.release?.();
    const saved = await write;
    assert.equal(saved.status, 200);
  } finally {
    SlowAdd.release?.();
    SlowAdd.entered = undefined;
    SlowAdd.release = undefined;
    await write.catch(() => undefined);
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
