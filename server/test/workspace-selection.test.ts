import assert from "node:assert/strict";
import { on, once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { ClientCommand, ServerMessage } from "../src/contracts";
import { serve } from "../src/server";
import { initializeKit } from "../src/tools/kit";
import { WorkspaceSelection, type WorkspaceChoice } from "../src/workspace-selection";
import { FakeEngine } from "./fake-engine";
import { screenHeaders, screenProtocols, screenSecret } from "./screen-fixture";

const origin = "http://127.0.0.1:5173";

async function fixture() {
  await mkdir(".local", { recursive: true });
  const dir = await realpath(await mkdtemp(resolve(".local/workspace-")));
  const home = join(dir, "default");
  const other = join(dir, "Agencia ñ");
  const data = join(dir, "..app-data");
  await Promise.all([home, other, data].map((path) => mkdir(path)));
  return { dir, home, other, data, close: () => rm(dir, { recursive: true, force: true }) };
}

test("a folder with its own files gets missing kit skills only, including on later starts", async () => {
  const { other, data, close } = await fixture();
  try {
    const own = {
      "AGENTS.md": "Reglas propias",
      "plantilla/pieza.html": "<p>Plantilla de la agencia</p>",
      "marca/datos.md": "Marca propia",
      "perfil.md": "Perfil propio",
      ".agents/skills/entrevista/SKILL.md": "Guía de la agencia",
    };
    for (const [path, contents] of Object.entries(own)) {
      await mkdir(dirname(join(other, path)), { recursive: true });
      await writeFile(join(other, path), contents);
    }
    for (let start = 0; start < 2; start++) {
      assert.deepEqual(await initializeKit(other, data), {});
      assert.deepEqual((await readdir(other)).sort(), [".agents", "AGENTS.md", "marca", "perfil.md", "plantilla"]);
      for (const [path, contents] of Object.entries(own))
        assert.equal(await readFile(join(other, path), "utf8"), contents);
      assert.match(await readFile(join(other, ".agents/skills/entender-el-pedido/SKILL.md"), "utf8"), /name: entender-el-pedido/);
    }
  } finally { await close(); }
});

test("changing folders keeps legacy works, profiles, results and undo with their own folders", async () => {
  const f = await fixture();
  const selection = new WorkspaceSelection(f.home, f.data);
  await mkdir(join(f.other, "marca"));
  await writeFile(join(f.other, "marca/datos.md"), "Marca de la nueva agencia");
  await writeFile(join(f.other, "perfil.md"), "# Perfil\n\n- **Agencia:** Otra agencia\n- **Usos:** orden\n");
  const homeFile = join(f.home, "pieza.pdf");
  const otherFile = join(f.other, "pieza.pdf");
  await writeFile(homeFile, "Default original");
  await writeFile(otherFile, "Otra original");
  const date = new Date().toISOString();
  await writeFile(join(f.data, "works.json"), JSON.stringify({
    version: 1,
    works: [{
      id: "legacy-work", title: "Trabajo anterior", createdAt: date, updatedAt: date,
      messages: [], details: "", progress: "", conversationId: "legacy-conversation",
    }],
  }));
  await writeFile(join(f.data, "settings.json"), JSON.stringify({ version: 1, welcome: "skipped", panelWidth: 410 }));

  class FolderEngine extends FakeEngine {
    constructor(readonly root: string) { super(); }
    override async send(id: string, text: string) {
      await super.send(id, text);
      if (this.root === f.other) {
        await writeFile(join(this.root, "pieza.pdf"), "Editada desde la carpeta nueva");
        this.emit({ type: "finished", conversationId: id, status: "completed" });
      }
    }
  }
  const engines: FolderEngine[] = [];
  const engineFor = (choice: WorkspaceChoice) => {
    const engine = new FolderEngine(choice.root);
    engines.push(engine);
    return engine;
  };
  const initial = selection.defaultChoice;
  const server = await serve(engineFor(initial), f.data, 0, origin, f.home, undefined, screenSecret, { selection, initial, engineFor });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, screenProtocols, { origin });
  const messages = on(socket, "message", { signal: AbortSignal.timeout(15_000) });
  async function nextMessage(): Promise<ServerMessage> {
    const result = await messages.next();
    assert.ok(!result.done);
    return JSON.parse(String(result.value[0]));
  }
  async function snapshot(workspace: string, accept: (state: Extract<ServerMessage, { type: "snapshot" }>["state"]) => boolean = () => true) {
    for (;;) {
      const message = await nextMessage();
      if (message.type === "snapshot" && message.state.workspace === workspace && accept(message.state)) return message.state;
    }
  }
  async function choiceReply() {
    for (;;) {
      const message = await nextMessage();
      if (message.type === "workspaceChoice") return message;
    }
  }
  const send = (workspace: string, command: ClientCommand) => socket.send(JSON.stringify({ ...command, workspace }));
  const file = (id: string) => fetch(`http://127.0.0.1:${server.port}/files?id=${id}`, { headers: screenHeaders });

  try {
    const first = await snapshot(f.home);
    assert.equal(first.works[0]?.id, "legacy-work");
    assert.equal(first.welcome, "skipped");

    for (const path of [f.dir, f.data]) {
      send(f.home, { type: "chooseWorkspace", path });
      assert.match((await choiceReply()).problem ?? "", /datos de Bitácora/);
    }
    send(f.home, { type: "chooseWorkspace", path: join(f.dir, "ausente") });
    assert.match((await choiceReply()).problem ?? "", /No encontré esa carpeta/);

    send(f.home, { type: "send", workId: "legacy-work", text: "Pedido en curso" });
    await snapshot(f.home, (state) => state.works.some((work) => work.busy));
    send(f.home, { type: "chooseWorkspace", path: f.other });
    assert.match((await choiceReply()).problem ?? "", /termine el pedido actual/);
    send(f.home, { type: "interrupt", workId: "legacy-work" });
    await snapshot(f.home, (state) => !state.works.some((work) => work.busy));

    send(f.home, { type: "chooseWorkspace", path: f.other });
    const inOther = await snapshot(f.other, (state) => state.engine.available);
    assert.deepEqual(inOther.works, []);
    assert.equal(inOther.hasBrand, true);
    assert.equal(inOther.welcome, "done");
    assert.deepEqual(inOther.uses, ["orden"]);
    assert.equal(inOther.panelWidth, 410);
    assert.equal(engines[0]?.closed, true);
    assert.equal(engines[1]?.root, f.other);
    assert.equal((await selection.load()).choice.root, f.other);

    send(f.home, { type: "send", text: "Un pedido de la vista anterior" });
    send(f.other, { type: "send", text: "Prepará una pieza" });
    const finished = await snapshot(f.other, (state) => Boolean(state.undo && state.works.length));
    const work = finished.works[0];
    assert.equal(finished.works.length, 1);
    assert.equal(work.messages[0]?.text, "Prepará una pieza");
    assert.match(engines[1]?.instructionNotes[0]?.notes ?? "", /Otra agencia/);
    const result = work.messages.flatMap((message) => message.results ?? [])[0];
    assert.ok(result);
    assert.ok(finished.undo);
    assert.equal(await (await file(result.id)).text(), "Editada desde la carpeta nueva");

    send(f.other, { type: "chooseWorkspace", path: f.home });
    const back = await snapshot(f.home, (state) => state.engine.available);
    assert.deepEqual(back.works.map(({ id }) => id), ["legacy-work"]);
    assert.equal(back.welcome, "skipped");
    assert.equal((await file(result.id)).status, 404);

    send(f.home, { type: "chooseWorkspace", path: f.other });
    const returned = await snapshot(f.other, (state) => state.engine.available);
    assert.deepEqual(returned.works.map(({ id }) => id), [work.id]);
    assert.equal(returned.undo?.id, finished.undo.id);
    send(f.other, { type: "undo", id: finished.undo.id });
    await snapshot(f.other, (state) => state.notice?.startsWith("Listo. Deshice") ?? false);
    assert.equal(await readFile(otherFile, "utf8"), "Otra original");
    assert.equal(await readFile(homeFile, "utf8"), "Default original");
    assert.equal(await readFile(join(f.other, "marca/datos.md"), "utf8"), "Marca de la nueva agencia");
  } finally {
    const disconnected = once(socket, "close");
    socket.terminate();
    await disconnected;
    await messages.return?.();
    await server.close();
    await f.close();
  }
});

test("junctions into app data are refused and a missing saved folder falls back to the default", async () => {
  const f = await fixture();
  try {
    const selection = new WorkspaceSelection(f.home, f.data);
    const alias = join(f.dir, "alias");
    await symlink(f.data, alias, "junction");
    await assert.rejects(selection.validate(alias), /datos de Bitácora/);
    const folder = await selection.validate(f.other);
    await selection.save(folder);
    await rmdir(f.other);
    const loaded = await selection.load();
    assert.equal(loaded.choice.root, f.home);
    assert.match(loaded.notice ?? "", /No pude abrir la última carpeta/);
  } finally { await f.close(); }
});
