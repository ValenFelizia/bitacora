import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Backups } from "../src/backups";
import { AGENCY_DEVELOPER_INSTRUCTIONS } from "../src/agency-environment";
import { Templates } from "../src/templates";
import { AgencyFiles } from "../src/tools/paths";

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
  for (const policy of [AGENCY_DEVELOPER_INSTRUCTIONS, ...await Promise.all(
    ["entender-el-pedido", "entrevista"].map(skill =>
      readFile("kit/turismo/.agents/skills/" + skill + "/SKILL.md", "utf8"))
  )]) {
    assert.match(policy, /listar_plantillas[\s\S]*?leer_plantilla[\s\S]*?request_user_input/);
  }
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /Antes de crear[^.]+listar_plantillas/);
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /mirá el original con mirar_pdf[\s\S]*?Dibujalo con dibujar[\s\S]*?compará todas las páginas/);
});
