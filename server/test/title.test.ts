import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { App } from "../src/app";
import { CodexEngine } from "../src/codex/engine";
import { cleanTitle, fallbackTitle, MAX_TITLE } from "../src/titles";
import type { EngineEvent } from "../src/engine";
import type { ServerMessage } from "../src/contracts";
import { FakeEngine } from "./fake-engine";
import { fakeAppServerArgs } from "./fake-app-server";

test("a title is the first line, without quotes, prefixes or trailing dots", () => {
  assert.equal(cleanTitle("Porto de Galinhas, febrero"), "Porto de Galinhas, febrero");
  assert.equal(cleanTitle("  Título: «Porto de Galinhas, febrero».  "), "Porto de Galinhas, febrero");
  assert.equal(cleanTitle("**Nombre:** Propuesta a Brasil\n\nExplicación"), "Propuesta a Brasil");
  assert.equal(cleanTitle('"Porto de Galinhas"'), "Porto de Galinhas");
  assert.equal(cleanTitle("   "), undefined);
  assert.equal(cleanTitle(null), undefined);
  assert.equal(cleanTitle("Título:"), undefined);
});

test("a long title is cut at a word boundary", () => {
  const source = "Propuesta de viaje a Porto de Galinhas para febrero con todo incluido";
  const long = cleanTitle(source);
  assert.ok(long);
  assert.ok(long.length <= MAX_TITLE);
  assert.equal(long, long.trim());
  assert.match(long, /^Propuesta de viaje a Porto de Galinhas para febrero/);
  // The cut never leaves half a word behind.
  assert.ok(source.startsWith(long));
});

test("the fallback name is the start of the first request", () => {
  assert.equal(fallbackTitle("  Armemos   una propuesta  "), "Armemos una propuesta");
  assert.equal(fallbackTitle("x".repeat(100)).length, MAX_TITLE);
});

test("the fallback name fits the rename limit", () => {
  // A name the app pre-fills must be accepted by the rename command as is.
  assert.equal(fallbackTitle("x".repeat(100)).length, MAX_TITLE);
  const words = fallbackTitle("Armame una propuesta de viaje a Porto de Galinhas para febrero con todo incluido");
  assert.ok(words.length <= MAX_TITLE);
  assert.ok(words.length > 0);
  assert.equal(words, words.trim());
});

async function appFixture() {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/title-"));
  const engine = new FakeEngine();
  const messages: ServerMessage[] = [];
  const app = new App(engine, dir, (m) => messages.push(m));
  await app.start();
  return {
    dir,
    engine,
    app,
    messages,
    reply: (m: ServerMessage) => { messages.push(m); },
  };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("condition timed out");
}

test("the first finished request gets a short name and the engine keeps it", async () => {
  const f = await appFixture();
  try {
    f.engine.suggested = "Porto de Galinhas, febrero";
    await f.app.command(
      { type: "send", text: "Armame una propuesta para Porto de Galinhas en febrero" },
      f.reply,
    );
    const work = f.app.snapshot().works[0];
    // Until the first request ends, the work keeps the start of the request.
    assert.match(work.title, /^Armame una propuesta/);
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await until(() => f.app.snapshot().works[0].title === "Porto de Galinhas, febrero");
    assert.deepEqual(f.engine.renamed, [
      { conversationId: "conversation-1", title: "Porto de Galinhas, febrero" },
    ]);
    assert.match(f.app.snapshot().works[0].details, /Título automático: 1200 de entrada \(1000 en caché\), 8 de salida/);
    await f.app.close();
    const restarted = new App(new FakeEngine(), f.dir, f.reply);
    await restarted.start();
    assert.equal(restarted.snapshot().works[0].title, "Porto de Galinhas, febrero");
    await restarted.close();
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("a work paused before it was titled is titled after a restart", async () => {
  const f = await appFixture();
  try {
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "interrupted" });
    // The pending flag travels with the work, never in the snapshot.
    assert.equal("titlePending" in f.app.snapshot().works[0], false);
    await f.app.close();
    const engine = new FakeEngine();
    engine.suggested = "Porto de Galinhas, febrero";
    const restarted = new App(engine, f.dir, f.reply);
    await restarted.start();
    engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await until(() => restarted.snapshot().works[0].title === "Porto de Galinhas, febrero");
    await restarted.close();
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("saving the temporary name while the sample is in flight keeps it", async () => {
  const f = await appFixture();
  try {
    f.engine.suggested = "Porto de Galinhas, febrero";
    let release!: () => void;
    f.engine.titleGate = new Promise<void>((resolve) => { release = resolve; });
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    const work = f.app.snapshot().works[0];
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await until(() => f.engine.calls.includes("title:conversation-1"));
    // The user opens the name and saves the same temporary one.
    await f.app.command({ type: "rename", workId: work.id, title: work.title }, f.reply);
    release();
    await delay(20);
    assert.equal(f.app.snapshot().works[0].title, work.title);
    assert.equal(f.engine.renamed.at(-1)?.title, work.title);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("a sample that could not run leaves the work pending for the next start", async () => {
  const f = await appFixture();
  try {
    f.engine.suggested = "Porto de Galinhas, febrero";
    f.engine.titleFails = true;
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await until(() => f.engine.calls.includes("title:conversation-1"));
    await delay(20);
    assert.match(f.app.snapshot().works[0].title, /^Armame una propuesta/);
    await f.app.close();
    const engine = new FakeEngine();
    engine.suggested = "Porto de Galinhas, febrero";
    const restarted = new App(engine, f.dir, f.reply);
    await restarted.start();
    engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await until(() => restarted.snapshot().works[0].title === "Porto de Galinhas, febrero");
    await restarted.close();
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("a sample with no usable text does not ask again", async () => {
  const f = await appFixture();
  try {
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await until(() => f.engine.calls.includes("title:conversation-1"));
    await delay(20);
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await delay(30);
    assert.equal(f.engine.calls.filter((call) => call === "title:conversation-1").length, 1);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("a send that fails before it starts keeps an existing work pending", async () => {
  const f = await appFixture();
  try {
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "interrupted" });
    await f.app.close();
    // After a restart the work is still pending, and its conversation is
    // resumed on the next request: that resume fails before the send commits.
    const engine = new FakeEngine();
    engine.suggested = "Porto de Galinhas, febrero";
    const restarted = new App(engine, f.dir, f.reply);
    await restarted.start();
    const id = restarted.snapshot().works[0].id;
    engine.resumeFails = true;
    await assert.rejects(restarted.command({ type: "send", workId: id, text: "Seguí" }, f.reply));
    engine.resumeFails = false;
    engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await until(() => restarted.snapshot().works[0].title === "Porto de Galinhas, febrero");
    await restarted.close();
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("a name the engine refuses is saved in the detail", async () => {
  const f = await appFixture();
  try {
    f.engine.suggested = "Porto de Galinhas, febrero";
    f.engine.renameFails = true;
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await until(() => f.app.snapshot().works[0].title === "Porto de Galinhas, febrero");
    await delay(100);
    const saved = JSON.parse(await readFile(join(f.dir, "works.json"), "utf8"));
    assert.match(saved.works[0].details, /No pude guardar el título en la sesión/);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("a name the user chose survives a restart and later engine titles", async () => {
  const f = await appFixture();
  try {
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    const id = f.app.snapshot().works[0].id;
    await f.app.command({ type: "rename", workId: id, title: "Brasil, febrero" }, f.reply);
    await f.app.close();
    const engine = new FakeEngine();
    const restarted = new App(engine, f.dir, f.reply);
    await restarted.start();
    // The engine can still report a name of its own after a restart; the one
    // the user chose is the one that stays.
    engine.emit({ type: "title", conversationId: "conversation-1", title: "Porto de Galinhas, febrero" });
    assert.equal(restarted.snapshot().works[0].title, "Brasil, febrero");
    await restarted.close();
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("a name the user chooses wins over the automatic one", async () => {
  const f = await appFixture();
  try {
    f.engine.suggested = "Porto de Galinhas, febrero";
    let release!: () => void;
    f.engine.titleGate = new Promise<void>((resolve) => { release = resolve; });
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    const id = f.app.snapshot().works[0].id;
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await until(() => f.engine.calls.includes("title:conversation-1"));
    await f.app.command({ type: "rename", workId: id, title: "  Brasil,   febrero " }, f.reply);
    assert.equal(f.app.snapshot().works[0].title, "Brasil, febrero");
    release();
    await delay(20);
    assert.equal(f.app.snapshot().works[0].title, "Brasil, febrero");
    assert.equal(f.engine.renamed.at(-1)?.title, "Brasil, febrero");
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("a name chosen before the request ends skips the automatic one", async () => {
  const f = await appFixture();
  try {
    f.engine.suggested = "Porto de Galinhas, febrero";
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    const id = f.app.snapshot().works[0].id;
    await f.app.command({ type: "rename", workId: id, title: "Brasil" }, f.reply);
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await delay(20);
    assert.equal(f.app.snapshot().works[0].title, "Brasil");
    assert.equal(f.engine.calls.includes("title:conversation-1"), false);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("an empty or too long name is refused and the old one stays", async () => {
  const f = await appFixture();
  try {
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    const id = f.app.snapshot().works[0].id;
    for (const title of ["   ", "x".repeat(MAX_TITLE + 1)]) {
      await f.app.command({ type: "rename", workId: id, title }, f.reply);
      assert.match(f.app.snapshot().works[0].title, /^Armame una propuesta/);
    }
    assert.ok(f.messages.some((m) => m.type === "problem" && m.text.includes("hasta 60 letras")));
    assert.equal(f.engine.renamed.length, 0);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

test("a request that fails or is paused keeps the fallback name and spends no extra call", async () => {
  const f = await appFixture();
  try {
    f.engine.suggested = "Porto de Galinhas, febrero";
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    for (const status of ["failed", "interrupted"] as const) {
      f.engine.emit({ type: "finished", conversationId: "conversation-1", status });
      await delay(20);
      assert.match(f.app.snapshot().works[0].title, /^Armame una propuesta/);
    }
    assert.equal(f.engine.calls.includes("title:conversation-1"), false);
    // The next request that does finish titles the work.
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await until(() => f.app.snapshot().works[0].title === "Porto de Galinhas, febrero");
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true });
  }
});

async function engineFixture() {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/title-engine-"));
  const log = join(dir, "protocol.jsonl");
  process.env.BITACORA_FAKE_LOG = log;
  const engine = new CodexEngine({
    home: join(dir, "home"),
    workspace: join(dir, "workspace"),
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  const records = async () =>
    (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return {
    engine,
    events,
    records,
    close: async () => {
      try {
        await engine.close();
      } finally {
        delete process.env.BITACORA_FAKE_LOG;
        delete process.env.BITACORA_FAKE_SAMPLE;
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  };
}

test("a finished turn is titled by a sample of that same turn", async () => {
  process.env.BITACORA_FAKE_SAMPLE = "Porto de Galinhas, febrero";
  const f = await engineFixture();
  try {
    const { conversationId } = await f.engine.createWork();
    await f.engine.send(conversationId, "race");
    await until(() => f.events.some((e) => e.type === "finished"));
    const suggestion = await f.engine.suggestTitle(conversationId);
    assert.deepEqual(suggestion, {
      title: "Porto de Galinhas, febrero",
      usage: { input: 1200, cached: 1000, output: 12 },
    });
    const sample = (await f.records()).find((m) => m.method === "thread/sample");
    assert.equal(sample.params.threadId, conversationId);
    assert.equal(sample.params.expectedTurnId, "turn-1");
    assert.equal(sample.params.disableMcp, true);
    assert.match(sample.params.prompt, /título corto/);
  } finally {
    await f.close();
  }
});

test("a sample that only produced a tool call leaves no name", async () => {
  process.env.BITACORA_FAKE_SAMPLE = "none";
  const f = await engineFixture();
  try {
    const { conversationId } = await f.engine.createWork();
    await f.engine.send(conversationId, "race");
    await until(() => f.events.some((e) => e.type === "finished"));
    assert.equal(await f.engine.suggestTitle(conversationId), undefined);
  } finally {
    await f.close();
  }
});

test("a source that is still closing is sampled once more", async () => {
  process.env.BITACORA_FAKE_SAMPLE = "idle";
  const f = await engineFixture();
  try {
    const { conversationId } = await f.engine.createWork();
    await f.engine.send(conversationId, "race");
    await until(() => f.events.some((e) => e.type === "finished"));
    assert.equal((await f.engine.suggestTitle(conversationId))?.title, "Porto de Galinhas, febrero");
    assert.equal((await f.records()).filter((m) => m.method === "thread/sample").length, 2);
  } finally {
    await f.close();
  }
});

test("no sample is asked before a request finished", async () => {
  const f = await engineFixture();
  try {
    const { conversationId } = await f.engine.createWork();
    // No finished turn yet: the sample cannot run, so the work must stay
    // pending instead of being marked as answered.
    await assert.rejects(f.engine.suggestTitle(conversationId));
    assert.equal((await f.records()).filter((m) => m.method === "thread/sample").length, 0);
  } finally {
    await f.close();
  }
});

test("renaming stores the name in the engine", async () => {
  const f = await engineFixture();
  try {
    const { conversationId } = await f.engine.createWork();
    await f.engine.renameWork(conversationId, "Porto de Galinhas, febrero");
    const set = (await f.records()).find((m) => m.method === "thread/name/set");
    assert.equal(set.params.threadId, conversationId);
    assert.equal(set.params.name, "Porto de Galinhas, febrero");
    await until(() => f.events.some((e) => e.type === "title" && e.title === "Porto de Galinhas, febrero"));
  } finally {
    await f.close();
  }
});
