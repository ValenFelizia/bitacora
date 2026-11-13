import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { App } from "../src/app";
import { FakeEngine } from "./fake-engine";
import { classifyProblem } from "../src/codex/engine";
import { paths } from "../src/paths";
import type { ServerMessage } from "../src/contracts";
import { EngineFailure } from "../src/engine";

async function fixture() {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/test-"));
  const engine = new FakeEngine();
  const messages: ServerMessage[] = [];
  const app = new App(engine, dir, (m) => messages.push(m));
  await app.start();
  return {
    dir,
    engine,
    app,
    messages,
    reply: (m: ServerMessage) => {
      messages.push(m);
    },
  };
}

test("a work survives restart with transcript and continues the same conversation", async () => {
  const f = await fixture();
  try {
    await f.app.command(
      { type: "send", text: "Armemos una propuesta" },
      f.reply,
    );
    const work = f.app.snapshot().works[0];
    assert.equal(work.title, "Armemos una propuesta");
    assert.equal(work.progress, "Leyendo los archivos…");
    f.engine.emit({
      type: "message",
      conversationId: "conversation-1",
      id: "a",
      text: "Hola ",
      delta: true,
    });
    f.engine.emit({
      type: "message",
      conversationId: "conversation-1",
      id: "a",
      text: "Fer",
      delta: true,
    });
    f.engine.emit({
      type: "message",
      conversationId: "conversation-1",
      id: "a",
      text: "Hola Fer.",
      delta: false,
    });
    f.engine.emit({
      type: "detail",
      conversationId: "conversation-1",
      text: "a command and its output",
    });
    f.engine.emit({
      type: "finished",
      conversationId: "conversation-1",
      status: "completed",
    });
    await f.app.close();
    const engine = new FakeEngine();
    const restarted = new App(engine, f.dir, f.reply);
    await restarted.start();
    assert.equal(restarted.snapshot().works[0].messages[1].text, "Hola Fer.");
    assert.equal(restarted.snapshot().works[0].busy, false);
    await restarted.command(
      { type: "send", workId: work.id, text: "Sigamos" },
      f.reply,
    );
    assert.deepEqual(engine.resumed, ["conversation-1"]);
    assert.deepEqual(engine.sent, ["Sigamos"]);
    assert.equal(restarted.snapshot().works.length, 1);
    assert.equal(restarted.snapshot().works[0].messages.length, 3);
    assert.equal("conversationId" in restarted.snapshot().works[0], false);
    await restarted.close();
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("interrupt, automatic titles, quota and account problems are normalized", async () => {
  const f = await fixture();
  try {
    await f.app.command({ type: "send", text: "Un trabajo" }, f.reply);
    const id = f.app.snapshot().works[0].id;
    f.engine.emit({
      type: "title",
      conversationId: "conversation-1",
      title: "Propuesta a Brasil",
    });
    f.engine.emit({
      type: "problem",
      conversationId: "conversation-1",
      kind: "limit",
      detail: "usageLimitExceeded",
    });
    assert.match(f.app.snapshot().works[0].problem!, /límite de tu plan/);
    await f.app.command({ type: "interrupt", workId: id }, f.reply);
    assert.equal(f.app.snapshot().works[0].busy, false);
    assert.equal(f.app.snapshot().works[0].title, "Propuesta a Brasil");
    f.engine.connected = false;
    await f.app.command({ type: "send", workId: id, text: "Otro" }, f.reply);
    assert.equal(f.engine.sent.length, 1);
    assert.ok(
      f.messages.some(
        (m) => m.type === "problem" && m.text.includes("desconectada"),
      ),
    );
    for (const [code, kind] of [
      ["usageLimitExceeded", "limit"],
      ["unauthorized", "disconnected"],
      ["rateLimitExceeded", "temporary"],
      ["sandboxError", "other"],
    ])
      assert.equal(classifyProblem({ codexErrorInfo: code }), kind);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("concurrent sends never start duplicate turns and empty requests are rejected", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.app.command({ type: "send", text: "  " }, f.reply));
    await Promise.all([
      f.app.command({ type: "send", text: "Primero" }, f.reply),
      f.app.command({ type: "send", text: "Segundo" }, f.reply),
    ]);
    assert.equal(f.engine.sent.length, 1);
    assert.equal(f.app.snapshot().works.length, 1);
    await f.app.command({ type: "send", text: "Tercero" }, f.reply);
    assert.equal(f.engine.sent.length, 1);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("restart marks unfinished work as stopped and corrupt JSON is never overwritten", async () => {
  const f = await fixture();
  try {
    await f.app.command({ type: "send", text: "Pendiente" }, f.reply);
    await f.app.close();
    const restart = new App(new FakeEngine(), f.dir, f.reply);
    await restart.start();
    assert.equal(restart.snapshot().works[0].busy, false);
    assert.match(restart.snapshot().works[0].progress, /se detuvo/);
    await restart.close();
    await writeFile(join(f.dir, "works.json"), "bad json");
    await assert.rejects(new App(new FakeEngine(), f.dir, f.reply).start());
    assert.equal(await readFile(join(f.dir, "works.json"), "utf8"), "bad json");
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("workspace and engine data cannot overlap", () => {
  assert.throws(() =>
    paths({
      BITACORA_DATA_DIR: "C:/agency/data",
      BITACORA_WORKSPACE: "C:/agency",
    }),
  );
  const p = paths({ APPDATA: "C:/roaming" });
  assert.equal(p.codexHome, join(resolve("C:/roaming/Bitacora"), "codex"));
});

test("an ambiguous send failure stays saved, clears busy state and is never retried", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.engine.send = async () => {
      calls++;
      throw new EngineFailure("disconnected", "unauthorized");
    };
    await assert.rejects(
      f.app.command({ type: "send", text: "Guardá este pedido" }, f.reply),
    );
    assert.equal(calls, 1);
    const work = f.app.snapshot().works[0];
    assert.equal(work.busy, false);
    assert.equal(work.messages[0].text, "Guardá este pedido");
    assert.match(work.problem!, /desconectada/);
    assert.equal(f.app.snapshot().account.connected, false);
    await f.app.close();
    assert.match(
      await readFile(join(f.dir, "works.json"), "utf8"),
      /Guardá este pedido/,
    );
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});
