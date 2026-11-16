import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexEngine, killTree, type KillProcessTree } from "../src/codex/engine";
import { App } from "../src/app";
import { WorkspaceFiles } from "../src/workspace-files";
import type { ServerMessage } from "../src/contracts";
import type { EngineEvent } from "../src/engine";

// A turn that never proves it is running, or that never ends, must not leave
// the app waiting forever: the engine is stopped and the app releases the work.

async function fixture(
  options: {
    turnStartTimeoutMs?: number;
    pauseTimeoutMs?: number;
    killTimeoutMs?: number;
    restartDelayMs?: number;
    killProcessTree?: KillProcessTree;
  } = {},
) {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/unresponsive-"));
  const log = join(dir, "protocol.jsonl");
  process.env.BITACORA_FAKE_LOG = log;
  const engine = new CodexEngine({
    home: join(dir, "home"),
    workspace: join(dir, "agency"),
    binary: process.execPath,
    // This fake runs the elevated backend, the mode the check decides here, so
    // it is spawned without the profile: the arguments already match.
    args: [resolve("server/test/stdio-server.mjs")],
    restartDelayMs: options.restartDelayMs ?? 30,
    stableAfterMs: 60_000,
    // The handshake is generous: only the turn/start reply has a short deadline.
    requestTimeoutMs: 30_000,
    turnStartTimeoutMs: options.turnStartTimeoutMs ?? 1000,
    pauseTimeoutMs: options.pauseTimeoutMs ?? 200,
    killTimeoutMs: options.killTimeoutMs,
    killProcessTree: options.killProcessTree,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  return {
    dir,
    engine,
    events,
    log,
    close: async () => {
      try {
        await engine.close();
      } finally {
        delete process.env.BITACORA_FAKE_LOG;
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  };
}

async function application(f: { dir: string; engine: CodexEngine }) {
  const files = new WorkspaceFiles(join(f.dir, "agency"));
  await files.initialize();
  const scans = { count: 0 };
  const scan = files.scan.bind(files);
  files.scan = async (previous, copy) => {
    scans.count++;
    return scan(previous, copy);
  };
  const app = new App(f.engine, join(f.dir, "data"), () => {}, undefined, files);
  return { app, scans };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(`condition timed out after ${timeoutMs}ms`);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function started(file: string) {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

test("a turn/start with no sign of life stops the engine", async () => {
  const f = await fixture({ turnStartTimeoutMs: 1000 });
  const pidFile = join(f.dir, "pids.txt");
  process.env.BITACORA_FAKE_PID = pidFile;
  const { app, scans } = await application(f);
  const replies: ServerMessage[] = [];
  try {
    await app.start();
    const [first] = await started(pidFile);
    await assert.rejects(
      app.command({ type: "send", text: "silent-start" }, (m) => replies.push(m)),
      /stopped answering turn\/start/,
    );
    const work = app.snapshot().works[0];
    // The work is released and the user is told what happened.
    assert.equal(work.busy, false);
    assert.match(work.problem!, /El motor no respondió y lo reinicié/);
    // The process tree is gone before the app scans: the first app-server died.
    assert.ok(first > 0);
    assert.equal(alive(first), false);
    // Exactly one after-request scan runs: the "before" one and the "after"
    // one. The scan the catch would start is skipped by the scanning guard.
    await until(() => app.snapshot().works[0].messages[0].results !== undefined);
    await delay(100);
    assert.equal(scans.count, 2);
    // The engine comes back on its own, without the user asking for a retry.
    await until(() => app.snapshot().engine.available);
    await until(async () => (await started(pidFile)).length === 2);
    const pids = await started(pidFile);
    assert.equal(pids.filter((pid) => !alive(pid)).length, 1);
  } finally {
    delete process.env.BITACORA_FAKE_PID;
    try { await app.close(); } finally { await f.close(); }
  }
});

test("a pause the engine never honours stops it", async () => {
  const f = await fixture({ turnStartTimeoutMs: 5000, pauseTimeoutMs: 200 });
  const { app } = await application(f);
  try {
    await app.start();
    await app.command({ type: "send", text: "pause-hang" }, () => {});
    const work = app.snapshot().works[0];
    assert.equal(work.busy, true);
    await app.command({ type: "interrupt", workId: work.id }, () => {});
    // The pause is accepted but the turn never ends: the engine is stopped.
    await until(() => !app.snapshot().works[0].busy);
    assert.match(app.snapshot().works[0].problem!, /El motor no respondió y lo reinicié/);
    await until(() => app.snapshot().engine.available);
  } finally {
    try { await app.close(); } finally { await f.close(); }
  }
});

test("a pause requested before the turn starts still has a deadline", async () => {
  // The request timeout is far away: only the pause deadline can release this.
  const f = await fixture({ turnStartTimeoutMs: 30_000, pauseTimeoutMs: 200 });
  const { app } = await application(f);
  try {
    await app.start();
    const sending = app.command({ type: "send", text: "silent-start" }, () => {});
    await until(() => app.snapshot().works[0]?.busy === true);
    await app.command({ type: "interrupt", workId: app.snapshot().works[0].id }, () => {});
    // The turn never started, so only the pause deadline can stop the engine.
    await assert.rejects(sending, /stopped answering turn\/start/);
    const work = app.snapshot().works[0];
    assert.equal(work.busy, false);
    assert.match(work.problem!, /El motor no respondió y lo reinicié/);
  } finally {
    try { await app.close(); } finally { await f.close(); }
  }
});

test("a failed pause on a turn still starting keeps the work until the tree stops", async () => {
  const f = await fixture({ turnStartTimeoutMs: 30_000, pauseTimeoutMs: 400 });
  const { app } = await application(f);
  try {
    await app.start();
    const sending = app.command({ type: "send", text: "pause-refused" }, () => {});
    await until(() => app.snapshot().works[0]?.busy === true);
    await app.command({ type: "interrupt", workId: app.snapshot().works[0].id }, () => {});
    // The turn is running and refused the pause: the app must not scan and
    // release the work while it may still write, only after the deadline.
    await sending;
    assert.equal(app.snapshot().works[0].busy, true);
    await until(() => !app.snapshot().works[0].busy);
    assert.match(app.snapshot().works[0].problem!, /El motor no respondió y lo reinicié/);
  } finally {
    try { await app.close(); } finally { await f.close(); }
  }
});

test("a pause after the turn ended does not stop the engine", async () => {
  // The turn completed before its reply: `starting` is still there but nothing
  // is running, so the pause must not arm a deadline.
  process.env.BITACORA_FAKE_TURN_DELAY = "1000";
  const f = await fixture({ turnStartTimeoutMs: 5000, pauseTimeoutMs: 200 });
  try {
    await f.engine.start();
    const sending = f.engine.send("thread-1", "complete-before-reply");
    await until(() => f.events.some((e) => e.type === "finished"));
    await f.engine.interrupt("thread-1");
    await sending;
    await delay(400);
    assert.equal(f.events.some((e) => e.type === "availability" && !e.available), false);
  } finally {
    delete process.env.BITACORA_FAKE_TURN_DELAY;
    await f.close();
  }
});

test("a child that already exited is never handed to taskkill", async () => {
  // Windows reuses PIDs quickly: taskkill on a dead number would stop whatever
  // program owns it now. The guard is checked here instead of with real PIDs.
  const calls: number[] = [];
  const killProcessTree = async (pid: number) => {
    calls.push(pid);
    return true;
  };
  const child = {
    pid: 4242,
    exitCode: 0,
    signalCode: null,
    kill: () => {
      calls.push(-1);
      return true;
    },
  };
  assert.equal(await killTree(child, false, killProcessTree), true);
  // The exit event was already seen, even though exitCode is not set yet.
  assert.equal(await killTree({ ...child, exitCode: null }, true, killProcessTree), true);
  assert.deepEqual(calls, []);
});

test("a silent start stops the tree once, through taskkill", async () => {
  const calls: number[] = [];
  const f = await fixture({
    turnStartTimeoutMs: 1000,
    killProcessTree: async (pid) => {
      calls.push(pid);
      process.kill(pid);
      return true;
    },
  });
  try {
    await f.engine.start();
    await assert.rejects(f.engine.send("thread-1", "silent-start"), /stopped answering turn\/start/);
    assert.equal(calls.length, 1);
    assert.ok(calls[0] > 0);
  } finally {
    await f.close();
  }
});

test("a reply while the tree is stopping waits for the stop", async () => {
  // Pausar reaches its deadline while turn/start is still pending. The app
  // scans as soon as send() rejects, so that rejection must not happen while
  // the tree is still being stopped.
  const order: string[] = [];
  process.env.BITACORA_FAKE_TURN_DELAY = "1000";
  const f = await fixture({
    turnStartTimeoutMs: 30_000,
    pauseTimeoutMs: 300,
    killProcessTree: async (pid) => {
      await delay(1500);
      order.push("stopped");
      process.kill(pid);
      return true;
    },
  });
  try {
    await f.engine.start();
    const sending = f.engine.send("thread-1", "error-after-timeout");
    await f.engine.interrupt("thread-1");
    await assert.rejects(sending);
    order.push("released");
    assert.deepEqual(order, ["stopped", "released"]);
  } finally {
    delete process.env.BITACORA_FAKE_TURN_DELAY;
    await f.close();
  }
});

test("an engine whose process cannot be stopped is not restarted", async () => {
  const killed: number[] = [];
  const f = await fixture({
    turnStartTimeoutMs: 200,
    killTimeoutMs: 300,
    // Pretends the tree was killed but leaves the app-server running.
    killProcessTree: async (pid) => {
      killed.push(pid);
      return true;
    },
  });
  const pidFile = join(f.dir, "pids.txt");
  process.env.BITACORA_FAKE_PID = pidFile;
  try {
    await f.engine.start();
    await assert.rejects(f.engine.send("thread-1", "silent-start"));
    await delay(400);
    // A live app-server must not get a second one next to it.
    assert.equal((await started(pidFile)).length, 1);
    assert.equal(f.engine.executionSafety().allowed, false);
  } finally {
    for (const pid of killed) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    await until(() => killed.every((pid) => !alive(pid)));
    delete process.env.BITACORA_FAKE_PID;
    await f.close();
  }
});

test("the tree kill also stops the commands the turn started", { skip: process.platform !== "win32" }, async () => {
  const f = await fixture({ turnStartTimeoutMs: 1000 });
  const childFile = join(f.dir, "grandchild.pid");
  process.env.BITACORA_FAKE_CHILD_PID = childFile;
  let pid = 0;
  try {
    await f.engine.start();
    await assert.rejects(f.engine.send("thread-1", "spawn-child"), /stopped answering turn\/start/);
    pid = Number((await readFile(childFile, "utf8")).trim());
    assert.ok(pid > 0);
    // A plain child.kill() would leave this grandchild running.
    await until(() => !alive(pid));
  } finally {
    delete process.env.BITACORA_FAKE_CHILD_PID;
    await f.close();
    // A failed assertion must not leave the grandchild behind.
    if (pid && alive(pid)) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  }
});
