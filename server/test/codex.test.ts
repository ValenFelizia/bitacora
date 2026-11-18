import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexEngine, appServerArgs, PERMISSIONS_PROFILE } from "../src/codex/engine";
import type { KillProcessTree } from "../src/codex/engine";
import { fakeAppServerArgs } from "./fake-app-server";
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
  // The request timeout also covers the handshake, so it must be generous
  // enough for it: a failed start would skip the cleanup below and leave the
  // fake app-server ignoring every later setupStart.
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(60000, { requestTimeoutMs: 8000 });
    await f.engine.prepareProtection();
    assert.equal(f.engine.executionSafety().status, "failed");
    assert.equal(f.engine.executionSafety().issue, "uncertain");
    await f.engine.prepareProtection();
    assert.equal((await f.records()).filter(m => m.method === "windowsSandbox/setupStart").length, 1);
    // One check per process (the first one, the one replaced in the decided
    // mode) plus the read that the retry does instead of another UAC.
    assert.equal((await f.records()).filter(m => m.method === "windowsSandbox/readiness").length, 3);
  } finally {
    delete process.env.BITACORA_FAKE_SETUP_TIMEOUT;
    delete process.env.BITACORA_FAKE_SAFETY;
    await f?.close();
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

/**
 * A machine with the native sandbox: the read-restricting profile is required.
 * `fixture().close()` clears it, so a test cannot leak the mode into the next.
 */
function mxc() {
  process.env.BITACORA_FAKE_MODE = "mxc";
  process.env.BITACORA_FAKE_MXC = "1";
}
/** True when these spawn arguments define the read-restricting profile. */
const definesProfile = (args: string[]) =>
  args.some(
    (arg) =>
      arg.startsWith("default_permissions=") ||
      arg.includes(`permissions.${PERMISSIONS_PROFILE}=`),
  );
/** True while the process is alive. */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/**
 * The fake app-server is spawned with the arguments the real one would get for
 * the decided backend, so the mode of every process can be asserted instead of
 * assumed.
 */
async function openFixture(
  stableAfterMs = 60_000,
  options: Partial<ConstructorParameters<typeof CodexEngine>[0]> = {},
) {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/adapter-"));
  const log = join(dir, "protocol.jsonl");
  const spawnLog = join(dir, "spawns.jsonl");
  process.env.BITACORA_FAKE_LOG = log;
  process.env.BITACORA_FAKE_SPAWN = spawnLog;
  const engine = new CodexEngine({
    home: join(dir, "home"),
    workspace: join(dir, "workspace"),
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    stableAfterMs,
    probeProtection: async () => process.env.BITACORA_FAKE_MXC === "1",
    ...options,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const records = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const spawns = async () => {
    try {
      return (await readFile(spawnLog, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid: number; args: string[] });
    } catch {
      return [];
    }
  };
  return {
    engine,
    events,
    records,
    spawns,
    dir,
    close: async () => {
      try {
        await engine.close();
      } finally {
        delete process.env.BITACORA_FAKE_LOG;
        delete process.env.BITACORA_FAKE_SPAWN;
        // The sandbox mode is chosen per test, before the fixture exists.
        delete process.env.BITACORA_FAKE_MODE;
        delete process.env.BITACORA_FAKE_MXC;
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  };
}
async function fixture(
  stableAfterMs = 60_000,
  options: Partial<ConstructorParameters<typeof CodexEngine>[0]> = {},
) {
  const f = await openFixture(stableAfterMs, options);
  try {
    await f.engine.start();
  } catch (error) {
    // A failed start must not leave a process behind or poison the next test
    // with this file's fake-app-server settings.
    await f.close().catch(() => {});
    for (const key of Object.keys(process.env))
      if (key.startsWith("BITACORA_FAKE_")) delete process.env[key];
    throw error;
  }
  return f;
}
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`condition timed out after ${timeoutMs}ms`);
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
test("a slow turn/start reply keeps the request until the turn ends", async () => {
  // Reproduces the finding from PR #11: the request timeout released the work
  // while the turn was still changing files. Now the timeout only releases the
  // request when the turn is certainly not running; a turn that already
  // started keeps the app waiting for its own turn/completed.
  process.env.BITACORA_FAKE_TURN_DELAY = "5000";
  const f = await fixture(60_000, { turnStartTimeoutMs: 2500 });
  try {
    const sending = f.engine.send("thread-1", "slow-start");
    // turn/started arrived before the timeout: the request is not refused.
    await assert.doesNotReject(sending);
    // Nothing is finished yet: the turn ends when the engine says so.
    assert.equal(f.events.some((e) => e.type === "finished"), false);
    await until(() => f.events.some((e) => e.type === "finished"));
    // A turn whose reply never arrives can still be paused.
    await assert.doesNotReject(f.engine.send("thread-1", "slow-start-pause"));
    assert.equal(f.events.filter((e) => e.type === "finished").length, 1);
    await f.engine.interrupt("thread-1");
    await until(() => f.events.filter((e) => e.type === "finished").length === 2);
    const finished = f.events.filter((e) => e.type === "finished");
    assert.equal((finished[1] as { status: string }).status, "interrupted");
  } finally {
    delete process.env.BITACORA_FAKE_TURN_DELAY;
    await f.close();
  }
});

test("preparing protection does not lose a login in progress", async () => {
  process.env.BITACORA_FAKE_SAFETY = "notConfigured";
  process.env.BITACORA_FAKE_SETUP_DELAY = "300";
  const f = await fixture(60_000, { requestTimeoutMs: 15000 });
  try {
    await f.engine.connectAccount();
    const preparing = f.engine.prepareProtection();
    await until(() => f.engine.executionSafety().status === "preparing");
    // A login cannot start while the engine is being replaced.
    await assert.rejects(f.engine.connectAccount(), /being prepared/i);
    await preparing;
    await until(() => f.engine.executionSafety().allowed);
    // The login belonged to the process that was replaced: it is cancelled
    // explicitly once, and the new process is never asked about that id.
    assert.equal((await f.records()).filter((m) => m.method === "account/login/cancel").length, 1);
    await f.engine.connectAccount();
    assert.equal((await f.records()).filter((m) => m.method === "account/login/cancel").length, 1);
  } finally {
    delete process.env.BITACORA_FAKE_SAFETY;
    delete process.env.BITACORA_FAKE_SETUP_DELAY;
    await f.close();
  }
});

test("preparing protection twice starts the Windows setup once", async () => {
  process.env.BITACORA_FAKE_SAFETY = "notConfigured";
  process.env.BITACORA_FAKE_LOGIN_CANCEL_DELAY = "100";
  const f = await fixture(60_000, { requestTimeoutMs: 15000 });
  try {
    await f.engine.connectAccount();
    // The second call arrives while the login cancellation is still pending.
    await Promise.all([f.engine.prepareProtection(), f.engine.prepareProtection()]);
    await until(() => f.engine.executionSafety().allowed);
    assert.equal((await f.records()).filter((m) => m.method === "windowsSandbox/setupStart").length, 1);
  } finally {
    delete process.env.BITACORA_FAKE_SAFETY;
    delete process.env.BITACORA_FAKE_LOGIN_CANCEL_DELAY;
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
    // One handshake for the process that answered the first check, one for the
    // process replaced in the decided mode, one for the restart after the crash.
    assert.equal(
      (await f.records()).filter((m) => m.method === "initialize").length,
      3,
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
    // Two handshakes at startup (the first process, then the one replaced in
    // the decided mode) and one per restart.
    assert.equal((await f.records()).filter(m => m.method === "initialize").length, 7);
    await f.engine.retry();
    assert.equal((await f.records()).filter(m => m.method === "initialize").length, 8);
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
    // The startup pair is the only handshake: the restart was stopped before
    // spawning anything.
    assert.equal(
      (await f.records()).filter((m) => m.method === "initialize").length,
      2,
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
    // The skills list of the restarted process is slow: the check it runs on
    // the way back must not publish `allowed` before the engine takes work.
    if (scenario === "restart") process.env.BITACORA_FAKE_SKILLS_DELAY = "150";
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
      for (const key of ["BITACORA_FAKE_SAFETY", "BITACORA_FAKE_SETUP_FAIL", "BITACORA_FAKE_SETUP_CRASH", "BITACORA_FAKE_MXC", "BITACORA_FAKE_SKILLS_DELAY"]) delete process.env[key];
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

// A valid question goes to the screen (questions.test.ts); one that cannot be
// shown, like the empty params here, is answered empty like the rest.
test("every other server initiated request resolves without user approvals or hangs", async () => {
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

test("every thread and turn is started with the read-restricting profile", async () => {
  mxc();
  const f = await fixture();
  try {
    assert.equal(f.engine.executionSafety().readBlock, true);
    await f.engine.createWork();
    await f.engine.send("thread-1", "race");
    const records = await f.records();
    const thread = records.find((m) => m.method === "thread/start");
    assert.equal(thread.params.permissions, "agencia");
    assert.equal(thread.params.sandbox, undefined);
    const turn = records.find((m) => m.method === "turn/start");
    assert.equal(turn.params.permissions, "agencia");
    // The profile and a sandbox policy cannot be combined: the engine refuses
    // the request instead of silently dropping the profile.
    assert.equal(turn.params.sandboxPolicy, undefined);
    assert.equal(records.filter((m) => m.method === "initialize")[0].params.capabilities.experimentalApi, true);
    // One harmless command proves the machine can run the profile before the
    // app lets the user work.
    const probe = records.find((m) => m.method === "command/exec");
    assert.equal(probe.params.permissionProfile, "agencia");
    assert.equal(probe.params.sandboxPolicy, undefined);
  } finally { await f.close(); }
});

test("a machine without MXC works with the write protection and warns", async () => {
  // The fake reports `windows.sandbox=elevated`, the backend of a computer
  // without the native sandbox: it cannot run a profile that denies `:root`.
  const f = await fixture();
  try {
    const safety = f.engine.executionSafety();
    assert.equal(safety.allowed, true);
    assert.equal(safety.status, "ready");
    assert.equal(safety.readBlock, false);
    await f.engine.createWork();
    await f.engine.resumeWork("thread-1");
    await f.engine.send("thread-1", "race");
    const records = await f.records();
    for (const method of ["thread/start", "thread/resume"]) {
      const thread = records.find((m) => m.method === method);
      assert.equal(thread.params.sandbox, "workspace-write");
      assert.equal(thread.params.permissions, undefined);
    }
    const turn = records.find((m) => m.method === "turn/start");
    assert.deepEqual(turn.params.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: [join(f.dir, "workspace")],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
    assert.equal(turn.params.permissions, undefined);
    // The profile is not offered to a process that cannot run it: nothing to
    // list and nothing to try.
    assert.equal(records.filter((m) => m.method === "permissionProfile/list").length, 0);
    assert.equal(records.filter((m) => m.method === "command/exec").length, 0);
  } finally { await f.close(); }
});

test("a computer that gains MXC stops using the weaker mode", async () => {
  // The saved mode is `elevated`, but this computer can run the native
  // sandbox: an old setting must not keep the agent reading the whole disk.
  process.env.BITACORA_FAKE_MODE = "elevated";
  process.env.BITACORA_FAKE_MXC = "1";
  const f = await fixture();
  try {
    await until(() => f.engine.executionSafety().allowed);
    assert.equal(f.engine.executionSafety().readBlock, true);
    const records = await f.records();
    assert.equal(records.filter((m) => m.method === "config/value/write")[0].params.value, "mxc");
  } finally { await f.close(); }
});

test("an inconclusive MXC probe keeps the protection that already works", async () => {
  // The saved `elevated` mode works here: a probe that cannot answer must not
  // leave the user without the write protection she already had.
  let probes = 0;
  const f = await fixture(60_000, { probeProtection: async () => { probes++; throw new Error("probe timed out"); } });
  try {
    // One probe per process: the first process cannot serve the elevated
    // backend, so it is replaced and the new one asks again.
    assert.equal(probes, 2);
    assert.equal(f.engine.executionSafety().allowed, true);
    assert.equal(f.engine.executionSafety().readBlock, false);
  } finally { await f.close(); }
});

test("a machine without MXC replaces the first process with one without the profile", async () => {
  // The backend is only known after the first check, so that process carries
  // the profile (the safe default) and cannot serve the elevated backend: it is
  // stopped and replaced exactly once, before any work is allowed.
  const f = await fixture();
  try {
    const spawns = await f.spawns();
    assert.equal(spawns.length, 2);
    assert.equal(definesProfile(spawns[0].args), true);
    assert.equal(definesProfile(spawns[1].args), false);
    assert.notEqual(spawns[0].pid, spawns[1].pid);
    assert.equal(alive(spawns[0].pid), false);
    assert.equal(f.engine.executionSafety().allowed, true);
    assert.equal(f.engine.executionSafety().readBlock, false);
    await f.engine.send("thread-1", "race");
    const turn = (await f.records()).find((m) => m.method === "turn/start");
    assert.equal(turn.params.permissions, undefined);
    assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
  } finally { await f.close(); }
});

test("a failed first check ends with a process without the profile before work is allowed", async () => {
  // The first process answered the check with an error, so the engine came up
  // blocked with the profile still on its command line. The retry decides the
  // elevated backend: that process cannot run it and must be replaced before
  // any work is allowed.
  process.env.BITACORA_FAKE_READ_FAIL_ONCE = "1";
  const f = await fixture();
  try {
    assert.equal(f.engine.executionSafety().allowed, false);
    assert.equal(f.engine.executionSafety().issue, "check");
    await assert.rejects(f.engine.send("thread-1", "race"));
    await f.engine.prepareProtection();
    assert.equal(f.engine.executionSafety().allowed, true);
    assert.equal(f.engine.executionSafety().readBlock, false);
    const spawns = await f.spawns();
    assert.equal(spawns.length, 2);
    assert.equal(definesProfile(spawns[0].args), true);
    assert.equal(definesProfile(spawns[1].args), false);
    await f.engine.send("thread-1", "race");
    const turn = (await f.records()).find((m) => m.method === "turn/start");
    assert.equal(turn.params.permissions, undefined);
    assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
  } finally {
    delete process.env.BITACORA_FAKE_READ_FAIL_ONCE;
    await f.close();
  }
});

test("an MXC machine whose probe cannot answer does not work", async () => {
  // A probe that times out is not a "no MXC" answer: on a machine whose saved
  // or configured mode is the profile, the app must not fall back to the
  // weaker mode.
  for (const mode of ["mxc", undefined] as const) {
    if (mode) process.env.BITACORA_FAKE_MODE = mode;
    else process.env.BITACORA_FAKE_SAFETY = "notConfigured";
    const f = await fixture(60_000, {
      probeProtection: async () => { throw new Error("probe timed out"); },
    });
    try {
      assert.equal(f.engine.executionSafety().allowed, false, String(mode));
      assert.equal(f.engine.executionSafety().issue, "check");
      await assert.rejects(f.engine.send("thread-1", "race"));
      assert.equal((await f.records()).filter((m) => m.method === "turn/start").length, 0);
    } finally {
      delete process.env.BITACORA_FAKE_MODE;
      delete process.env.BITACORA_FAKE_SAFETY;
      await f.close();
    }
  }
});

test("closing while the process is being replaced leaves no engine running", async () => {
  // The first process cannot serve the elevated backend. While it is being
  // stopped for the replacement, close() must leave nothing running and must
  // not spawn the new one.
  let kills = 0;
  const slowKill: KillProcessTree = async (pid) => {
    kills++;
    await delay(200);
    try { process.kill(pid); } catch { /* it already exited */ }
    return true;
  };
  const f = await openFixture(60_000, { killProcessTree: slowKill });
  try {
    const starting = f.engine.start();
    await until(() => kills === 1);
    await f.engine.close();
    await starting.catch(() => {});
    await delay(200);
    const spawns = await f.spawns();
    assert.equal(spawns.length, 1);
    for (const spawn of spawns) assert.equal(alive(spawn.pid), false, `pid ${spawn.pid}`);
  } finally { await f.close(); }
});

test("the automatic restart after a crash keeps the decided mode", async () => {
  const f = await fixture();
  try {
    assert.equal(f.engine.executionSafety().readBlock, false);
    await assert.rejects(f.engine.send("thread-1", "crash"));
    // The restart reuses the backend the check already decided: it is not a
    // fresh start that would spawn the profile again.
    await until(async () => (await f.spawns()).length === 3);
    await until(() => f.engine.executionSafety().allowed);
    const spawns = await f.spawns();
    assert.equal(definesProfile(spawns[2].args), false);
    await f.engine.send("thread-1", "race");
    const turn = (await f.records()).filter((m) => m.method === "turn/start").at(-1);
    assert.equal(turn.params.permissions, undefined);
    assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
  } finally { await f.close(); }
});

test("a machine without MXC does not refuse a thread for its profile", async () => {
  // There is no profile to take in this mode: a thread that reports another
  // one is not a refusal, because the thread runs with the plain policy.
  process.env.BITACORA_FAKE_THREAD_PROFILE = "other";
  const f = await fixture();
  try {
    assert.equal(f.engine.executionSafety().readBlock, false);
    assert.ok((await f.engine.createWork()).conversationId);
    await f.engine.resumeWork("thread-1");
    assert.equal(f.engine.executionSafety().allowed, true);
  } finally {
    delete process.env.BITACORA_FAKE_THREAD_PROFILE;
    await f.close();
  }
});

test("the profile is only defined for a process that can run it", () => {
  // Before the check decides, the profile is the safe default.
  assert.equal(definesProfile(appServerArgs(undefined)), true);
  assert.equal(definesProfile(appServerArgs("mxc")), true);
  // The elevated backend refuses it, and a default profile it cannot run would
  // make every command fail.
  assert.equal(definesProfile(appServerArgs("elevated")), false);
});

test("a machine that cannot run the profile blocks work instead of reading the whole disk", async () => {
  // On a machine with MXC the profile is required: a backend that cannot run
  // it must not fall back to the weaker mode.
  mxc();
  process.env.BITACORA_FAKE_PROFILE_EXEC = "refuse";
  const f = await fixture();
  try {
    assert.equal(f.engine.executionSafety().allowed, false);
    assert.equal(f.engine.executionSafety().issue, "readBlock");
    assert.match(f.engine.executionSafety().detail, /requires effective `:root` read access/);
    await assert.rejects(f.engine.send("thread-1", "race"));
    assert.equal((await f.records()).filter((m) => m.method === "turn/start").length, 0);
  } finally {
    delete process.env.BITACORA_FAKE_PROFILE_EXEC;
    await f.close();
  }
});

for (const refusal of ["missing", "denied", "error"] as const) {
  test(`a refused permissions profile blocks work instead of reading the whole disk: ${refusal}`, async () => {
    mxc();
    process.env.BITACORA_FAKE_PROFILE = refusal;
    const f = await fixture();
    try {
      assert.equal(f.engine.executionSafety().allowed, false);
      assert.equal(f.engine.executionSafety().issue, "readBlock");
      assert.equal(f.engine.executionSafety().status, "failed");
      assert.match(f.engine.executionSafety().detail, /permissionProfile\/list/);
      await assert.rejects(f.engine.send("thread-1", "race"));
      assert.equal((await f.records()).filter((m) => m.method === "turn/start").length, 0);
      // Retrying asks the engine again instead of starting an administrative
      // setup the user did not ask for.
      await f.engine.prepareProtection();
      assert.equal(f.engine.executionSafety().issue, "readBlock");
      assert.equal((await f.records()).filter((m) => m.method === "windowsSandbox/setupStart").length, 0);
    } finally {
      delete process.env.BITACORA_FAKE_PROFILE;
      await f.close();
    }
  });
}

test("a thread that did not take the profile is refused before any turn", async () => {
  mxc();
  process.env.BITACORA_FAKE_THREAD_PROFILE = "none";
  const f = await fixture();
  try {
    assert.equal(f.engine.executionSafety().allowed, true);
    await assert.rejects(f.engine.createWork(), /permissions=none instead of agencia/);
    // The engine turned execution off: the app can no longer send anything.
    assert.equal(f.engine.executionSafety().allowed, false);
    assert.equal(f.engine.executionSafety().issue, "readBlock");
    await assert.rejects(f.engine.send("thread-1", "race"));
    assert.equal((await f.records()).filter((m) => m.method === "turn/start").length, 0);
  } finally {
    delete process.env.BITACORA_FAKE_THREAD_PROFILE;
    await f.close();
  }
});

test("resuming an old work without the profile is refused too", async () => {
  mxc();
  process.env.BITACORA_FAKE_THREAD_PROFILE = "other";
  const f = await fixture();
  try {
    await assert.rejects(f.engine.resumeWork("thread-1"), /permissions=:workspace instead of agencia/);
    assert.equal(f.engine.executionSafety().allowed, false);
    assert.equal(f.engine.executionSafety().issue, "readBlock");
  } finally {
    delete process.env.BITACORA_FAKE_THREAD_PROFILE;
    await f.close();
  }
});

test("resuming a work that does not report a profile is not a refusal", async () => {
  // `thread/resume` reports the profile only "when known"; the turn still sends
  // it, so a missing value must not block continuing an older work.
  mxc();
  process.env.BITACORA_FAKE_THREAD_PROFILE = "none";
  const f = await fixture();
  try {
    await f.engine.resumeWork("thread-1");
    assert.equal(f.engine.executionSafety().allowed, true);
    await f.engine.send("thread-1", "race");
    assert.equal((await f.records()).filter((m) => m.method === "turn/start")[0].params.permissions, "agencia");
  } finally {
    delete process.env.BITACORA_FAKE_THREAD_PROFILE;
    await f.close();
  }
});
