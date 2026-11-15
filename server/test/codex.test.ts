import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexEngine } from "../src/codex/engine";
import type { EngineEvent } from "../src/engine";

test("ready unelevated remains blocked", async () => {
  process.env.BITACORA_FAKE_MODE = "unelevated";
  const f = await fixture();
  try {
    assert.equal(f.engine.executionSafety().allowed, false);
    await assert.rejects(f.engine.send("thread-1", "race"));
    assert.equal((await f.records()).filter(m => m.method === "turn/start").length, 0);
  } finally { delete process.env.BITACORA_FAKE_MODE; await f.close(); }
});

test("read and probe failures retry checks without administrative preparation", async () => {
  for (const failure of ["read", "probe"]) {
    process.env.BITACORA_FAKE_SAFETY = "notConfigured";
    if (failure === "read") process.env.BITACORA_FAKE_READ_FAIL = "1";
    let probes = 0;
    const f = await fixture(60000, { probeProtection: async () => {
      probes++; throw new Error("probe timed out");
    } });
    try {
      assert.equal(f.engine.executionSafety().issue, "check");
      await f.engine.prepareProtection();
      assert.equal(f.engine.executionSafety().issue, "check");
      const records = await f.records();
      assert.equal(records.filter(m => m.method === "windowsSandbox/setupStart").length, 0);
      assert.equal(records.filter(m => m.method === "windowsSandbox/readiness").length, 2);
      if (failure === "probe") assert.equal(probes, 2);
    } finally {
      delete process.env.BITACORA_FAKE_READ_FAIL;
      delete process.env.BITACORA_FAKE_SAFETY;
      await f.close();
    }
  }
});

test("saved MXC is probed again by each new engine; unavailable is not ready", async () => {
  process.env.BITACORA_FAKE_MODE = "mxc";
  let probes = 0;
  const f = await fixture(60000, { probeProtection: async () => { probes++; return false; } });
  try {
    assert.equal(probes, 1);
    assert.equal(f.engine.executionSafety().allowed, false);
    assert.equal(f.engine.executionSafety().needsPermission, true);
  } finally { delete process.env.BITACORA_FAKE_MODE; await f.close(); }
});

test("automatic MXC setup caches the successful probe across reload", async () => {
  process.env.BITACORA_FAKE_SAFETY = "notConfigured";
  let probes = 0;
  const f = await fixture(60000, { probeProtection: async () => { probes++; return true; } });
  try {
    await until(() => f.engine.executionSafety().allowed);
    assert.equal(probes, 1);
    assert.equal((await f.records()).filter(m => m.method === "windowsSandbox/setupStart").length, 0);
  } finally { delete process.env.BITACORA_FAKE_SAFETY; await f.close(); }
});

test("interrupted preparation remains retryable", async () => {
  process.env.BITACORA_FAKE_SAFETY = "notConfigured";
  process.env.BITACORA_FAKE_SETUP_INTERRUPTED = "1";
  const f = await fixture();
  try {
    await f.engine.prepareProtection();
    await until(() => f.engine.executionSafety().issue === "interrupted");
    assert.equal(f.engine.executionSafety().allowed, false);
    delete process.env.BITACORA_FAKE_SETUP_INTERRUPTED;
    await f.engine.prepareProtection();
    await until(() => f.engine.executionSafety().allowed);
  } finally {
    delete process.env.BITACORA_FAKE_SETUP_INTERRUPTED;
    delete process.env.BITACORA_FAKE_SAFETY;
    await f.close();
  }
});

test("setupStart timeout unlocks retry as a read, not another UAC", async () => {
  process.env.BITACORA_FAKE_SAFETY = "notConfigured";
  process.env.BITACORA_FAKE_SETUP_TIMEOUT = "1";
  const f = await fixture(60000, { requestTimeoutMs: 200 });
  try {
    await f.engine.prepareProtection();
    assert.equal(f.engine.executionSafety().status, "failed");
    assert.equal(f.engine.executionSafety().issue, "uncertain");
    await f.engine.prepareProtection();
    assert.equal((await f.records()).filter(m => m.method === "windowsSandbox/setupStart").length, 1);
    assert.equal((await f.records()).filter(m => m.method === "windowsSandbox/readiness").length, 2);
  } finally {
    delete process.env.BITACORA_FAKE_SETUP_TIMEOUT;
    delete process.env.BITACORA_FAKE_SAFETY;
    await f.close();
  }
});

test("reload cancels pending RPC and start failure goes through restart/retry", async () => {
  process.env.BITACORA_FAKE_SAFETY = "notConfigured";
  const f = await fixture();
  const originalStart = f.engine.start.bind(f.engine);
  try {
    await writeFile(join(f.dir, "home/fake-protection.hang"), "1");
    const pending = assert.rejects(f.engine.account(), /reloading protection/);
    f.engine.start = async () => { throw new Error("version mismatch during reload"); };
    await f.engine.prepareProtection();
    await pending;
    await until(() => f.events.some(e => e.type === "availability" && e.exhausted === true));
    assert.equal(f.engine.executionSafety().issue, "restart");
    await rm(join(f.dir, "home/fake-protection.hang"));
    f.engine.start = originalStart;
    await f.engine.retry();
    assert.equal(f.engine.executionSafety().allowed, true);
  } finally {
    delete process.env.BITACORA_FAKE_ACCOUNT_HANG;
    delete process.env.BITACORA_FAKE_SAFETY;
    await f.close();
  }
});

async function fixture(stableAfterMs = 60_000, options: Partial<ConstructorParameters<typeof CodexEngine>[0]> = {}) {
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
    ...options,
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
// Replaces the engine's restart and stability timers so tests assert the
// scheduled delays instead of measuring wall-clock time.
function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { run: () => void; at: number; delayMs: number }>();
  return {
    scheduleTimer: (run: () => void, delayMs: number) => {
      const id = ++next;
      timers.set(id, { run, at: now + delayMs, delayMs });
      return () => { timers.delete(id); };
    },
    pending: () => timers.size,
    // Fires the earliest scheduled timer and returns the delay it was given.
    runNext() {
      const earliest = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!earliest) throw new Error("no scheduled timer");
      const [id, timer] = earliest;
      timers.delete(id);
      now = timer.at;
      timer.run();
      return timer.delayMs;
    },
  };
}
test("a slow turn/start reply keeps the request until the turn ends", {
  // Reproduces the finding from PR #11: the request timeout releases the work
  // while the turn is still changing files. Fixing it changes what the app
  // should do when the engine stops answering, so it waits for a decision.
  skip: "Pendiente de decisión: qué hacer cuando el motor no responde pero el turno sigue (issue #20)",
}, async () => {
  process.env.BITACORA_FAKE_TURN_DELAY = "1800";
  const f = await fixture(60_000, { requestTimeoutMs: 1000 });
  try {
    const sending = f.engine.send("thread-1", "slow-start");
    const outcome = await Promise.race([
      sending.then(() => "sent", (error: Error) => `rejected: ${error.message}`),
      delay(1400).then(() => "still running"),
    ]);
    // The turn already started: the request must not be released.
    assert.equal(outcome, "still running");
    await sending;
    assert.ok(f.events.some((e) => e.type === "finished"));
  } finally {
    delete process.env.BITACORA_FAKE_TURN_DELAY;
    await f.close();
  }
});

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
      Object.keys((await f.records()).find((m) => m.id === "server-request").result.answers).length,
      0,
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
  const clock = fakeClock();
  const f = await fixture(60_000, { scheduleTimer: clock.scheduleTimer });
  try {
    const delays: number[] = [];
    for (let restarted = 1; restarted <= 5; restarted++) {
      await assert.rejects(f.engine.send("thread-1", "crash"));
      delays.push(clock.runNext());
      await until(() => f.events.filter(e => e.type === "availability" && e.available).length === restarted + 1);
    }
    assert.deepEqual(delays, [30, 60, 120, 240, 480]);
    await assert.rejects(f.engine.send("thread-1", "crash"));
    await until(() => f.events.some(e => e.type === "availability" && e.exhausted));
    assert.equal(clock.pending(), 0);
    assert.equal((await f.records()).filter(m => m.method === "initialize").length, 6);
    await f.engine.retry();
    assert.equal((await f.records()).filter(m => m.method === "initialize").length, 7);
  } finally { await f.close(); }
});

test("closing during an automatic restart leaves no engine running", async () => {
  const clock = fakeClock();
  const f = await fixture(60_000, { scheduleTimer: clock.scheduleTimer });
  try {
    await assert.rejects(f.engine.send("thread-1", "crash"));
    // Fire the scheduled restart and close in the same tick: the restart is
    // still before spawning, so close() must wait for it and stop it.
    clock.runNext();
    await f.engine.close();
    await delay(300);
    assert.equal(
      (await f.records()).filter((m) => m.method === "initialize").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("stable operation resets the restart budget", async () => {
  const clock = fakeClock();
  const f = await fixture(80, { scheduleTimer: clock.scheduleTimer });
  try {
    for (let i = 1; i <= 7; i++) {
      // The stability window must be the configured one, and once it elapses the
      // backoff starts over from the first delay instead of growing.
      assert.equal(clock.runNext(), 80);
      await assert.rejects(f.engine.send("thread-1", "crash"));
      assert.equal(clock.runNext(), 30);
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
      if (scenario !== "mxc") {
      assert.equal(f.engine.executionSafety().allowed, false);
      await assert.rejects(f.engine.send("thread-1", "race"));
      const preparing = f.engine.prepareProtection();
      await assert.rejects(f.engine.send("thread-1", "race"));
      await preparing;
      }
      if (scenario === "failure") {
        await until(() => f.engine.executionSafety().status === "failed");
        assert.match(f.engine.executionSafety().detail, /UAC cancelled/);
        await assert.rejects(f.engine.send("thread-1", "race"));
        await f.engine.prepareProtection();
        assert.equal(f.engine.executionSafety().status, "preparing");
        await until(() => f.engine.executionSafety().status === "failed");
      } else {
        await until(() => f.engine.executionSafety().allowed);
        await f.engine.send("thread-1", "race");
      }
      const records = await f.records();
      assert.equal(records.filter(m => m.method === "windowsSandbox/setupStart").length, scenario === "mxc" ? 0 : scenario === "failure" ? 2 : 1);
      assert.equal(records.filter(m => m.method === "turn/start").length, scenario === "failure" ? 0 : 1);
      assert.ok(f.events.some(e => e.type === "protection" && e.safety.status === "preparing"));
    } finally {
      for (const key of ["BITACORA_FAKE_SAFETY", "BITACORA_FAKE_SETUP_FAIL", "BITACORA_FAKE_SETUP_CRASH", "BITACORA_FAKE_MXC"]) delete process.env[key];
      await f.close();
    }
  });
}


test("generic files become local images and named relative document mentions", async () => {
  const f = await fixture();
  const image = join(f.dir, 'workspace', 'adjuntos', 'foto con ñ.png');
  const pdf = join(f.dir, 'workspace', 'adjuntos', 'cotización.pdf');
  try {
    await f.engine.send("thread-1", "Describí", [
      { path: image, mime: "image/png" },
      { path: pdf, mime: "application/pdf" },
    ]);
    const call = (await f.records()).find(m => m.method === "turn/start");
    assert.equal(call.params.input[0].text, 'Describí');
    assert.deepEqual(call.params.input[1], { type: 'mention', name: 'cotización.pdf', path: join('adjuntos', 'cotización.pdf') });
    assert.deepEqual(call.params.input[2], { type: "localImage", path: image });
  } finally { await f.close(); }
});

 test("all server initiated requests resolve without user approvals or hangs", async () => {
  const f = await fixture();
  try {
    await f.engine.send('thread-1', 'interactive');
    await until(() => f.events.some(e => e.type === 'finished'));
    const replies = (await f.records()).filter(m => String(m.id).startsWith('interactive-'));
    assert.equal(replies.length, 10);
    assert.equal(replies[0].result.decision, 'decline');
    assert.deepEqual(replies[2].result.permissions, {});
    assert.deepEqual(replies[3].result.answers, {});
    assert.equal(f.events.filter(e => e.type === 'problem').length, 0);
    await f.engine.send('thread-1', 'Texto de la usuaria', [], { filesReverted: true });
    const records = await f.records();
    assert.equal(records.filter(m => m.method === 'thread/resume').length, 0);
    assert.match(records.filter(m => m.method === 'turn/start').at(-1).params.input[1].text, /Aviso de Bitácora/);
    await f.engine.send('thread-1', 'Siguiente');
    const following = (await f.records()).filter(m => m.method === 'turn/start').at(-1);
    assert.equal(following.params.input.length, 1);
    assert.equal(records.filter(m => m.method === 'turn/start').at(-1).params.input[0].text, 'Texto de la usuaria');
  } finally { await f.close(); }
});
