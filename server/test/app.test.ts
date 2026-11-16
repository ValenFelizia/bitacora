import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
  mkdir,
  rename,
  copyFile,
} from "node:fs/promises";
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

test("restart marks unfinished work as stopped and quarantines corrupt JSON", async () => {
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
    const recovered = new App(new FakeEngine(), f.dir, f.reply);
    await recovered.start();
    assert.equal(recovered.snapshot().works.length, 0);
    assert.ok(recovered.snapshot().notice);
    const corrupt = (await readdir(f.dir)).find((n) =>
      n.startsWith("works.corrupt-"),
    )!;
    assert.equal(await readFile(join(f.dir, corrupt), "utf8"), "bad json");
    await recovered.command({ type: "send", text: "Recovered" }, f.reply);
    await recovered.close();
    assert.match(
      await readFile(join(f.dir, "works.json"), "utf8"),
      /Recovered/,
    );
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("failed persistence does not poison the next write", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, "works.json.tmp"));
    await assert.rejects(
      f.app.command({ type: "send", text: "First" }, f.reply),
    );
    await rm(join(f.dir, "works.json.tmp"), { recursive: true });
    await f.app.command({ type: "send", text: "Second" }, f.reply);
    await f.app.close();
    assert.match(await readFile(join(f.dir, "works.json"), "utf8"), /Second/);
    assert.ok(f.messages.some((m) => m.type === "problem"));
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("fragments publish incremental messages and persist at completion", async () => {
  const f = await fixture();
  try {
    await f.app.command({ type: "send", text: "Start" }, f.reply);
    const before = await readFile(join(f.dir, "works.json"), "utf8");
    f.messages.length = 0;
    for (let i = 0; i < 50; i++)
      f.engine.emit({
        type: "message",
        conversationId: "conversation-1",
        id: "a",
        text: "x",
        delta: true,
      });
    assert.equal(f.messages.length, 50);
    assert.ok(f.messages.every((m) => m.type === "message"));
    assert.equal(await readFile(join(f.dir, "works.json"), "utf8"), before);
    f.engine.emit({
      type: "finished",
      conversationId: "conversation-1",
      status: "completed",
    });
    await f.app.close();
    assert.match(
      await readFile(join(f.dir, "works.json"), "utf8"),
      /xxxxxxxxxx/,
    );
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("engine restart releases busy work and clears resumed conversations", async () => {
  const f = await fixture();
  try {
    await f.app.command({ type: "send", text: "Start" }, f.reply);
    const id = f.app.snapshot().works[0].id;
    f.engine.emit({
      type: "availability",
      available: false,
      safety: f.engine.executionSafety(),
    });
    assert.equal(f.app.snapshot().account.connected, false);
    assert.equal(f.app.snapshot().works[0].busy, false);
    await f.app.command({ type: "send", workId: id, text: "Blocked" }, f.reply);
    assert.equal(f.engine.sent.length, 1);
    f.engine.emit({
      type: "availability",
      available: true,
      safety: f.engine.executionSafety(),
    });
    await f.app.command(
      { type: "send", workId: id, text: "Continue" },
      f.reply,
    );
    assert.deepEqual(f.engine.resumed, ["conversation-1"]);
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

test("app rejects unsafe sends even when the fake engine would accept them", async () => {

  const f = await fixture();

  try {

    f.engine.safe = false;

    await f.app.command({ type: "send", text: "Blocked" }, f.reply);

    assert.equal(f.engine.sent.length, 0);

    assert.equal(f.engine.count, 0);

    assert.equal(f.app.snapshot().works.length, 0);

    assert.ok(f.messages.some(m => m.type === "problem" && m.text.includes("No puedo enviar pedidos")));

  } finally { await f.app.close(); await rm(f.dir, { recursive: true }); }

});



test("a refused read block stops the work with a plain message", async () => {

  const f = await fixture();

  try {

    f.engine.executionSafety = () => ({ allowed: false, status: "failed", issue: "readBlock", detail: "permissionProfile/list does not offer agencia" });

    await f.app.command({ type: "send", text: "Armá una propuesta" }, f.reply);

    assert.equal(f.engine.sent.length, 0);

    assert.equal(f.app.snapshot().works.length, 0);

    const problem = f.messages.find(m => m.type === "problem");

    assert.ok(problem && problem.type === "problem");

    assert.match(problem.text, /bloqueo que impide leer archivos fuera de tu carpeta/);

    assert.match(problem.text, /Reintentar/);

    assert.doesNotMatch(problem.text, /permissionProfile|sandbox|API/);

    assert.match(problem.detail || "", /permissionProfile\/list/);

  } finally { await f.app.close(); await rm(f.dir, { recursive: true }); }

});



test("persistence retries EPERM once or twice before succeeding", async () => {

  for (const failures of [1, 2]) {

    const f = await fixture();

    await f.app.close();

    let calls = 0;

    const app = new App(f.engine, f.dir, f.reply, { copyFile, rename: async (from, to) => {

      if (++calls <= failures) throw Object.assign(new Error("busy"), { code: "EPERM" });

      await rename(from, to);

    } });

    try {

      await app.start();

      await app.command({ type: "send", text: "Saved after retry" }, f.reply);

      assert.equal(calls, failures + 1);

      assert.match(await readFile(join(f.dir, "works.json"), "utf8"), /Saved after retry/);

    } finally { await app.close(); await rm(f.dir, { recursive: true }); }

  }

});



test("corrupt quarantine retries then copies, and still starts if copying also fails", async () => {

  for (const copyFails of [false, true]) {

    const f = await fixture();

    await f.app.close();

    await writeFile(join(f.dir, "works.json"), "broken");

    let calls = 0;

    const app = new App(f.engine, f.dir, f.reply, {

      rename: async () => { calls++; throw Object.assign(new Error("locked"), { code: "EBUSY" }); },

      copyFile: async (from, to) => { if (copyFails) throw new Error("locked"); await copyFile(from, to); },

    });

    try {

      await app.start();

      assert.equal(calls, 4);

      assert.equal(app.snapshot().works.length, 0);

      assert.ok(app.snapshot().notice);

      if (!copyFails) {

        const name = (await readdir(f.dir)).find(n => n.startsWith("works.corrupt-"))!;

        assert.equal(await readFile(join(f.dir, name), "utf8"), "broken");

      }

    } finally { await app.close(); await rm(f.dir, { recursive: true }); }

  }

});



test("a pause requested before the request reaches the engine stops the turn once it starts", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/pause-"));
  const engine = new FakeEngine();
  const messages: ServerMessage[] = [];
  const reply = (m: ServerMessage) => { messages.push(m); };
  // Hold the save so the pause arrives while the request is still in the app.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const app = new App(engine, dir, reply, {
    rename: async (from, to) => { await held; await rename(from, to); },
    copyFile,
  });
  try {
    await app.start();
    const sending = app.command({ type: "send", text: "Un pedido" }, reply);
    let work = app.snapshot().works[0];
    for (let i = 0; i < 200 && !work?.busy; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      work = app.snapshot().works[0];
    }
    assert.ok(work?.busy, "the request never reached the commit point");
    await app.command({ type: "interrupt", workId: work.id }, reply);
    release();
    await sending;
    // The pause must reach the engine after the request, never before it.
    assert.deepEqual(engine.calls, ["send:conversation-1", "interrupt:conversation-1"]);
    assert.equal(app.snapshot().works[0].progress, "Trabajo pausado.");
  } finally {
    release();
    await app.close();
    await rm(dir, { recursive: true });
  }
});

test("a failed save stays pending and is retried before closing", async () => {
  const f = await fixture();
  try {
    await f.app.command({ type: "send", text: "Guardá esto" }, f.reply);
    // The disk refuses the next save.
    await mkdir(join(f.dir, "works.json.tmp"));
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    for (let i = 0; i < 200 && !f.messages.some((m) => m.type === "problem"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(f.messages.some((m) => m.type === "problem" && /No pude guardar/.test(m.text)));
    // The disk works again: closing must save the last response.
    await rm(join(f.dir, "works.json.tmp"), { recursive: true });
    await f.app.close();
    const saved = await readFile(join(f.dir, "works.json"), "utf8");
    assert.match(saved, /"busy": false/);
    assert.match(saved, /Listo\./);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("a saved work with a damaged message is quarantined instead of blanking the page", async () => {
  const f = await fixture();
  try {
    await f.app.command({ type: "send", text: "Un trabajo" }, f.reply);
    await f.app.close();
    const saved = JSON.parse(await readFile(join(f.dir, "works.json"), "utf8"));
    saved.works[0].messages = [null];
    await writeFile(join(f.dir, "works.json"), JSON.stringify(saved));
    const app = new App(new FakeEngine(), f.dir, f.reply);
    try {
      await app.start();
      assert.equal(app.snapshot().works.length, 0);
      assert.ok(app.snapshot().notice);
      assert.ok((await readdir(f.dir)).some((n) => n.startsWith("works.corrupt-")));
    } finally {
      await app.close();
    }
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("connecting while protection is being prepared asks to wait", async () => {
  const f = await fixture();
  try {
    f.engine.executionSafety = () => ({ allowed: false, status: "preparing", detail: "" });
    f.engine.connectAccount = async () => { throw new Error("a login must not start"); };
    await f.app.command({ type: "connect" }, f.reply);
    assert.ok(f.messages.some((m) => m.type === "problem" && /preparando la protección/.test(m.text)));
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("final flush includes events delivered during engine shutdown", async () => {

  const f = await fixture();

  try {

    await f.app.command({ type: "send", text: "Start" }, f.reply);

    f.engine.close = async () => {

      await new Promise(resolve => setTimeout(resolve, 10));

      f.engine.emit({ type: "message", conversationId: "conversation-1", id: "last", text: "Last fragment", delta: true });

    };

    await f.app.close();

    assert.match(await readFile(join(f.dir, "works.json"), "utf8"), /Last fragment/);

    assert.equal(f.engine.listeners.size, 0);

  } finally { await f.app.close(); await rm(f.dir, { recursive: true }); }

});
