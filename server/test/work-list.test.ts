import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { App } from "../src/app";
import { CodexHistory, type ImportedChat } from "../src/codex/history";
import type { ServerMessage, Work } from "../src/contracts";
import { WorkspaceFiles } from "../src/workspace-files";
import { FakeEngine } from "./fake-engine";

/**
 * A saved work with a fixed last activity. Dates are from 2020 so any real
 * clock is newer, whatever the day the tests run.
 */
function savedWork(id: string, updatedAt: string, createdAt = updatedAt): Work & { conversationId: string } {
  return {
    id,
    conversationId: "conversation-" + id,
    title: "Chat " + id,
    createdAt,
    updatedAt,
    messages: [],
    details: "",
    busy: false,
    progress: "",
  };
}

async function fixture(works: (Work & { conversationId: string })[]) {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/work-list-"));
  await writeFile(join(dir, "works.json"), JSON.stringify({ version: 1, works }), "utf8");
  const engine = new FakeEngine();
  const messages: ServerMessage[] = [];
  const app = new App(engine, dir, (message) => messages.push(message));
  await app.start();
  return {
    dir,
    engine,
    app,
    messages,
    reply: (message: ServerMessage) => messages.push(message),
  };
}

const ids = (app: App) => app.snapshot().works.map((work) => work.id);

test("the sidebar goes from the newest activity to the oldest, and writing to an old chat moves it up", async () => {
  const f = await fixture([
    savedWork("viejo", "2020-01-01T10:00:00.000Z"),
    savedWork("empate-a", "2020-05-01T10:00:00.000Z"),
    savedWork("empate-b", "2020-05-01T10:00:00.000Z"),
    savedWork("nuevo", "2020-09-01T10:00:00.000Z"),
  ]);
  try {
    // Equal dates keep the order they already had: nothing jumps on a tie.
    assert.deepEqual(ids(f.app), ["nuevo", "empate-a", "empate-b", "viejo"]);

    await f.app.command({ type: "send", workId: "viejo", text: "Sigo con este" }, f.reply);
    assert.deepEqual(ids(f.app), ["viejo", "nuevo", "empate-a", "empate-b"]);

    // The answer counts as activity too.
    f.engine.emit({ type: "message", conversationId: "conversation-empate-b", id: "a", text: "Hola.", delta: false });
    assert.deepEqual(ids(f.app), ["empate-b", "viejo", "nuevo", "empate-a"]);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a chat marked as ready waits in Listos, is saved with the folder, and comes back when written to", async () => {
  const f = await fixture([
    savedWork("viejo", "2020-01-01T10:00:00.000Z"),
    savedWork("nuevo", "2020-09-01T10:00:00.000Z"),
  ]);
  let restarted: App | undefined;
  try {
    await f.app.command({ type: "setReady", workId: "viejo", ready: true }, f.reply);
    const marked = f.app.snapshot().works.find((work) => work.id === "viejo")!;
    assert.equal(marked.ready, true);
    // Marking is not activity: the chat keeps its date and its place in the order.
    assert.equal(marked.updatedAt, "2020-01-01T10:00:00.000Z");
    assert.deepEqual(ids(f.app), ["nuevo", "viejo"]);
    await f.app.close();

    const engine = new FakeEngine();
    restarted = new App(engine, f.dir, () => {});
    await restarted.start();
    assert.equal(restarted.snapshot().works.find((work) => work.id === "viejo")!.ready, true);
    assert.equal(restarted.snapshot().works.find((work) => work.id === "nuevo")!.ready, undefined);

    // «Volver a la lista» clears the mark and keeps everything else.
    await restarted.command({ type: "setReady", workId: "viejo", ready: false }, () => {});
    assert.equal(restarted.snapshot().works.find((work) => work.id === "viejo")!.ready, undefined);
    assert.equal(restarted.snapshot().works.find((work) => work.id === "viejo")!.messages.length, 0);

    // A chat written to comes back to the main list on its own.
    await restarted.command({ type: "setReady", workId: "viejo", ready: true }, () => {});
    assert.equal(restarted.snapshot().works.find((work) => work.id === "viejo")!.ready, true);
    await restarted.command({ type: "send", workId: "viejo", text: "Una vuelta más" }, () => {});
    const written = restarted.snapshot().works.find((work) => work.id === "viejo")!;
    assert.equal(written.ready, undefined);
    assert.equal(ids(restarted)[0], "viejo");
    assert.equal(written.messages.length, 1);
  } finally {
    await restarted?.close();
    await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("chats sort by the instant of the date, including timezones and dates that do not parse", async () => {
  // The three June rows are the same instant written three ways. August is only
  // on the creation date: the activity date does not parse. The last row has
  // neither date.
  const f = await fixture([
    savedWork("viejo", "2020-03-01T10:00:00.000Z"),
    savedWork("mismo-ms", "2020-06-01T10:00:00.000Z"),
    savedWork("mismo-texto", "2020-06-01T10:00:00Z"),
    savedWork("mismo-huso", "2020-06-01T12:00:00+02:00"),
    savedWork("tarde", "2020-06-01T15:00:00-03:00"),
    savedWork("respaldo", "", "2020-08-01T00:00:00.000Z"),
    savedWork("roto", "no-es-fecha", "tampoco"),
    savedWork("nuevo", "2020-12-01T00:00:00Z"),
  ]);
  try {
    assert.deepEqual(ids(f.app), [
      "nuevo",
      "respaldo",
      "tarde",
      "mismo-ms",
      "mismo-texto",
      "mismo-huso",
      "viejo",
      "roto",
    ]);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a title, a detail or a progress line does not move a chat, and renaming it does not either", async () => {
  const f = await fixture([
    savedWork("quieto", "2020-01-01T10:00:00.000Z"),
    savedWork("nuevo", "2020-09-01T10:00:00.000Z"),
  ]);
  try {
    const before = f.app.snapshot().works.find((work) => work.id === "quieto")!.updatedAt;
    f.engine.emit({ type: "title", conversationId: "conversation-quieto", title: "Otro nombre" });
    f.engine.emit({ type: "detail", conversationId: "conversation-quieto", text: "Una nota." });
    f.engine.emit({ type: "progress", conversationId: "conversation-quieto", activity: "reading" });
    const quiet = f.app.snapshot().works.find((work) => work.id === "quieto")!;
    assert.equal(quiet.title, "Otro nombre");
    assert.equal(quiet.updatedAt, before);
    assert.deepEqual(ids(f.app), ["nuevo", "quieto"]);

    await f.app.command({ type: "rename", workId: "quieto", title: "Elegido por mí" }, f.reply);
    assert.equal(f.app.snapshot().works.find((work) => work.id === "quieto")!.updatedAt, before);
    assert.equal(f.app.snapshot().works.find((work) => work.id === "quieto")!.title, "Elegido por mí");
    assert.deepEqual(ids(f.app), ["nuevo", "quieto"]);

    f.engine.emit({ type: "message", conversationId: "conversation-quieto", id: "m", text: "Listo.", delta: false });
    assert.notEqual(f.app.snapshot().works.find((work) => work.id === "quieto")!.updatedAt, before);
    assert.equal(ids(f.app)[0], "quieto");
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a file that shows up moves the chat, and a progress or title afterwards does not", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/work-list-result-"));
  const data = join(root, "data");
  const workspace = new WorkspaceFiles(join(root, "Agencia"));
  await workspace.initialize();
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "works.json"), JSON.stringify({
    version: 1,
    works: [
      savedWork("quieto", "2020-01-01T10:00:00.000Z"),
      savedWork("nuevo", "2020-09-01T10:00:00.000Z"),
    ],
  }), "utf8");
  const engine = new FakeEngine();
  const app = new App(engine, data, () => {}, undefined, workspace);
  try {
    await app.start();
    await app.command({ type: "send", workId: "quieto", text: "Seguimos" }, () => {});
    const sentAt = app.snapshot().works.find((work) => work.id === "quieto")!.updatedAt;
    assert.equal(ids(app)[0], "quieto");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(workspace.root, "plano.pdf"), "%PDF-1.4");
    engine.emit({ type: "finished", conversationId: "conversation-quieto", status: "completed" });
    await until(() => app.snapshot().works.find((work) => work.id === "quieto")!.busy === false);
    const withFile = app.snapshot().works.find((work) => work.id === "quieto")!;
    assert.equal(withFile.messages[0].results?.length, 1);
    assert.notEqual(withFile.updatedAt, sentAt);
    const atFile = withFile.updatedAt;
    engine.emit({ type: "progress", conversationId: "conversation-quieto", activity: "writing" });
    engine.emit({ type: "title", conversationId: "conversation-quieto", title: "Plano" });
    engine.emit({ type: "detail", conversationId: "conversation-quieto", text: "nota" });
    assert.equal(app.snapshot().works.find((work) => work.id === "quieto")!.updatedAt, atFile);
    assert.equal(ids(app)[0], "quieto");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a chat cannot be marked ready while its message is still being sent", async () => {
  const f = await fixture([
    savedWork("uno", "2020-01-01T10:00:00.000Z"),
    savedWork("otro", "2020-05-01T10:00:00.000Z"),
  ]);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const account = f.engine.account.bind(f.engine);
  f.engine.account = () => held.then(() => account());
  const sending = f.app.command({ type: "send", workId: "uno", text: "Sigo" }, f.reply);
  try {
    f.messages.length = 0;
    await f.app.command({ type: "setReady", workId: "uno", ready: true }, f.reply);
    assert.equal(f.app.snapshot().works.find((work) => work.id === "uno")!.ready, undefined);
    const problem = f.messages.find((message) => message.type === "problem");
    assert.match(problem && problem.type === "problem" ? problem.text : "", /termine el pedido/);
    // Another chat is not the one being sent, so it can still be marked.
    await f.app.command({ type: "setReady", workId: "otro", ready: true }, f.reply);
    assert.equal(f.app.snapshot().works.find((work) => work.id === "otro")!.ready, true);

    release();
    await sending;
    const sent = f.app.snapshot().works.find((work) => work.id === "uno")!;
    assert.equal(sent.busy, true);
    assert.equal(sent.ready, undefined);
  } finally {
    release();
    await sending.catch(() => {});
    await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a refused second send does not clear the first send, so the chat still cannot be marked ready", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/work-list-sending-"));
  const data = join(root, "data");
  const workspace = join(root, "Agencia");
  const kit = join(root, "kit");
  await mkdir(data, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(kit, { recursive: true });
  await writeFile(join(data, "works.json"), JSON.stringify({
    version: 1,
    works: [savedWork("uno", "2020-01-01T10:00:00.000Z"), savedWork("otro", "2020-05-01T10:00:00.000Z")],
  }), "utf8");
  // A junction in the kit makes the first copy fail, so the next send retries
  // it. Two sends can overlap in that wait.
  await writeFile(join(kit, "AGENTS.md"), "Instrucciones del kit");
  await symlink(data, join(kit, "ejemplo"), "junction");
  const engine = new FakeEngine();
  const problems: ServerMessage[] = [];
  const reply = (message: ServerMessage) => {
    if (message.type === "problem") problems.push(message);
  };
  const app = new App(engine, data, () => {}, undefined, new WorkspaceFiles(workspace), kit);
  let release = () => {};
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  let first: Promise<unknown> = Promise.resolve();
  let second: Promise<unknown> = Promise.resolve();
  try {
    await app.start();
    const marker = (await readdir(data)).find((name) => name.startsWith("kit-initialized-"));
    assert.match(marker ? await readFile(join(data, marker), "utf8") : "", /"status":"copying"/);
    await rmdir(join(kit, "ejemplo"));
    await mkdir(join(kit, "ejemplo"));
    await writeFile(join(kit, "ejemplo", "pieza.html"), "Ejemplo");
    const account = engine.account.bind(engine);
    engine.account = () => held.then(() => account());

    first = app.command({ type: "send", workId: "uno", text: "Primero" }, reply);
    second = app.command({ type: "send", workId: "uno", text: "Segundo" }, reply);
    await second;
    const refused = problems.at(-1);
    assert.match(refused && refused.type === "problem" ? refused.text : "", /pedido actual/);
    // The first send has not reached `busy` yet. Only its marker can block the mark.
    assert.equal(app.snapshot().works.find((work) => work.id === "uno")!.busy, false);
    problems.length = 0;
    await app.command({ type: "setReady", workId: "uno", ready: true }, reply);
    assert.equal(app.snapshot().works.find((work) => work.id === "uno")!.ready, undefined);
    const blocked = problems.at(-1);
    assert.match(blocked && blocked.type === "problem" ? blocked.text : "", /termine el pedido/);
    // The other chat was not the one being sent.
    await app.command({ type: "setReady", workId: "otro", ready: true }, reply);
    assert.equal(app.snapshot().works.find((work) => work.id === "otro")!.ready, true);
  } finally {
    release();
    await first.catch(() => {});
    await second.catch(() => {});
    await app.close();
    await rmdir(join(kit, "ejemplo")).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("marking a chat ready only accepts true or false", async () => {
  const f = await fixture([savedWork("uno", "2020-01-01T10:00:00.000Z")]);
  try {
    await assert.rejects(
      () => f.app.command({ type: "setReady", workId: "uno", ready: "si" as unknown as boolean }, f.reply),
      /Invalid ready/,
    );
    assert.equal(f.app.snapshot().works[0].ready, undefined);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a chat with a request in progress cannot be marked as ready", async () => {
  const f = await fixture([savedWork("uno", "2020-01-01T10:00:00.000Z")]);
  try {
    await f.app.command({ type: "send", text: "Un pedido" }, f.reply);
    const work = f.app.snapshot().works[0];
    assert.equal(work.busy, true);
    f.messages.length = 0;

    await f.app.command({ type: "setReady", workId: work.id, ready: true }, f.reply);
    assert.equal(f.app.snapshot().works[0].ready, undefined);
    const problem = f.messages.find((message) => message.type === "problem");
    assert.match(problem && problem.type === "problem" ? problem.text : "", /termine el pedido/);

    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await f.app.command({ type: "setReady", workId: work.id, ready: true }, f.reply);
    assert.equal(f.app.snapshot().works[0].ready, true);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

/** A history whose chats carry the date Codex had for them, without launching Codex. */
class DatedHistory extends CodexHistory {
  constructor(private chats: Record<string, ImportedChat>) {
    super(join("unused-source"), join("unused-home"));
  }
  override async list() {
    return [];
  }
  override async import(selected: string[], _signal: AbortSignal, accept: (chat: ImportedChat) => void) {
    for (const id of selected) accept(this.chats[id]);
    return [];
  }
}

test("chats brought from Codex keep their original date and are ordered by it, not by import time", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/work-list-codex-"));
  const data = join(root, "data");
  const workspace = join(root, "Agencia");
  await mkdir(workspace);
  const chats: Record<string, ImportedChat> = {
    "codex-viejo": {
      id: "codex-viejo",
      title: "Chat de marzo",
      date: "2020-03-01T10:00:00.000Z",
      createdAt: "2020-02-01T10:00:00.000Z",
      messages: [{ id: "m1", role: "user", text: "Guardá la palabra jacarandá." }],
      rollout: "sessions/2020/03/01/rollout-codex-viejo.jsonl",
    },
    "codex-nuevo": {
      id: "codex-nuevo",
      title: "Chat de diciembre",
      date: "2020-12-01T10:00:00.000Z",
      createdAt: "2020-11-01T10:00:00.000Z",
      messages: [{ id: "m2", role: "user", text: "Guardá la palabra lapacho." }],
      rollout: "sessions/2020/12/01/rollout-codex-nuevo.jsonl",
    },
  };
  const engine = new FakeEngine();
  const rejected: ServerMessage[] = [];
  const app = new App(engine, data, () => {}, undefined, new WorkspaceFiles(workspace),
    undefined, undefined, new DatedHistory(chats));
  try {
    await app.start();
    await app.command({ type: "importCodexChats", ids: ["codex-viejo", "codex-nuevo"] }, (message) => rejected.push(message));
    assert.equal(rejected.some((message) => message.type === "problem"), false);
    const imported = app.snapshot().works;
    assert.deepEqual(imported.map((work) => work.title), ["Chat de diciembre", "Chat de marzo"]);
    for (const work of imported) {
      const original = work.title === "Chat de diciembre" ? "codex-nuevo" : "codex-viejo";
      assert.equal(work.updatedAt, chats[original].date);
    }

    // A chat started now goes above the imported ones.
    await app.command({ type: "send", text: "Un trabajo de hoy" }, (message) => rejected.push(message));
    assert.equal(app.snapshot().works[0].title, "Un trabajo de hoy");
    assert.deepEqual(app.snapshot().works.slice(1).map((work) => work.title), ["Chat de diciembre", "Chat de marzo"]);

    const saved = JSON.parse(await readFile(join(data, "works.json"), "utf8"));
    const savedOld = saved.works.find((work: { title: string }) => work.title === "Chat de marzo");
    assert.equal(savedOld.updatedAt, chats["codex-viejo"].date);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
