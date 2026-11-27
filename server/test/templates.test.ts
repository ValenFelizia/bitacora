import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { BACKUP_LIMITS, Backups } from "../src/backups";
import { AGENCY_DEVELOPER_INSTRUCTIONS } from "../src/agency-environment";
import { handleTemplates } from "../src/templates-http";
import { DamagedTemplates, recoveredTemplatePurpose, TemplateProblem, Templates, type Template } from "../src/templates";
import { AgencyFiles } from "../src/tools/paths";
import { lockForWriting } from "./locks";

async function fixture() {
  await mkdir(".local", { recursive: true });
  const base = await mkdtemp(resolve(".local", "templates-"));
  const workspace = join(base, "workspace");
  await mkdir(workspace);
  const files = new AgencyFiles(workspace);
  const templates = new Templates(files);
  const backups = new Backups(workspace, join(base, "data"));
  return { files, templates, backups, close: () => rm(base, { recursive: true, force: true }) };
}
const execFileAsync = promisify(execFile);
const metadata = { name: "Cotización", purpose: "Viajes", origin: "manual" as const };
const upload = (name: string, text: string) => ({ name, data: Buffer.from(text).toString("base64") });

test("catalogue can add, rename, replace and remove files, and preserves a damaged index", async () => {
  const { files, templates, close } = await fixture();
  try {
    assert.deepEqual(await templates.list(), []);
    const first = await templates.add(metadata, [templates.fromUpload(upload("primera.html", "<h1>Viaje</h1>"))]);
    assert.equal(first.origin, "manual");
    const renamed = await templates.update(first.id, { name: "Cotización semanal" });
    assert.equal(renamed.id, first.id);
    assert.equal(renamed.version, first.version);
    assert.equal(renamed.createdAt, first.createdAt);
    assert.equal(renamed.name, "Cotización semanal");
    const [original] = (await templates.describe(first.id)).paths;
    assert.equal(await files.read(original), "<h1>Viaje</h1>");
    const replaced = await templates.update(first.id, {}, { kind: "primary", file: templates.fromUpload(upload("segunda.txt", "Nueva")) });
    assert.equal(replaced.id, first.id);
    await assert.rejects(templates.open(first.id, first.version, "primera.html"));
    await assert.rejects(files.read(original), { code: "ENOENT" });
    const [replacement] = (await templates.describe(first.id)).paths;
    assert.equal((await templates.open(first.id, replaced.version, "segunda.txt")).bytes.toString(), "Nueva");
    await assert.rejects(templates.open(first.id, replaced.version, "../index.json"));
    await templates.remove(first.id);
    assert.deepEqual(await templates.list(), []);
    await assert.rejects(files.read(replacement), { code: "ENOENT" });
    const bundle = await templates.add(metadata, [
      templates.fromUpload(upload("modelo.html", "<h1>Modelo</h1>")),
      templates.fromUpload(upload("referencia.pdf", "%PDF-original")),
    ]);
    const nextBundle = await templates.update(bundle.id, {}, {
      kind: "primary", file: templates.fromUpload(upload("remplazo.html", "<h1>Otro modelo</h1>")),
    });
    assert.deepEqual(nextBundle.files, ["remplazo.html", "referencia.pdf"]);
    await assert.rejects(templates.remove(bundle.id, bundle), /La plantilla cambió/);
    await templates.remove(bundle.id, nextBundle);
    const indexPath = ".bitacora/plantillas/index.json";
    for (const damaged of ["{", '{"version":1,"templates":[{"id":"../escape"}]}']) {
      await files.write(indexPath, damaged, false);
      await assert.rejects(templates.list(), /No pude leer la lista/);
      await assert.rejects(templates.add(metadata, [templates.fromUpload(upload("otra.txt", "otra"))]), /No pude leer la lista/);
      assert.equal(await files.read(indexPath), damaged);
    }
  } finally { await close(); }
});

test("template files are copied and undo restores the catalogue and its bundles together", async () => {
  const { files, templates, backups, close } = await fixture();
  const data = (name: string) => [templates.fromUpload(upload(name, name))];
  try {
    await files.write(".bitacora/privado.txt", "fuera de la copia");
    await backups.initialize();
    const request = { workId: "work", title: "Cotización", request: "Cambiar plantilla" };
    assert.equal(await backups.before(request), true);
    const first = await templates.add({ ...metadata, origin: "agent" }, data("modelo.txt"));
    assert.equal(await backups.finish(), true);
    assert.equal(Object.keys(backups.lastScan!.entries).some(path => path.endsWith("privado.txt")), false);
    assert.equal(Object.keys(backups.lastScan!.entries).some(path => path.endsWith("modelo.txt")), true);
    assert.equal(backups.files.isResult(".bitacora/plantillas/id/resultado.pdf"), false);
    await backups.undo(backups.target!.id);
    assert.deepEqual(await templates.list(), []);
    assert.equal(await files.read(".bitacora/privado.txt"), "fuera de la copia");

    const second = await templates.add(metadata, data("previa.txt"));
    await backups.before(request);
    const changed = await templates.update(second.id, {}, { kind: "bundle", files: data("nueva.txt") });
    assert.equal(await backups.finish(), true);
    await backups.undo(backups.target!.id);
    assert.equal((await templates.open(second.id, second.version, "previa.txt")).bytes.toString(), "previa.txt");
    await assert.rejects(templates.open(changed.id, changed.version, "nueva.txt"));

    await backups.before(request);
    const later = await templates.update(second.id, {}, { kind: "bundle", files: data("agente.txt") });
    assert.equal(await backups.finish(), true);
    await templates.update(second.id, { name: "Renombrada después" });
    const undo = await backups.undo(backups.target!.id);
    assert.ok(undo.skipped.includes("index.json"));
    assert.equal((await templates.describe(second.id)).name, "Renombrada después");
    assert.equal((await templates.open(later.id, later.version, "agente.txt")).bytes.toString(), "agente.txt");
    assert.notEqual(first.id, second.id);
  } finally { await close(); }
});

test("the app and relevant kit skills require consulting templates before creating", async () => {
  const agents = await readFile("kit/turismo/AGENTS.md", "utf8");
  const skills = await Promise.all(
    ["entender-el-pedido", "entrevista"].map(skill =>
      readFile("kit/turismo/.agents/skills/" + skill + "/SKILL.md", "utf8"))
  );
  for (const policy of [AGENCY_DEVELOPER_INSTRUCTIONS, agents, ...skills]) {
    assert.match(policy, /listar_plantillas[\s\S]*?leer_plantilla[\s\S]*?request_user_input/);
    assert.match(policy, /Las plantillas\s+de\s+`plantillas\/`\s+se usan\s+solo si el catálogo no tiene ninguna que sirva/);
    assert.match(policy, /No edites el índice a mano/);
    assert.match(policy, /sumar_plantilla/);
    assert.match(policy, /actualizar_plantilla/);
  }
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /Antes de crear[^.]+listar_plantillas/);
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /mirá el original con mirar_pdf[\s\S]*?Dibujalo con dibujar[\s\S]*?compará todas las páginas/);
});

test("a damaged catalogue can be set aside and rebuilt from the folders on disk", async () => {
  const { files, templates, close } = await fixture();
  try {
    const folder = randomUUID();
    const single = randomUUID();
    await files.write(`.bitacora/plantillas/${folder}/modelo.html`, "<h1>Modelo</h1>");
    await files.write(`.bitacora/plantillas/${folder}/notas.txt`, "sigue acá");
    await mkdir(join(files.root, ".bitacora", "plantillas", folder, "foto.png"));
    await files.write(`.bitacora/plantillas/${single}-nota.txt`, "suelta");
    await files.write(".bitacora/plantillas/suelto.txt", "no es plantilla");
    const indexPath = ".bitacora/plantillas/index.json";
    const damaged = '{"version":1,"templates":[{"id":"../escape"}]}';
    await files.write(indexPath, damaged, false);
    await assert.rejects(templates.list(), /No pude leer la lista/);
    await assert.rejects(templates.add(metadata, [templates.fromUpload(upload("otra.txt", "otra"))]), /No pude leer la lista/);
    assert.equal(await files.read(indexPath), damaged);

    const rebuilt = await templates.recover();
    assert.equal(rebuilt.length, 2);
    const bundle = rebuilt.find(item => item.version === folder);
    const loose = rebuilt.find(item => item.version === single);
    assert.ok(bundle && loose);
    assert.equal(bundle.name, "modelo");
    assert.equal(bundle.purpose, recoveredTemplatePurpose);
    assert.deepEqual(bundle.files, ["modelo.html", "notas.txt"]);
    assert.equal(loose.name, "nota");
    assert.equal((await templates.open(bundle.id, bundle.version, "modelo.html")).bytes.toString(), "<h1>Modelo</h1>");
    assert.equal((await templates.open(loose.id, loose.version, "nota.txt")).bytes.toString(), "suelta");
    assert.equal(await files.read(".bitacora/plantillas/suelto.txt"), "no es plantilla");
    const aside = (await readdir(join(files.root, ".bitacora/plantillas"))).filter(name => name.startsWith("index-apartado-"));
    assert.equal(aside.length, 1);
    assert.equal(await files.read(".bitacora/plantillas/" + aside[0]), damaged);
    assert.equal(JSON.parse(await files.read(indexPath)).templates.length, 2);
    assert.doesNotMatch(await files.read(indexPath), /\.\.\//);

    const again = await templates.recover();
    assert.equal(again.length, 2);
    assert.equal((await readdir(join(files.root, ".bitacora/plantillas"))).filter(name => name.startsWith("index-apartado-")).length, 1);
    const added = await templates.add(metadata, [templates.fromUpload(upload("nueva.txt", "nueva"))]);
    assert.equal((await templates.open(added.id, added.version, "nueva.txt")).bytes.toString(), "nueva");
  } finally { await close(); }
});

test("a new file inside a template folder keeps the whole catalogue", async () => {
  const { files, templates, backups, close } = await fixture();
  try {
    await backups.initialize();
    const request = { workId: "work", title: "Cotización", request: "Sumar plantilla" };
    assert.equal(await backups.before(request), true);
    const bundle = await templates.add(metadata, [
      templates.fromUpload(upload("modelo.html", "<h1>Modelo</h1>")),
      templates.fromUpload(upload("notas.txt", "notas")),
    ]);
    assert.equal(await backups.finish(), true);
    const folder = join(files.root, ".bitacora", "plantillas", bundle.version);
    await writeFile(join(folder, "desktop.ini"), "[.ShellClassInfo]");
    const undo = await backups.undo(backups.target!.id);
    assert.ok(undo.skipped.includes("index.json"));
    assert.equal((await templates.list()).some(item => item.id === bundle.id), true);
    assert.equal(await files.read(`.bitacora/plantillas/${bundle.version}/modelo.html`), "<h1>Modelo</h1>");
    assert.equal(await files.read(`.bitacora/plantillas/${bundle.version}/notas.txt`), "notas");
    assert.equal((await lstat(folder)).isDirectory(), true);
    assert.equal(await readFile(join(folder, "desktop.ini"), "utf8"), "[.ShellClassInfo]");
  } finally { await close(); }
});

test("undo stops the catalogue when a path is skipped halfway", async () => {
  const { files, templates, close } = await fixture();
  let notes = "";
  let once = false;
  const backups = new Backups(files.root, join(files.root, "..", "mitad"), BACKUP_LIMITS, undefined, {
    rename,
    afterStep: async () => {
      if (once || !notes) return;
      once = true;
      await writeFile(join(files.root, notes), "tocado");
    },
  });
  try {
    await backups.initialize();
    const request = { workId: "work", title: "Cotización", request: "Sumar plantilla" };
    assert.equal(await backups.before(request), true);
    const bundle = await templates.add(metadata, [
      templates.fromUpload(upload("modelo.html", "<h1>Modelo</h1>")),
      templates.fromUpload(upload("notas.txt", "notas")),
    ]);
    assert.equal(await backups.finish(), true);
    const described = await templates.describe(bundle.id);
    notes = described.paths.find(path => path.endsWith("notas.txt")) ?? "";
    const model = described.paths.find(path => path.endsWith("modelo.html")) ?? "";
    const undo = await backups.undo(backups.target!.id);
    assert.ok(undo.skipped.includes("index.json"));
    assert.equal(await files.read(notes), "tocado");
    await assert.rejects(files.read(model), { code: "ENOENT" });
    assert.equal((await templates.list()).some(item => item.id === bundle.id), true);
    assert.equal((await lstat(join(files.root, ".bitacora", "plantillas", bundle.version))).isDirectory(), true);
  } finally { await close(); }
});

test("undo restores templates after .bitacora was removed and keeps that folder when undoing an add", async () => {
  const { files, templates, backups, close } = await fixture();
  const request = { workId: "work", title: "Cotización", request: "Sumar plantilla" };
  const root = join(files.root, ".bitacora");
  try {
    await backups.initialize();
    assert.equal(await backups.before(request), true);
    await templates.add(metadata, [templates.fromUpload(upload("modelo.txt", "modelo"))]);
    assert.equal(await backups.finish(), true);
    await backups.undo(backups.target!.id);
    assert.deepEqual(await templates.list(), []);
    assert.equal((await lstat(root)).isDirectory(), true);

    assert.equal(await backups.before(request), true);
    const saved = await templates.add(metadata, [templates.fromUpload(upload("modelo.txt", "modelo"))]);
    assert.equal(await backups.finish(), true);
    assert.equal(await backups.before(request), true);
    await rm(root, { recursive: true, force: true });
    assert.equal(await backups.finish(), true);
    await backups.undo(backups.target!.id);
    assert.equal((await templates.open(saved.id, saved.version, "modelo.txt")).bytes.toString(), "modelo");
    assert.equal((await lstat(root)).isDirectory(), true);
  } finally { await close(); }
});

test("an index larger than 4 MB is damaged and can be rebuilt", async () => {
  const { files, templates, close } = await fixture();
  try {
    const folder = randomUUID();
    await files.write(`.bitacora/plantillas/${folder}/modelo.html`, "<h1>Modelo</h1>");
    await files.write(".bitacora/plantillas/index.json", "x".repeat(4 * 1024 * 1024 + 1), false);
    await assert.rejects(templates.list(), (error: unknown) => error instanceof DamagedTemplates);
    const rebuilt = await templates.recover();
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0]?.name, "modelo");
    assert.deepEqual(rebuilt[0]?.files, ["modelo.html"]);
  } finally { await close(); }
});

test("the agent cannot register files inside .bitacora", async () => {
  const { templates, close } = await fixture();
  try {
    await assert.rejects(templates.fromPaths([".bitacora/plantillas/index.json"]), /carpeta interna/);
    await assert.rejects(templates.fromPaths(["notas.txt", ".bitacora\\privado.txt"]), /carpeta interna/);
  } finally { await close(); }
});

test("a busy catalogue lock answers 409 after a short wait", async () => {
  const { files, templates, close } = await fixture();
  let unlock: (() => Promise<void>) | undefined;
  try {
    await templates.add(metadata, [templates.fromUpload(upload("modelo.txt", "modelo"))]);
    unlock = await lockForWriting(join(files.root, ".bitacora", ".plantillas.lock"), "None");
    const started = Date.now();
    await assert.rejects(
      templates.add(metadata, [templates.fromUpload(upload("otra.txt", "otra"))]),
      (error: unknown) => {
        assert.ok(error instanceof TemplateProblem);
        assert.equal(error.status, 409);
        assert.match(error.message, /otro cambio/);
        return true;
      },
    );
    assert.ok(Date.now() - started >= 1500);
  } finally {
    await unlock?.();
    await close();
  }
});

test("a catalogue conflict is a 409, not a generic failure", async () => {
  const { files, close } = await fixture();
  try {
    class Busy extends Templates {
      override async list(): Promise<Template[]> {
        throw new TemplateProblem("Hay otro cambio en las plantillas. Probá de nuevo en un momento.", 409);
      }
    }
    let status = 0;
    let body = "";
    const res = {
      destroyed: false,
      writeHead(code: number) { status = code; return this; },
      end(payload?: string) { body = payload ?? ""; },
    };
    await handleTemplates(
      { method: "GET", readableEnded: true } as IncomingMessage,
      res as unknown as ServerResponse,
      new URL("http://127.0.0.1/templates"),
      new Busy(files),
      () => {},
    );
    assert.equal(status, 409);
    assert.match(body, /otro cambio/);
    assert.doesNotMatch(body, /No pude abrir las plantillas/);
  } finally { await close(); }
});

test("restoring the catalogue creates .bitacora and counts that action as done", async () => {
  const { files, templates, backups, close } = await fixture();
  const root = join(files.root, ".bitacora");
  const request = { workId: "work", title: "Cotización", request: "Sumar plantilla" };
  try {
    await backups.initialize();
    assert.equal(await backups.before(request), true);
    const saved = await templates.add(metadata, [templates.fromUpload(upload("modelo.txt", "modelo"))]);
    assert.equal(await backups.finish(), true);
    assert.equal(await backups.before(request), true);
    await rm(root, { recursive: true, force: true });
    assert.equal(await backups.finish(), true);
    const statePath = join(files.root, "..", "data", "backups", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.undo.before.directories.push(".bitacora");
    await writeFile(statePath, JSON.stringify(state));
    const again = new Backups(files.root, join(files.root, "..", "data"));
    await again.initialize(backups.receipt);
    const undo = await again.undo(again.target!.id);
    assert.ok(undo.restored.some(path => path.replaceAll("\\", "/").toLowerCase() === ".bitacora"));
    assert.equal(undo.skipped.includes(".bitacora"), false);
    assert.equal((await lstat(root)).isDirectory(), true);
    assert.equal((await templates.open(saved.id, saved.version, "modelo.txt")).bytes.toString(), "modelo");
  } finally { await close(); }
});

test("a file named .bitacora blocks restoring the catalogue and is left in place", async () => {
  const { files, templates, backups, close } = await fixture();
  const root = join(files.root, ".bitacora");
  const request = { workId: "work", title: "Cotización", request: "Sumar plantilla" };
  try {
    await backups.initialize();
    assert.equal(await backups.before(request), true);
    await templates.add(metadata, [templates.fromUpload(upload("modelo.txt", "modelo"))]);
    assert.equal(await backups.finish(), true);
    assert.equal(await backups.before(request), true);
    await rm(root, { recursive: true, force: true });
    assert.equal(await backups.finish(), true);
    await writeFile(root, "no es carpeta");
    await assert.rejects(backups.undo(backups.target!.id), /carpeta donde iba/);
    assert.equal(await readFile(root, "utf8"), "no es carpeta");
    assert.deepEqual(await templates.list(), []);
  } finally { await close(); }
});

test("a cut-off scan skips the whole catalogue and does not create .bitacora", async () => {
  const { files, templates, backups, close } = await fixture();
  const root = join(files.root, ".bitacora");
  const request = { workId: "work", title: "Cotización", request: "Sumar plantilla" };
  try {
    await backups.initialize();
    assert.equal(await backups.before(request), true);
    await templates.add(metadata, [templates.fromUpload(upload("modelo.txt", "modelo"))]);
    assert.equal(await backups.finish(), true);
    assert.equal(await backups.before(request), true);
    await rm(root, { recursive: true, force: true });
    assert.equal(await backups.finish(), true);
    const statePath = join(files.root, "..", "data", "backups", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.undo.after.omitted["parte de la carpeta"] = "cut";
    await writeFile(statePath, JSON.stringify(state));
    const again = new Backups(files.root, join(files.root, "..", "data"));
    await again.initialize(backups.receipt);
    const undo = await again.undo(again.target!.id);
    await assert.rejects(lstat(root), { code: "ENOENT" });
    assert.ok(undo.omitted.includes("parte de la carpeta"));
    assert.ok(undo.skipped.includes("index.json"));
    assert.ok(undo.skipped.some(name => name.endsWith("modelo.txt")));
    assert.deepEqual(await templates.list(), []);
  } finally { await close(); }
});

test("an omitted .bitacora folder skips the catalogue instead of recreating it", async () => {
  const { files, templates, backups, close } = await fixture();
  const root = join(files.root, ".bitacora");
  const request = { workId: "work", title: "Cotización", request: "Sumar plantilla" };
  try {
    await backups.initialize();
    assert.equal(await backups.before(request), true);
    await templates.add(metadata, [templates.fromUpload(upload("modelo.txt", "modelo"))]);
    assert.equal(await backups.finish(), true);
    assert.equal(await backups.before(request), true);
    await rm(root, { recursive: true, force: true });
    assert.equal(await backups.finish(), true);
    const statePath = join(files.root, "..", "data", "backups", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.undo.before.omitted[".bitacora"] = "unreadable directory";
    state.undo.after.omitted[".bitacora"] = "unreadable directory";
    await writeFile(statePath, JSON.stringify(state));
    const again = new Backups(files.root, join(files.root, "..", "data"));
    await again.initialize(backups.receipt);
    const undo = await again.undo(again.target!.id);
    await assert.rejects(lstat(root), { code: "ENOENT" });
    assert.ok(undo.omitted.includes(".bitacora"));
    assert.deepEqual(await templates.list(), []);
  } finally { await close(); }
});

test("the catalogue index is restored after its files and stays put if one file is skipped", async () => {
  const { files, templates, close } = await fixture();
  let notes = "";
  let model = "";
  let templateId = "";
  let indexWhileFileReturned = "";
  let spoil = false;
  const backups = new Backups(files.root, join(files.root, "..", "indice"), BACKUP_LIMITS, undefined, {
    rename,
    afterStep: async () => {
      if (!notes) return;
      try { await lstat(join(files.root, notes)); }
      catch { return; }
      if (!indexWhileFileReturned)
        indexWhileFileReturned = await readFile(join(files.root, ".bitacora", "plantillas", "index.json"), "utf8");
      if (spoil) return;
      spoil = true;
      await writeFile(join(files.root, model), "tocado");
    },
  });
  try {
    await backups.initialize();
    const request = { workId: "work", title: "Cotización", request: "Sumar plantilla" };
    assert.equal(await backups.before(request), true);
    const bundle = await templates.add(metadata, [
      templates.fromUpload(upload("modelo.html", "<h1>Modelo</h1>")),
      templates.fromUpload(upload("notas.txt", "notas")),
    ]);
    assert.equal(await backups.finish(), true);
    const described = await templates.describe(bundle.id);
    notes = described.paths.find(path => path.endsWith("notas.txt")) ?? "";
    model = described.paths.find(path => path.endsWith("modelo.html")) ?? "";
    templateId = bundle.id;
    assert.ok(notes && model);
    assert.equal(await backups.before(request), true);
    await templates.remove(bundle.id);
    assert.equal(await backups.finish(), true);
    const undo = await backups.undo(backups.target!.id);
    assert.equal(indexWhileFileReturned.includes(templateId), false);
    assert.ok(undo.skipped.includes("index.json"));
    assert.equal((await files.read(".bitacora/plantillas/index.json")).includes(templateId), false);
    assert.equal(await files.read(notes), "notas");
    assert.equal(await files.read(model), "tocado");
    assert.equal((await templates.list()).some(item => item.id === templateId), false);
  } finally { await close(); }
});

test("a resolved short name inside .bitacora cannot be registered", async () => {
  const { files, templates, close } = await fixture();
  try {
    await files.write(".bitacora/plantillas/nota.txt", "secreto");
    const folder = await realpath(await files.path(".bitacora"));
    const root = await realpath(await files.path("."));
    const { stdout } = await execFileAsync("cmd.exe", ["/d", "/c", `for %I in ("${folder}") do @echo %~sI`]);
    const short = stdout.trim();
    const input = relative(root, join(short, "plantillas", "nota.txt"));
    await assert.rejects(templates.fromPaths([input]), /carpeta interna/);
    if (!input.split(/[\\/]/).some(part => part.toLowerCase() === ".bitacora"))
      assert.equal(input.toLowerCase().includes("bitaco~"), true);
  } finally { await close(); }
});
