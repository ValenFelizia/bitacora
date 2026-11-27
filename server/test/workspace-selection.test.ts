import assert from "node:assert/strict";
import { on, once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { ClientCommand, ServerMessage } from "../src/contracts";
import { serve } from "../src/server";
import { initializeKit } from "../src/tools/kit";
import { protectedWorkspaceFolders } from "../src/protected-folders";
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
    private closeAttempts = 0;
    constructor(readonly root: string, private readonly simulateStop = false) { super(); }
    override async close(requireStop = false) {
      if (requireStop && this.simulateStop && this.closeAttempts++ < 2) throw new Error("Still running");
      await super.close();
    }
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
    const engine = new FolderEngine(choice.root, engines.length === 0);
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

  const templates = (workspace: string, body?: unknown) => fetch(
    `http://127.0.0.1:${server.port}/templates?` + new URLSearchParams({ workspace }),
    body ? { method: "POST", headers: { ...screenHeaders, "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { headers: screenHeaders },
  );
  async function templateNames(workspace: string) {
    const response = await templates(workspace);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).templates.map((template: { name: string }) => template.name);
  }
  try {
    const first = await snapshot(f.home);
    assert.deepEqual(await templateNames(f.home), []);
    const added = await templates(f.home, { kind: "add", name: "Folletos", purpose: "Viajes",
      file: { name: "folleto.html", data: Buffer.from("<h1>Viajes</h1>").toString("base64") } });
    assert.equal(added.status, 200, await added.clone().text());
    assert.deepEqual(await templateNames(f.home), ["Folletos"]);
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
    assert.match((await choiceReply()).problem ?? "", /sigue abierto/);
    const stuck = await snapshot(f.home);
    assert.match(stuck.notice ?? "", /puede cambiar archivos/);
    assert.equal(stuck.engine.exhausted, true);
    assert.equal(engines[0]?.closed, false);
    assert.equal((await selection.load()).choice.root, f.home);
    send(f.home, { type: "retry" });
    await snapshot(f.home, (state) => state.engine.available && engines[0]?.closed === true);
    send(f.home, { type: "chooseWorkspace", path: f.other });
    const inOther = await snapshot(f.other, (state) => state.engine.available);
    assert.deepEqual(inOther.works, []);
    assert.deepEqual(await templateNames(f.other), []);
    assert.equal((await templates(f.home)).status, 409);
    assert.equal(inOther.hasBrand, true);
    assert.equal(inOther.welcome, "done");
    assert.deepEqual(inOther.uses, ["orden"]);
    assert.equal(inOther.panelWidth, 410);
    assert.equal(engines[0]?.closed, true);
    const newEngine = engines.at(-1);
    assert.equal(newEngine?.root, f.other);
    assert.equal((await selection.load()).choice.root, f.other);

    send(f.home, { type: "send", text: "Un pedido de la vista anterior" });
    send(f.other, { type: "send", text: "Prepará una pieza" });
    const finished = await snapshot(f.other, (state) => Boolean(state.undo && state.works.length));
    const work = finished.works[0];
    assert.equal(finished.works.length, 1);
    assert.equal(work.messages[0]?.text, "Prepará una pieza");
    assert.match(newEngine?.instructionNotes[0]?.notes ?? "", /Otra agencia/);
    const result = work.messages.flatMap((message) => message.results ?? [])[0];
    assert.ok(result);
    assert.ok(finished.undo);
    assert.equal(await (await file(result.id)).text(), "Editada desde la carpeta nueva");

    send(f.other, { type: "chooseWorkspace", path: f.home });
    const back = await snapshot(f.home, (state) => state.engine.available);
    assert.deepEqual(back.works.map(({ id }) => id), ["legacy-work"]);
    assert.equal(back.welcome, "skipped");
    assert.deepEqual(await templateNames(f.home), ["Folletos"]);
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

test("legacy kit markers keep skills managed and are upgraded in place", async () => {
  const f = await fixture();
  try {
    await initializeKit(f.home, f.data);
    const marker = join(f.data, (await readdir(f.data)).find(name => name.startsWith("kit-initialized-"))!);
    const skill = join(f.home, ".agents/skills/entrevista/SKILL.md");
    const kit = await readFile(skill, "utf8");
    await writeFile(marker, JSON.stringify({ version: 1, workspace: f.home }));
    await writeFile(skill, "versión anterior");
    assert.deepEqual(await initializeKit(f.home, f.data), {});
    assert.equal(await readFile(skill, "utf8"), kit);
    const updated = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(updated.version, 2);
    assert.equal(updated.status, "ready");
    assert.equal(typeof updated.identity, "string");
  } finally { await f.close(); }
});

test("a resumed kit copy preserves skills added after interruption on every later start", async () => {
  const f = await fixture();
  try {
    await initializeKit(f.home, f.data);
    const marker = join(f.data, (await readdir(f.data)).find(name => name.startsWith("kit-initialized-"))!);
    const state = JSON.parse(await readFile(marker, "utf8"));
    await writeFile(marker, JSON.stringify({ ...state, status: "copying" }));
    const skill = join(f.home, ".agents/skills/entrevista/SKILL.md");
    const missing = join(f.home, ".agents/skills/entender-el-pedido/SKILL.md");
    await writeFile(skill, "Guía agregada después del corte");
    await rm(missing);
    for (let start = 0; start < 2; start++) {
      assert.deepEqual(await initializeKit(f.home, f.data), {});
      assert.equal(await readFile(skill, "utf8"), "Guía agregada después del corte");
      assert.match(await readFile(missing, "utf8"), /name: entender-el-pedido/);
    }
  } finally { await f.close(); }
});

test("protected locations and ancestors or descendants of known workspaces are refused", async () => {
  const f = await fixture();
  try {
    const envPaths = [
      ["Install", "instalación", false], ["Runtime", "instalación", false],
      ["LocalAppData", "guardan datos", true], ["AppData", "guardan datos", true],
      ["Startup", "arrancar", false], ["Profile", "tu cuenta", true],
      ["Windows", "Windows", false], ["Program Files", "programas", false],
    ] as const;
    const protectedFolders = envPaths.map(([name, problem, rootOnly]) => ({ path: join(f.dir, name), problem, rootOnly }));
    for (const { path } of protectedFolders) await mkdir(join(path, "child"), { recursive: true });
    const selection = new WorkspaceSelection(f.home, f.data, protectedFolders);
    for (const { path, problem, rootOnly } of protectedFolders) {
      await assert.rejects(selection.validate(path), new RegExp(problem));
      if (!rootOnly) await assert.rejects(selection.validate(join(path, "child")), new RegExp(problem));
    }
    await assert.rejects(selection.validate(parse(f.dir).root), /disco entero/);
    const known = join(f.other, "known");
    await mkdir(join(known, "child"), { recursive: true });
    await selection.save(await selection.validate(known));
    await selection.save(await selection.validate(f.home));
    const reopened = new WorkspaceSelection(f.home, f.data, protectedFolders);
    await assert.rejects(reopened.validate(f.other), /otra carpeta de trabajo/);
    await assert.rejects(reopened.validate(join(known, "child")), /otra carpeta de trabajo/);
    assert.equal((await reopened.validate(known)).root, known);
    const alias = join(f.dir, "runtime-alias");
    await symlink(join(f.dir, "Runtime", "child"), alias, "junction");
    await assert.rejects(reopened.validate(alias), /instalación/);
  } finally { await f.close(); }
});

test("startup restores the default folder when a saved folder cannot start", async () => {
  const f = await fixture();
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const selection = new WorkspaceSelection(f.home, f.data);
    const initial = await selection.validate(f.other);
    await selection.save(initial);
    class BrokenEngine extends FakeEngine {
      override async start() { throw new Error("Could not start in the saved folder"); }
    }
    const savedEngine = new BrokenEngine();
    const engineFor = () => new FakeEngine();
    server = await serve(savedEngine, f.data, 0, origin, initial.root, undefined, screenSecret, { selection, initial, engineFor });
    assert.equal(savedEngine.closed, true);
    assert.equal(server.app.snapshot().workspace, f.home);
    assert.equal(server.app.snapshot().engine.available, true);
    assert.match(server.app.snapshot().notice ?? "", /No pude abrir la última carpeta/);
    assert.equal((await selection.load()).choice.root, f.other);
  } finally {
    await server?.close();
    await f.close();
  }
});

test("Windows protected locations cover install, appdata, startup, profile and system folders", {
  skip: process.platform !== "win32",
}, async () => {
  const f = await fixture();
  try {
    const appDir = join(f.dir, "app-install");
    await mkdir(appDir, { recursive: true });
    const list = protectedWorkspaceFolders([appDir]);
    const selection = new WorkspaceSelection(f.home, f.data, list);
    await assert.rejects(selection.validate(appDir), /instalación/);
    if (process.env.LOCALAPPDATA)
      await assert.rejects(selection.validate(process.env.LOCALAPPDATA), /guardan datos/);
    if (process.env.APPDATA)
      await assert.rejects(selection.validate(process.env.APPDATA), /guardan datos/);
    const startupEntry = list.find(entry => /arrancar/.test(entry.problem));
    assert.ok(startupEntry);
    const profileEntry = list.find(entry => /tu cuenta/.test(entry.problem));
    assert.ok(profileEntry?.rootOnly);
    const windowsEntry = list.find(entry => /guarda programas/.test(entry.problem));
    assert.ok(windowsEntry);
  } finally {
    await f.close();
  }
});
