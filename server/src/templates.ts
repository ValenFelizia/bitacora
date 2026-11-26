import { randomUUID } from "node:crypto";
import { lstat, readdir, rename } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import type { Upload } from "./contracts";
import { MAX_FILE, MAX_REQUEST, WorkspaceFiles } from "./workspace-files";
import { AgencyFiles } from "./tools/paths";
import { withPage } from "./tools/page";
import { lockExclusiveFile } from "./tools/directory-lock";

const directory = ".bitacora/plantillas";
const indexPath = directory + "/index.json";
const lockPath = ".bitacora/.plantillas.lock";
const id = z.uuid();
const allowedMimes = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".html": "application/octet-stream",
  ".txt": "text/plain", ".md": "text/plain", ".csv": "text/plain", ".json": "text/plain",
  ".css": "application/octet-stream", ".svg": "application/octet-stream",
  ".woff": "application/octet-stream", ".woff2": "application/octet-stream", ".ttf": "application/octet-stream",
} as const;
const mimeFor = (name: string) => {
  const extension = extname(name).toLowerCase();
  return Object.hasOwn(allowedMimes, extension)
    ? allowedMimes[extension as keyof typeof allowedMimes] : undefined;
};
const filename = z.string().min(1).max(180).refine(name =>
  !/\p{Cs}/u.test(name) &&
  !/^[.]|[. ]$|[<>:"/\\|?*\x00-\x1f]|^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) && !!mimeFor(name));
const entry = z.object({
  id,
  version: id,
  name: z.string().min(1).max(120),
  purpose: z.string().min(1).max(500),
  files: z.array(filename).min(1).max(10),
  createdAt: z.iso.datetime(),
  origin: z.enum(["manual", "agent"]),
});
const index = z.object({
  version: z.literal(1),
  templates: z.array(entry).max(500),
}).refine(({ templates }) => new Set(templates.map(item => item.id)).size === templates.length &&
  new Set(templates.map(item => item.version)).size === templates.length &&
  templates.every(item => new Set(item.files.map(name => name.normalize("NFC").toUpperCase())).size === item.files.length));

export type Template = z.infer<typeof entry>;
type TemplateFile = { name: string; bytes: Buffer };
type Replacement = { kind: "bundle"; files: TemplateFile[] } | { kind: "primary"; file: TemplateFile };
export const templateMetadata = {
  name: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(1).max(500),
};
const expectedTemplate = entry.pick({ version: true, name: true, purpose: true });
type ExpectedTemplate = z.infer<typeof expectedTemplate>;
export const templateMutation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), ...templateMetadata, file: z.object({ name: z.string(), data: z.string() }) }),
  z.object({ kind: z.literal("edit"), id, expected: expectedTemplate, ...templateMetadata, file: z.object({ name: z.string(), data: z.string() }).optional() }),
  z.object({ kind: z.literal("remove"), id, expected: expectedTemplate }),
  z.object({ kind: z.literal("rebuild") }),
]);

const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
export class TemplateProblem extends Error {}
/** The catalogue file is present but cannot be trusted. The panel can set it aside and rebuild. */
export class DamagedTemplates extends TemplateProblem {}
export const recoveredTemplatePurpose = "Recuperada de la carpeta. Podés cambiar el nombre.";

export class Templates {
  constructor(private readonly files: AgencyFiles) {}

  private async readIndex(): Promise<
    { state: "missing" } | { state: "ok"; templates: Template[] } | { state: "damaged" }
  > {
    let text: string;
    try { text = (await this.files.readBuffer(indexPath, 4 * 1024 * 1024)).toString("utf8"); }
    catch (error) { if (missing(error)) return { state: "missing" }; throw error; }
    try { return { state: "ok", templates: index.parse(JSON.parse(text)).templates }; }
    catch { return { state: "damaged" }; }
  }

  async list(): Promise<Template[]> {
    const read = await this.readIndex();
    if (read.state === "missing") return [];
    if (read.state === "damaged")
      throw new DamagedTemplates("No pude leer la lista de plantillas. Los archivos siguen en la carpeta.");
    return read.templates;
  }

  private location(template: Template) {
    return directory + "/" + template.version;
  }

  private filePath(template: Template, name: string) {
    return template.files.length === 1
      ? this.location(template) + "-" + name
      : this.location(template) + "/" + name;
  }

  /** A recovered bundle keeps its folder even when only one file is inside. */
  private async storedPath(template: Template, name: string) {
    const nested = this.location(template) + "/" + name;
    if (template.files.length === 1) {
      try {
        const stat = await lstat(await this.files.path(nested));
        if (stat.isFile()) return nested;
      } catch (error) { if (!missing(error)) throw error; }
    }
    return this.filePath(template, name);
  }

  private find(templates: Template[], id: string, expected?: ExpectedTemplate) {
    const template = templates.find(item => item.id === id);
    if (!template) throw new TemplateProblem("Esa plantilla ya no está disponible.");
    if (expected && (expected.version !== template.version || expected.name !== template.name || expected.purpose !== template.purpose))
      throw new TemplateProblem("La plantilla cambió. Cerrá esta edición y volvé a abrirla.");
    return template;
  }

  async describe(id: string) {
    const template = this.find(await this.list(), id);
    return { ...template, paths: await Promise.all(template.files.map(name => this.storedPath(template, name))) };
  }

  async open(id: string, version: string, name: string) {
    const template = this.find(await this.list(), id);
    const mime = mimeFor(name);
    if (template.version !== version || !template.files.includes(name) || !mime)
      throw new TemplateProblem("Ese archivo ya no está disponible.");
    const bytes = await this.files.readBuffer(await this.storedPath(template, name), MAX_FILE);
    return { bytes, name, mime };
  }

  async previewHtml(id: string, version: string, name: string) {
    const template = this.find(await this.list(), id);
    if (template.version !== version || !template.files.includes(name) || extname(name).toLowerCase() !== ".html")
      throw new TemplateProblem("Ese archivo ya no está disponible.");
    const path = await this.storedPath(template, name);
    const resources = path.endsWith("/" + name) ? this.location(template) : directory;
    return withPage(this.files, path, async page => {
      const piece = page.locator("[data-piece]").first();
      const box = await piece.count() ? await piece.boundingBox() : null;
      if (box && box.width > 0 && box.height > 0 && box.width <= 2000 && box.height <= 2400)
        return piece.screenshot({ timeout: 5000 });
      return page.screenshot({ timeout: 5000 });
    }, resources);
  }

  async fromPaths(paths: string[]) {
    const bundle: TemplateFile[] = [];
    let remaining = MAX_REQUEST;
    for (const path of paths) {
      const original = basename(path);
      const name = /^adjuntos[\\/]/i.test(path) && z.uuid().safeParse(original.slice(0, 36)).success
        ? original.slice(37)
        : original;
      const file = this.validFile(name, await this.files.readBuffer(path, Math.min(MAX_FILE, remaining)));
      remaining -= file.bytes.length;
      bundle.push(file);
    }
    return bundle;
  }

  fromUpload(file: Upload) {
    if (file.data.length > Math.ceil(MAX_FILE / 3) * 4)
      throw new TemplateProblem("El archivo puede pesar hasta 20 MB.");
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.toString("base64") !== file.data)
      throw new TemplateProblem("No pude leer el archivo. Elegilo de nuevo.");
    return this.validFile(file.name, bytes);
  }

  private validFile(name: string, bytes: Buffer): TemplateFile {
    if (!filename.safeParse(name).success)
      throw new TemplateProblem("Elegí una imagen, un PDF, un HTML o un archivo de texto con un nombre válido.");
    if (!bytes.length || bytes.length > MAX_FILE)
      throw new TemplateProblem("El archivo tiene que tener contenido y pesar hasta 20 MB.");
    const extension = extname(name).toLowerCase();
    if (extension === ".html" || extension === ".css" || extension === ".svg") {
      try { if (bytes.includes(0)) throw new Error(); new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new TemplateProblem("No pude leer ese archivo como texto."); }
    } else if (![".woff", ".woff2", ".ttf"].includes(extension)) {
      new WorkspaceFiles(this.files.root).validate([{ name, data: bytes.toString("base64") }]);
    }
    return { name, bytes };
  }

  private async save(templates: Template[]) {
    const contents = index.parse({ version: 1, templates });
    await this.files.write(indexPath, JSON.stringify(contents, null, 2) + "\n", false);
  }

  private async serialized<T>(run: () => Promise<T>) {
    const path = await this.files.path(lockPath);
    try { await lstat(path); }
    catch (error) {
      if (!missing(error)) throw error;
      try { await this.files.write(lockPath, ""); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    const release = lockExclusiveFile(path);
    try {
      await this.files.path(lockPath);
      return await run();
    } finally { release(); }
  }

  async add(metadata: Pick<Template, "name" | "purpose" | "origin">, files: TemplateFile[]) {
    return this.serialized(async () => {
      const templates = await this.list();
      if (templates.length >= 500) throw new TemplateProblem("Hay demasiadas plantillas en esta carpeta.");
      const template = { ...metadata, id: randomUUID(), createdAt: new Date().toISOString() };
      return this.replace(templates, template, files);
    });
  }

  async update(id: string, metadata: Partial<Pick<Template, "name" | "purpose">>, replacement?: Replacement, expected?: ExpectedTemplate) {
    return this.serialized(async () => {
      const templates = await this.list();
      const old = this.find(templates, id, expected);
      const template = { ...old, ...metadata };
      if (replacement?.kind === "bundle") return this.replace(templates, template, replacement.files, old);
      if (replacement?.kind === "primary") {
        const paths = await Promise.all(old.files.slice(1).map(name => this.storedPath(old, name)));
        return this.replace(templates, template, [replacement.file, ...await this.fromPaths(paths)], old);
      }
      await this.save(templates.map(item => item.id === id ? template : item));
      return template;
    });
  }

  private async replace(templates: Template[], metadata: Omit<Template, "version" | "files">, files: TemplateFile[], old?: Template) {
    const template = entry.parse({ ...metadata, version: randomUUID(), files: files.map(file => file.name) });
    const next = old ? templates.map(item => item.id === old.id ? template : item) : [...templates, template];
    if (!index.safeParse({ version: 1, templates: next }).success)
      throw new TemplateProblem("Los archivos de una misma plantilla tienen que tener nombres distintos.");
    if (files.reduce((sum, file) => sum + file.bytes.length, 0) > MAX_REQUEST)
      throw new TemplateProblem("La plantilla puede pesar hasta 40 MB en total.");
    // Publish the index only after all new files are in place. Old files remain
    // available until publication succeeds, including if Windows locks the index.
    try {
      for (const file of files) await this.files.write(this.filePath(template, file.name), file.bytes);
      await this.save(next);
    } catch (error) {
      // A failed post-write verification can leave publication uncertain.
      // Preserve the staged files unless the committed index is readable.
      const committed = await this.list().catch(() => undefined);
      if (committed && !committed.some(item => item.version === template.version))
        await this.clean(template);
      throw error;
    }
    if (old) await this.clean(old);
    return template;
  }

  async remove(id: string, expected?: ExpectedTemplate) {
    return this.serialized(async () => {
      const templates = await this.list();
      const template = this.find(templates, id, expected);
      await this.save(templates.filter(item => item.id !== id));
      await this.clean(template);
    });
  }

  private async clean(template: Template) {
    let directoryLayout = template.files.length > 1;
    for (const name of template.files) {
      const path = await this.storedPath(template, name);
      if (path.endsWith("/" + name)) directoryLayout = true;
      await this.files.remove(path).catch(() => {});
    }
    if (directoryLayout) await this.files.remove(this.location(template), true).catch(() => {});
  }

  /**
   * Set the unreadable catalogue aside (rename, never delete) and list again
   * from the folders and files already on disk. Nothing else is removed.
   */
  async recover() {
    return this.serialized(async () => {
      const read = await this.readIndex();
      if (read.state === "ok") return read.templates;
      if (read.state === "missing") return [];
      const aside = await this.asideIndex();
      try {
        const templates = await this.rebuildFromDisk();
        await this.save(templates);
        return templates;
      } catch (error) {
        await this.restoreAside(aside);
        throw error;
      }
    });
  }

  private async asideIndex() {
    const from = await this.files.path(indexPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "");
    for (let n = 1; n < 100; n++) {
      const relative = directory + "/index-apartado-" + stamp + (n === 1 ? "" : "-" + n) + ".json";
      try { await lstat(await this.files.path(relative)); }
      catch (error) {
        if (!missing(error)) throw error;
        await rename(from, await this.files.path(relative));
        return relative;
      }
    }
    throw new TemplateProblem("No pude apartar la lista dañada. Los archivos siguen en la carpeta.");
  }

  private async restoreAside(relative: string) {
    try { await lstat(await this.files.path(indexPath)); return; }
    catch (error) { if (!missing(error)) return; }
    await rename(await this.files.path(relative), await this.files.path(indexPath)).catch(() => {});
  }

  private async rebuildFromDisk() {
    let entries;
    try { entries = await readdir(await this.files.path(directory), { withFileTypes: true }); }
    catch (error) { if (missing(error)) return []; throw error; }
    const directories: string[] = [];
    const loose: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (name === "index.json" || name.startsWith("index-apartado-") || name.startsWith(".")) continue;
      if (entry.isDirectory()) directories.push(name);
      else if (entry.isFile()) loose.push(name);
    }
    directories.sort((a, b) => a.localeCompare(b, "es"));
    loose.sort((a, b) => a.localeCompare(b, "es"));
    const templates: Template[] = [];
    const versions = new Set<string>();
    const claim = (version: string) => {
      const key = version.toLowerCase();
      if (versions.has(key)) return false;
      versions.add(key);
      return true;
    };
    for (const folder of directories) {
      if (!z.uuid().safeParse(folder).success || !claim(folder)) continue;
      const files = await this.folderFiles(directory + "/" + folder);
      const template = this.recovered(folder, folder, files);
      if (!template) { versions.delete(folder.toLowerCase()); continue; }
      templates.push(template);
      if (templates.length >= 500) return templates;
    }
    const single = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i;
    for (const name of loose) {
      if (templates.length >= 500) break;
      const match = single.exec(name);
      if (!match || !z.uuid().safeParse(match[1]).success || !claim(match[1])) continue;
      const template = this.recovered(match[1], match[2], [match[2]]);
      if (!template) { versions.delete(match[1].toLowerCase()); continue; }
      templates.push(template);
    }
    return templates;
  }

  private async folderFiles(folder: string) {
    let names: string[];
    try { names = await readdir(await this.files.path(folder)); }
    catch { return []; }
    const seen = new Set<string>();
    const files: string[] = [];
    for (const name of names) {
      if (!filename.safeParse(name).success) continue;
      const key = name.normalize("NFC").toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(name);
    }
    files.sort((a, b) => Number(b.toLowerCase().endsWith(".html")) - Number(a.toLowerCase().endsWith(".html"))
      || a.localeCompare(b, "es"));
    return files.slice(0, 10);
  }

  private recovered(version: string, label: string, files: string[]) {
    if (!files.length) return undefined;
    const parsed = entry.safeParse({
      id: randomUUID(),
      version,
      name: label.length <= 120 ? label : label.slice(0, 120),
      purpose: recoveredTemplatePurpose,
      files,
      createdAt: new Date().toISOString(),
      origin: "manual",
    });
    return parsed.success ? parsed.data : undefined;
  }
}
