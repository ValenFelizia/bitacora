import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexEngine } from "../src/codex/engine";
import type { EngineEvent } from "../src/engine";

async function fixture() {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/adapter-"));
  const log = join(dir, "protocol.jsonl");
  process.env.BITACORA_FAKE_LOG = log;
  const engine = new CodexEngine({
    home: join(dir, "home"),
    workspace: join(dir, "workspace"),
    binary: process.execPath,
    args: [resolve("server/test/stdio-server.mjs")],
    restartDelayMs: 10,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  const records = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  return {
    engine,
    events,
    records,
    dir,
    close: async () => {
      await engine.close();
      delete process.env.BITACORA_FAKE_LOG;
      await rm(dir, { recursive: true });
    },
  };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail("condition timed out");
}
test("stdio handshake, activities, retry and server-initiated rejection", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(
      (await f.records()).slice(0, 2).map((m) => m.method),
      ["initialize", "initialized"],
    );
    assert.equal(f.engine.executionSafety().allowed, true);
    await f.engine.send("thread-1", "events");
    await until(async () =>
      (await f.records()).some((m) => m.id === "server-request"),
    );
    assert.deepEqual(
      f.events.filter((e) => e.type === "progress").map((e) => e.activity),
      ["reading", "executing", "writing", "tool", "retrying"],
    );
    assert.equal(f.events.filter((e) => e.type === "problem").length, 1);
    assert.equal(
      (await f.records()).find((m) => m.id === "server-request").error.code,
      -32601,
    );
  } finally {
    await f.close();
  }
});
test("completion before start reply never leaves a stale interrupt target; early pause is delivered", async () => {
  const f = await fixture();
  try {
    await f.engine.send("thread-1", "race");
    await f.engine.interrupt("thread-1");
    assert.equal(
      (await f.records()).filter((m) => m.method === "turn/interrupt").length,
      0,
    );
    const sending = f.engine.send("thread-1", "pause");
    await f.engine.interrupt("thread-1");
    await sending;
    assert.equal(
      (await f.records()).filter((m) => m.method === "turn/interrupt").length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("child exit rejects the pending turn and restarts with a fresh handshake", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.engine.send("thread-1", "crash"));
    await until(
      () =>
        f.events.filter((e) => e.type === "availability" && e.available)
          .length === 2,
    );
    assert.ok(f.events.some((e) => e.type === "availability" && !e.available));
    await f.engine.resumeWork("thread-1");
    await f.engine.send("thread-1", "race");
    assert.equal(
      (await f.records()).filter((m) => m.method === "initialize").length,
      2,
    );
  } finally {
    await f.close();
  }
});
test("child environment drops inherited Codex settings and API secrets and forces its home", async () => {
  process.env.CODEX_TEST_SECRET = "sentinel";
  process.env.OPENAI_API_KEY = "sentinel";
  process.env.ANTHROPIC_API_KEY = "sentinel";
  const f = await fixture();
  try {
    await f.engine.send("thread-1", "environment");
    const event = f.events.find(
      (e) => e.type === "detail" && e.text.includes("CODEX_HOME"),
    );
    assert.ok(event && event.type === "detail");
    const env = JSON.parse(event.text);
    assert.equal(env.CODEX_HOME, join(f.dir, "home"));
    assert.deepEqual(
      Object.keys(env).filter((k) => /^CODEX_/i.test(k)),
      ["CODEX_HOME"],
    );
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  } finally {
    delete process.env.CODEX_TEST_SECRET;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await f.close();
  }
});
test("missing Windows protection blocks before turn/start", async () => {
  process.env.BITACORA_FAKE_SAFETY = "notConfigured";
  const f = await fixture();
  try {
    assert.equal(f.engine.executionSafety().allowed, false);
    await assert.rejects(f.engine.send("thread-1", "race"));
    assert.equal(
      (await f.records()).filter((m) => m.method === "turn/start").length,
      0,
    );
  } finally {
    delete process.env.BITACORA_FAKE_SAFETY;
    await f.close();
  }
});

test("automatic restart stops after five increasingly delayed attempts", async () => {
  const f = await fixture();
  try {
    for (let restarted = 1; restarted <= 5; restarted++) {
      await assert.rejects(f.engine.send("thread-1", "crash"));
      await until(() => f.events.filter(e => e.type === "availability" && e.available).length === restarted + 1);
    }
    await assert.rejects(f.engine.send("thread-1", "crash"));
    await delay(400);
    assert.equal((await f.records()).filter(m => m.method === "initialize").length, 6);
  } finally { await f.close(); }
});
