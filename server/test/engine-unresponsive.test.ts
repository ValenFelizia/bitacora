import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexEngine } from "../src/codex/engine";
import { App } from "../src/app";
import { WorkspaceFiles } from "../src/workspace-files";
import type { ServerMessage } from "../src/contracts";
import type { EngineEvent } from "../src/engine";

// A turn that never proves it is running, or that never ends, must not leave
// the app waiting forever: the engine is stopped and the app releases the work.

async function fixture(
  options: { requestTimeoutMs?: number; pauseTimeoutMs?: number; restartDelayMs?: number } = {},
) {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/unresponsive-"));
  const log = join(dir, "protocol.jsonl");
  process.env.BITACORA_FAKE_LOG = log;
  const engine = new CodexEngine({
    home: join(dir, "home"),
    workspace: join(dir, "agency"),
    binary: process.execPath,
    args: [resolve("server/test/stdio-server.mjs")],
    restartDelayMs: options.restartDelayMs ?? 30,
    stableAfterMs: 60_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 200,
    pauseTimeoutMs: options.pauseTimeoutMs ?? 200,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  return {
    dir,
    engine,
    events,
    log,
    close: async () => {
      await engine.close();
      delete process.env.BITACORA_FAKE_LOG;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail("condition timed out");
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
  const f = await fixture({ requestTimeoutMs: 1000 });
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
    await app.close();
    await f.close();
  }
});

test("a pause the engine never honours stops it", async () => {
  const f = await fixture({ requestTimeoutMs: 1000, pauseTimeoutMs: 200 });
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
    await app.close();
    await f.close();
  }
});

test("a pause requested before the turn starts still has a deadline", async () => {
  // The request timeout is far away: only the pause deadline can release this.
  const f = await fixture({ requestTimeoutMs: 30_000, pauseTimeoutMs: 200 });
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
    await app.close();
    await f.close();
  }
});

test("the tree kill also stops the commands the turn started", { skip: process.platform !== "win32" }, async () => {
  const f = await fixture({ requestTimeoutMs: 1000 });
  const childFile = join(f.dir, "grandchild.pid");
  process.env.BITACORA_FAKE_CHILD_PID = childFile;
  try {
    await f.engine.start();
    await assert.rejects(f.engine.send("thread-1", "spawn-child"), /stopped answering turn\/start/);
    const pid = Number((await readFile(childFile, "utf8")).trim());
    assert.ok(pid > 0);
    // A plain child.kill() would leave this grandchild running.
    await until(() => !alive(pid));
  } finally {
    delete process.env.BITACORA_FAKE_CHILD_PID;
    await f.close();
  }
});
