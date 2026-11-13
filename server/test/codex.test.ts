import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexEngine } from "../src/codex/engine";
import type { EngineEvent } from "../src/engine";

async function fixture(stableAfterMs = 60_000) {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/adapter-"));
  const log = join(dir, "protocol.jsonl");
  process.env.BITACORA_FAKE_LOG = log;
  const engine = new CodexEngine({
    home: join(dir, "home"),
    workspace: join(dir, "workspace"),
    binary: process.execPath,
    args: [resolve("server/test/stdio-server.mjs")],
    restartDelayMs: 30,
    stableAfterMs,
    probeProtection: async () => process.env.BITACORA_FAKE_MXC === "1",
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
  const secrets = ["CODEX_TEST_SECRET", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "GH_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "CUSTOM_SECRET_SUFFIX", "myPassword", "APP_API_KEY_EXTRA", "CREDENTIAL_FILE"];
  const previous = secrets.map(k => process.env[k]);
  secrets.forEach(k => process.env[k] = "sentinel");
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
    for (const name of secrets) assert.equal(env[name], undefined, name);
    for (const name of ["PATH", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP"]) {
      const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
      assert.ok(key, name);
      assert.equal(env[key], process.env[name], name);
    }
  } finally {
    secrets.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; });
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

test("restart backoff grows, exhausts explicitly and allows manual retry", async () => {
  const f = await fixture();
  try {
    const waits: number[] = [];
    for (let restarted = 1; restarted <= 5; restarted++) {
      const start = performance.now();
      await assert.rejects(f.engine.send("thread-1", "crash"));
      await until(() => f.events.filter(e => e.type === "availability" && e.available).length === restarted + 1);
      waits.push(performance.now() - start);
    }
    // Allow process startup jitter; the last delay must exceed the first several times over.
    assert.ok(waits[4] > waits[0] * 2, JSON.stringify(waits));
    assert.ok(waits[4] >= 480, JSON.stringify(waits));
    await assert.rejects(f.engine.send("thread-1", "crash"));
    await until(() => f.events.some(e => e.type === "availability" && e.exhausted));
    await delay(150);
    assert.equal((await f.records()).filter(m => m.method === "initialize").length, 6);
    await f.engine.retry();
    assert.equal((await f.records()).filter(m => m.method === "initialize").length, 7);
  } finally { await f.close(); }
});

test("stable operation resets the restart budget", async () => {
  const f = await fixture(80);
  try {
    for (let i = 1; i <= 7; i++) {
      await delay(120);
      await assert.rejects(f.engine.send("thread-1", "crash"));
      await until(() => f.events.filter(e => e.type === "availability" && e.available).length === i + 1);
    }
    assert.ok(!f.events.some(e => e.type === "availability" && e.exhausted));
  } finally { await f.close(); }
});

test("started notification before start reply delivers only one pause", async () => {
  const f = await fixture();
  try {
    const sending = f.engine.send("thread-1", "pause-started");
    await until(() => f.events.some(e => e.type === "progress" && e.activity === "preparing"));
    await f.engine.interrupt("thread-1");
    await f.engine.interrupt("thread-1");
    await sending;
    assert.equal((await f.records()).filter(m => m.method === "turn/interrupt").length, 1);
    assert.ok(!f.events.some(e => e.type === "problem"));
  } finally { await f.close(); }
});

for (const scenario of ["success", "failure", "restart", "mxc"] as const) {
  test(`protection setup: ${scenario}, sends stay blocked until readiness`, async () => {
    process.env.BITACORA_FAKE_SAFETY = "notConfigured";
    if (scenario === "failure") process.env.BITACORA_FAKE_SETUP_FAIL = "1";
    if (scenario === "restart") process.env.BITACORA_FAKE_SETUP_CRASH = "1";
    if (scenario === "mxc") process.env.BITACORA_FAKE_MXC = "1";
    const f = await fixture();
    try {
      assert.equal(f.engine.executionSafety().allowed, false);
      await assert.rejects(f.engine.send("thread-1", "race"));
      const preparing = f.engine.prepareProtection();
      await assert.rejects(f.engine.send("thread-1", "race"));
      await preparing;
      if (scenario === "failure") {
        await until(() => f.engine.executionSafety().status === "failed");
        assert.match(f.engine.executionSafety().detail, /UAC cancelled/);
        await assert.rejects(f.engine.send("thread-1", "race"));
      } else {
        await until(() => f.engine.executionSafety().allowed);
        await f.engine.send("thread-1", "race");
      }
      const records = await f.records();
      assert.equal(records.filter(m => m.method === "windowsSandbox/setupStart").length, scenario === "mxc" ? 0 : 1);
      assert.equal(records.filter(m => m.method === "turn/start").length, scenario === "failure" ? 0 : 1);
      assert.ok(f.events.some(e => e.type === "protection" && e.safety.status === "preparing"));
    } finally {
      for (const key of ["BITACORA_FAKE_SAFETY", "BITACORA_FAKE_SETUP_FAIL", "BITACORA_FAKE_SETUP_CRASH", "BITACORA_FAKE_MXC"]) delete process.env[key];
      await f.close();
    }
  });
}
