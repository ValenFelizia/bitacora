import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { CodexHistory } from "../src/codex/history";
import { sweepHistorySnapshots } from "../src/codex/history-snapshot";
import { App } from "../src/app";
import { WorkspaceFiles } from "../src/workspace-files";
import type { ClientCommand, ServerMessage } from "../src/contracts";
import { serve } from "../src/server";
import { WorkspaceSelection, type WorkspaceChoice } from "../src/workspace-selection";
import { FakeEngine } from "./fake-engine";
import { screenProtocols, screenSecret } from "./screen-fixture";

const ids = [
  "019ac000-0000-7000-8000-000000000001",
  "019ac000-0000-7000-8000-000000000002",
  "019ac000-0000-7000-8000-000000000003",
];
const origin = "http://127.0.0.1:5173";

async function fixtureRollout(home: string, id: string, cwd: string, day: string, archived = false, source: unknown = "cli") {
  const folder = archived ? join(home, "archived_sessions") : join(home, "sessions", "2026", "11", day);
  await mkdir(folder, { recursive: true });
  const timestamp = "2026-11-" + day + "T12:00:00.000Z";
  const file = join(folder, "rollout-2026-11-" + day + "T12-00-00-" + id + ".jsonl");
  const body = [
    { type: "session_meta", payload: { id, timestamp, cwd, originator: "codex_cli_rs", cli_version: "0.168.0", source, model_provider: "openai" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: id } },
    { type: "event_msg", payload: { type: "user_message", message: "Guardá la palabra jacarandá.", images: [], local_images: [], text_elements: [] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Guardá la palabra jacarandá." }] } },
    { type: "event_msg", payload: { type: "agent_reasoning", text: "Razonamiento privado de prueba" } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{}", call_id: "test-call" } },
    { type: "event_msg", payload: { type: "agent_message", message: "La palabra es jacarandá." } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "La palabra es jacarandá." }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: id, last_agent_message: "La palabra es jacarandá." } },
  ];
  await writeFile(file, body.map(line => JSON.stringify({ timestamp, ...line })).join("\n") + "\n");
  await utimes(file, new Date(timestamp), new Date(timestamp));
  return file;
}

async function readTree(path: string, folder = ""): Promise<[string, number, Buffer][]> {
  const results: [string, number, Buffer][] = [];
  for (const entry of await readdir(join(path, folder), { withFileTypes: true })) {
    const child = join(folder, entry.name);
    if (entry.isDirectory()) results.push(...await readTree(path, child));
    else if (entry.isFile()) results.push([child, (await stat(join(path, child))).mtimeMs, await readFile(join(path, child))]);
  }
  return results;
}

async function request<T extends ServerMessage["type"]>(socket: WebSocket, command: ClientCommand, type: T) {
  const signal = AbortSignal.timeout(15_000);
  let resolve!: (reply: Extract<ServerMessage, { type: T }>) => void;
  let reject!: (error: Error) => void;
  const done = new Promise<Extract<ServerMessage, { type: T }>>((ok, fail) => { resolve = ok; reject = fail; });
  const receive = (data: Buffer) => {
    const message = JSON.parse(data.toString()) as ServerMessage;
    if (message.type === type) resolve(message as Extract<ServerMessage, { type: T }>);
    else if (message.type === "codexImportProblem" || message.type === "problem") reject(new Error(message.text));
  };
  signal.addEventListener("abort", () => reject(new Error("No response: " + type)), { once: true });
  socket.on("message", receive);
  socket.send(JSON.stringify(command));
  try { return await done; }
  finally { socket.off("message", receive); }
}

class ContinuingEngine extends FakeEngine {
  rollouts: (string | undefined)[] = [];
  override async resumeWork(id: string, model?: Parameters<FakeEngine["resumeWork"]>[1], notes?: string, rollout?: string) {
    await super.resumeWork(id, model, notes);
    this.rollouts.push(rollout);
  }
}

test("Codex history lists both folders, imports two chosen chats once, and resumes the saved copy", async t => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/codex-history-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }));
  const source = join(root, "original");
  const data = join(root, "data");
  const workspace = join(root, "Agencia");
  const alias = join(root, "Junction");
  await mkdir(workspace);
  await symlink(workspace, alias, "junction");
  const current = await fixtureRollout(source, ids[0], alias, "17", false, "vscode");
  const archived = await fixtureRollout(source, ids[1], join(root, "Otra carpeta"), "19", true, "exec");
  await fixtureRollout(source, ids[2], workspace.toUpperCase().replaceAll("\\", "/"), "15", false, "mcp");
  await fixtureRollout(source, "019ac000-0000-7000-8000-000000000004", workspace, "21", false, { subagent: "review" });
  await writeFile(join(source, "state_5.sqlite"), "state copy interrupted");
  await writeFile(join(source, "state_5.sqlite-wal"), "wal copy interrupted");
  await writeFile(join(source, "auth.json"), '{"auth":"untouched fixture"}');
  await writeFile(join(source, "config.toml"), 'model_provider="not-a-provider"\n');
  await writeFile(join(source, "session_index.jsonl"), JSON.stringify({ id: ids[0], thread_name: "Nombre del chat", updated_at: "2026-11-17T12:00:00Z", rollout_path: current }) + "\n");
  const before = await readTree(source);
  const makeServer = (engine: FakeEngine) => serve(engine, data, 0, origin, workspace, undefined, screenSecret,
    undefined, new CodexHistory(source, join(data, "codex")));

  const server = await makeServer(new FakeEngine());
  let socket: WebSocket | undefined;
  try {
    const url = "ws://127.0.0.1:" + server.port + "/ws";
    const unauthorized = new WebSocket(url, { origin });
    const closed = new Promise<void>(done => unauthorized.once("close", () => done()));
    await assert.rejects(once(unauthorized, "open"));
    await closed;
    socket = new WebSocket(url, screenProtocols, { origin });
    await once(socket, "open");
    const list = await request(socket, { type: "listCodexChats" }, "codexChats");
    assert.deepEqual(list.chats.map(chat => [chat.id, chat.sameFolder]), [[ids[0], true], [ids[2], true], [ids[1], false]]);
    assert.equal(list.chats[0].title, "Nombre del chat");
    assert.equal(list.chats[2].folder, "Otra carpeta");
    assert.ok(list.chats.every(chat => !chat.imported && !Number.isNaN(Date.parse(chat.date))));
    assert.deepEqual(await readTree(source), before);

    // An interrupted save can leave an old copy without a corresponding work.
    const oldCopy = join(data, "codex", "sessions", "2026", "11", "19", archived.split(/[\\/]/).at(-1)!);
    await mkdir(join(oldCopy, ".."), { recursive: true });
    await writeFile(oldCopy, "copia interrumpida");
    const command: ClientCommand = { type: "importCodexChats", ids: [ids[0], ids[1], ids[0]] };
    assert.deepEqual(await request(socket, command, "codexImported"), { type: "codexImported", imported: ids.slice(0, 2), failed: [] });
    assert.deepEqual(await request(socket, command, "codexImported"), { type: "codexImported", imported: ids.slice(0, 2), failed: [] });
    const invalid = "C:/fuera-de-codex.jsonl";
    assert.deepEqual(await request(socket, { type: "importCodexChats", ids: [ids[0], invalid] }, "codexImported"),
      { type: "codexImported", imported: [ids[0]], failed: [invalid] });
    const after = await request(socket, { type: "listCodexChats" }, "codexChats");
    assert.deepEqual(after.chats.filter(chat => chat.imported).map(chat => chat.id), ids.slice(0, 2));
    const works = server.app.snapshot().works;
    assert.equal(works.length, 2);
    for (const work of works) {
      assert.deepEqual(work.messages.map(({ role, text }) => [role, text]), [
        ["user", "Guardá la palabra jacarandá."], ["assistant", "La palabra es jacarandá."],
      ]);
      assert.equal(work.details, "");
      assert.equal("importedRollout" in work, false);
    }
    const saved = JSON.parse(await readFile(join(data, "works.json"), "utf8"));
    for (const [id, path] of [[ids[0], current], [ids[1], archived]]) {
      const work = saved.works.find((work: { conversationId: string }) => work.conversationId === id);
      assert.deepEqual(await readFile(join(data, "codex", work.importedRollout)), await readFile(path));
    }
    assert.equal(await readFile(oldCopy, "utf8"), "copia interrumpida");
    assert.deepEqual(await readTree(source), before);
  } finally {
    socket?.terminate();
    await server.close();
  }

  const engine = new ContinuingEngine();
  const restarted = await makeServer(engine);
  try {
    const work = restarted.app.snapshot().works.find(work => work.title === "Nombre del chat")!;
    assert.ok(work);
    const replies: ServerMessage[] = [];
    await restarted.app.command({ type: "send", workId: work.id, text: "¿Qué palabra te pedí guardar?" }, message => replies.push(message));
    assert.equal(replies.some(reply => reply.type === "problem"), false);
    assert.deepEqual(engine.resumed, [ids[0]]);
    assert.match(engine.rollouts[0] || "", new RegExp(ids[0]));
    assert.equal(engine.sent.at(-1), "¿Qué palabra te pedí guardar?");
    assert.deepEqual(await readTree(source), before);
  } finally { await restarted.close(); }
});

test("a missing or empty Codex home returns an empty list without launching Codex", async t => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/empty-codex-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "source");
  const history = new CodexHistory(home, join(root, "data", "codex"), join(root, "missing.exe"));
  const signal = AbortSignal.timeout(5_000);
  assert.deepEqual(await history.list(root, signal), []);
  await mkdir(join(home, "sessions"), { recursive: true });
  assert.deepEqual(await history.list(root, signal), []);
});

test("a selected import copies only its rollout and honors snapshot size and time limits", async t => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/codex-history-limits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const home = join(root, "codex");
  await fixtureRollout(source, ids[0], root, "17");
  const unselected = await fixtureRollout(source, ids[1], root, "18");
  await writeFile(unselected, Buffer.alloc(16_384));
  const signal = new AbortController().signal;
  const history = new CodexHistory(source, home, undefined, { maxBytes: 8192, timeoutMs: 10_000 });
  await assert.rejects(history.list(root, signal), /ocupan demasiado espacio/);
  const imported: string[] = [];
  assert.deepEqual(await history.import([ids[0]], signal, chat => imported.push(chat.id)), []);
  assert.deepEqual(imported, [ids[0]]);

  const timed = new CodexHistory(source, home, undefined, { maxBytes: 32768, timeoutMs: 0 });
  await assert.rejects(timed.list(root, signal), /tardó demasiado/);
});

test("closing the selector cancels its listing without sending an old result", async t => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/codex-history-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let started!: () => void;
  const listingStarted = new Promise<void>(done => { started = done; });
  let aborted!: () => void;
  const listingAborted = new Promise<void>(done => { aborted = done; });
  class SlowList extends CodexHistory {
    calls = 0;
    override async list(_workspace: string, signal: AbortSignal) {
      if (++this.calls === 1) {
        const cancel = once(signal, "abort", { signal: AbortSignal.timeout(10_000) });
        started();
        await cancel;
        aborted();
        return [{ id: ids[0], title: "Viejo", date: "", folder: "", sameFolder: false }];
      }
      return [];
    }
  }
  const server = await serve(new FakeEngine(), join(root, "data"), 0, origin, join(root, "workspace"), undefined,
    screenSecret, undefined, new SlowList(root, join(root, "data", "codex")));
  const socket = new WebSocket("ws://127.0.0.1:" + server.port + "/ws", screenProtocols, { origin });
  try {
    await once(socket, "open");
    const messages: ServerMessage[] = [];
    socket.on("message", raw => messages.push(JSON.parse(String(raw))));
    socket.send(JSON.stringify({ type: "listCodexChats" }));
    await listingStarted;
    socket.send(JSON.stringify({ type: "cancelCodexChatList" }));
    await listingAborted;
    const result = await request(socket, { type: "listCodexChats" }, "codexChats");
    assert.deepEqual(result.chats, []);
    assert.deepEqual(messages.filter(message => message.type === "codexChats"), [result]);
  } finally { socket.terminate(); await server.close(); }
});

test("closing queues the buffered reply before waiting for an import to clean up", async t => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/codex-history-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let endImport!: () => void;
  const cleanup = new Promise<void>(done => { endImport = done; });
  let started!: () => void;
  const importing = new Promise<void>(done => { started = done; });
  let aborted!: () => void;
  const importAborted = new Promise<void>(done => { aborted = done; });
  class SlowImport extends CodexHistory {
    override async import(_ids: string[], signal: AbortSignal): Promise<string[]> {
      const cancel = once(signal, "abort", { signal: AbortSignal.timeout(10_000) });
      started();
      await cancel;
      aborted();
      await cleanup;
      return [];
    }
  }
  const data = join(root, "data");
  const engine = new FakeEngine();
  const app = new App(engine, data, () => {}, undefined, new WorkspaceFiles(join(root, "workspace")),
    undefined, undefined, new SlowImport(root, join(data, "codex")));
  await app.start();
  await app.command({ type: "send", text: "Pedido" }, () => {});
  const pending = app.command({ type: "importCodexChats", ids: [ids[0]] }, () => {});
  await importing;
  engine.emit({ type: "message", conversationId: "conversation-1", id: "reply", text: "Respuesta en curso", delta: true });
  const closed = app.close();
  try {
    await importAborted;
    const until = Date.now() + 5000;
    const saved = join(data, "works.json");
    while (Date.now() < until && !(await readFile(saved, "utf8").catch(() => "")).includes("Respuesta en curso"))
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(await readFile(saved, "utf8"), /Respuesta en curso/);
  } finally { endImport(); await Promise.all([closed, pending]); }
});

test("startup cleanup removes expired or orphaned snapshots and leaves active or unrelated folders", async t => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/codex-history-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const stale = "bitacora-codex-history-old";
  const active = "bitacora-codex-history-" + process.pid + "-active";
  const fresh = "bitacora-codex-history-fresh";
  const crashed = "bitacora-codex-history-2147483646-crashed";
  const unrelated = "unrelated";
  for (const name of [stale, active, fresh, crashed, unrelated]) {
    const path = join(root, name);
    await mkdir(path);
    if (name !== fresh && name !== crashed) await utimes(path, new Date(0), new Date(0));
  }
  await sweepHistorySnapshots(root, now);
  assert.deepEqual((await readdir(root)).sort(), [active, fresh, unrelated].sort());
});

test("chosen folder orders matching Codex chats first, offers once, ties works to that folder, and refuses busy switches", async t => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/codex-history-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }));
  const source = join(root, "original");
  const data = join(root, "data");
  const home = join(root, "default");
  const chosen = join(root, "Agencia elegida");
  const emptyFolder = join(root, "Sin chats");
  await Promise.all([data, home, chosen, emptyFolder].map(path => mkdir(path, { recursive: true })));
  await fixtureRollout(source, ids[0], home, "18");
  await fixtureRollout(source, ids[1], chosen, "16");
  await fixtureRollout(source, ids[2], join(root, "Otra"), "17");

  const selection = new WorkspaceSelection(home, data);
  const engines = new Map<string, ContinuingEngine>();
  const engineFor = (choice: WorkspaceChoice) => {
    const engine = new ContinuingEngine();
    engines.set(choice.root, engine);
    return engine;
  };
  const initial = selection.defaultChoice;
  const server = await serve(
    engineFor(initial), data, 0, origin, initial.root, undefined, screenSecret,
    { selection, initial, engineFor },
    new CodexHistory(source, join(data, "codex")),
  );
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, screenProtocols, { origin });
  const messages: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", raw => {
    messages.push(JSON.parse(String(raw)));
    for (const wake of waiters.splice(0)) wake();
  });
  async function waitFor<T extends ServerMessage>(match: (message: ServerMessage) => message is T): Promise<T> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const idx = messages.findIndex(match);
      if (idx >= 0) return messages.splice(idx, 1)[0] as T;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for server message");
      await new Promise<void>(resolve => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
  const send = (workspace: string, command: ClientCommand) =>
    socket.send(JSON.stringify({ ...command, workspace }));

  try {
    await once(socket, "open");
    const first = await waitFor((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
    assert.equal(first.state.workspace, home);
    assert.equal(first.state.codexImportOffer, undefined);

    send(home, { type: "chooseWorkspace", path: chosen });
    const switched = await waitFor((m): m is Extract<ServerMessage, { type: "workspaceChoice" }> => m.type === "workspaceChoice");
    assert.equal(switched.problem, undefined);

    const offered = await waitFor((m): m is Extract<ServerMessage, { type: "snapshot" }> =>
      m.type === "snapshot" && m.state.workspace === chosen && m.state.codexImportOffer === true);
    assert.equal(offered.state.codexImportOffer, true);

    send(chosen, { type: "listCodexChats" });
    const list = await waitFor((m): m is Extract<ServerMessage, { type: "codexChats" }> => m.type === "codexChats");
    assert.deepEqual(list.chats.map(chat => [chat.id, chat.sameFolder]), [
      [ids[1], true],
      [ids[0], false],
      [ids[2], false],
    ]);

    send(chosen, { type: "importCodexChats", ids: [ids[1]] });
    const imported = await waitFor((m): m is Extract<ServerMessage, { type: "codexImported" }> => m.type === "codexImported");
    assert.deepEqual(imported.imported, [ids[1]]);
    const afterImport = server.app.snapshot();
    assert.equal(afterImport.codexImportOffer, undefined);
    assert.equal(afterImport.works.length, 1);
    const work = afterImport.works[0];

    await waitFor((m): m is Extract<ServerMessage, { type: "snapshot" }> =>
      m.type === "snapshot" && m.state.workspace === chosen && m.state.engine.available);
    send(chosen, { type: "send", workId: work.id, text: "Seguimos en la carpeta elegida" });
    await waitFor((m): m is Extract<ServerMessage, { type: "snapshot" }> =>
      m.type === "snapshot" && m.state.workspace === chosen && m.state.works[0]?.progress === "Leyendo los archivos…");
    const chosenEngine = engines.get(chosen)!;
    assert.deepEqual(chosenEngine.resumed, [ids[1]]);
    assert.match(chosenEngine.rollouts[0] || "", new RegExp(ids[1]));
    assert.equal(chosenEngine.sent.at(-1), "Seguimos en la carpeta elegida");
    chosenEngine.emit({ type: "finished", conversationId: ids[1], status: "completed" });
    await waitFor((m): m is Extract<ServerMessage, { type: "snapshot" }> =>
      m.type === "snapshot" && m.state.workspace === chosen && !m.state.works.some(w => w.busy) && m.state.works[0]?.progress === "Listo.");

    send(chosen, { type: "chooseWorkspace", path: emptyFolder });
    const switchedEmpty = await waitFor((m): m is Extract<ServerMessage, { type: "workspaceChoice" }> => m.type === "workspaceChoice");
    assert.equal(switchedEmpty.problem, undefined);
    const inEmpty = await waitFor((m): m is Extract<ServerMessage, { type: "snapshot" }> =>
      m.type === "snapshot" && m.state.workspace === emptyFolder && m.state.engine.available);
    assert.deepEqual(inEmpty.state.works, []);
    assert.equal(inEmpty.state.codexImportOffer, undefined);

    // Switching back to the chosen folder keeps its imported work and does not offer a second time.
    messages.length = 0;
    send(emptyFolder, { type: "chooseWorkspace", path: chosen });
    const switchedBack = await waitFor((m): m is Extract<ServerMessage, { type: "workspaceChoice" }> => m.type === "workspaceChoice");
    assert.equal(switchedBack.problem, undefined);
    const back = await waitFor((m): m is Extract<ServerMessage, { type: "snapshot" }> =>
      m.type === "snapshot" && m.state.workspace === chosen && m.state.engine.available);
    assert.deepEqual(back.state.works.map(w => w.id), [work.id]);
    assert.equal(back.state.codexImportOffer, undefined);
  } finally {
    socket.terminate();
    await server.close();
  }
});

test("folder switch refuses an import in progress and shutdown recovery preserves transcript and re-enables history", async t => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/codex-history-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }));
  const data = join(root, "data");
  const home = join(root, "default");
  const other = join(root, "other");
  await Promise.all([data, home, other].map(path => mkdir(path, { recursive: true })));

  let releaseImport!: () => void;
  const importingGate = new Promise<void>(done => { releaseImport = done; });
  let started!: () => void;
  const importStarted = new Promise<void>(done => { started = done; });
  let aborted!: () => void;
  const importAborted = new Promise<void>(done => { aborted = done; });
  class BlockingHistory extends CodexHistory {
    override async list() {
      return [];
    }
    override async import(_ids: string[], signal: AbortSignal): Promise<string[]> {
      started();
      await once(signal, "abort", { signal: AbortSignal.timeout(10_000) });
      aborted();
      await importingGate;
      return [];
    }
  }
  class StickyEngine extends FakeEngine {
    attempts = 0;
    override async close(requireStop = false) {
      if (requireStop && this.attempts++ === 0) throw new Error("Still running");
      await super.close();
    }
  }

  const selection = new WorkspaceSelection(home, data);
  const initialEngine = new StickyEngine();
  const engineFor = (choice: WorkspaceChoice) => choice.root === home ? new StickyEngine() : new FakeEngine();
  const server = await serve(
    initialEngine, data, 0, origin, home, undefined, screenSecret,
    { selection, initial: selection.defaultChoice, engineFor },
    new BlockingHistory(root, join(data, "codex")),
  );
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, screenProtocols, { origin });
  const messages: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", raw => {
    messages.push(JSON.parse(String(raw)));
    for (const wake of waiters.splice(0)) wake();
  });
  async function waitFor<T extends ServerMessage>(match: (message: ServerMessage) => message is T): Promise<T> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const idx = messages.findIndex(match);
      if (idx >= 0) return messages.splice(idx, 1)[0] as T;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for server message");
      await new Promise<void>(resolve => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
  const send = (workspace: string, command: ClientCommand) =>
    socket.send(JSON.stringify({ ...command, workspace }));

  try {
    await once(socket, "open");
    await waitFor((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot" && m.state.engine.available);

    send(home, { type: "send", text: "Pedido antes del corte" });
    await waitFor((m): m is Extract<ServerMessage, { type: "selected" }> => m.type === "selected");
    initialEngine.emit({ type: "message", conversationId: "conversation-1", id: "reply", text: "Respuesta parcial", delta: true });
    initialEngine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await waitFor((m): m is Extract<ServerMessage, { type: "snapshot" }> =>
      m.type === "snapshot" && !m.state.works.some(w => w.busy));

    // Start a slow import and confirm a folder switch is refused while it runs.
    send(home, { type: "importCodexChats", ids: [ids[0]] });
    await importStarted;
    send(home, { type: "chooseWorkspace", path: other });
    const refused = await waitFor((m): m is Extract<ServerMessage, { type: "workspaceChoice" }> => m.type === "workspaceChoice");
    assert.match(refused.problem ?? "", /termine el pedido actual/);

    // Now test App.close(true) shutdown ordering when engine.close(true) throws while an import is running.
    initialEngine.emit({ type: "message", conversationId: "conversation-1", id: "reply2", text: "Respuesta en cierre", delta: true });
    const appClosing = server.app.close(true);
    await importAborted;
    const savedPath = join(data, "works.json");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(await readFile(savedPath, "utf8").catch(() => "")).includes("Respuesta en cierre"))
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(await readFile(savedPath, "utf8"), /Respuesta en cierre/);
    releaseImport();
    await assert.rejects(appClosing, /Still running/);

    // After recovery via restartEngine, history commands work again on the same App.
    await server.app.restartEngine(new FakeEngine());
    send(home, { type: "listCodexChats" });
    const listed = await waitFor((m): m is Extract<ServerMessage, { type: "codexChats" }> => m.type === "codexChats");
    assert.deepEqual(listed.chats, []);
  } finally {
    releaseImport();
    socket.terminate();
    await server.close();
  }
});
