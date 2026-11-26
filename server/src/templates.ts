import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
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
]);

const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
export class TemplateProblem extends Error {}

export class Templates {
  constructor(private readonly files: AgencyFiles) {}

  async list(): Promise<Template[]> {
    let text: string;
    try { text = (await this.files.readBuffer(indexPath, 4 * 1024 * 1024)).toString("utf8"); }
    catch (error) { if (missing(error)) return []; throw error; }
    try { return index.parse(JSON.parse(text)).templates; }
    catch { throw new TemplateProblem("No pude leer la lista de plantillas. Los archivos siguen en la carpeta."); }
  }

  private location(template: Template) {
    return directory + "/" + template.version;
  }

  private filePath(template: Template, name: string) {
    return template.files.length === 1
      ? this.location(template) + "-" + name
      : this.location(template) + "/" + name;
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
    return { ...template, paths: template.files.map(name => this.filePath(template, name)) };
  }

  async open(id: string, version: string, name: string) {
    const template = this.find(await this.list(), id);
    const mime = mimeFor(name);
    if (template.version !== version || !template.files.includes(name) || !mime)
      throw new TemplateProblem("Ese archivo ya no está disponible.");
    const bytes = await this.files.readBuffer(this.filePath(template, name), MAX_FILE);
    return { bytes, name, mime };
  }

  async previewHtml(id: string, version: string, name: string) {
    const template = this.find(await this.list(), id);
    if (template.version !== version || !template.files.includes(name) || extname(name).toLowerCase() !== ".html")
      throw new TemplateProblem("Ese archivo ya no está disponible.");
    const path = this.filePath(template, name);
    return withPage(this.files, path, async page => {
      const piece = page.locator("[data-piece]").first();
      const box = await piece.count() ? await piece.boundingBox() : null;
      if (box && box.width > 0 && box.height > 0 && box.width <= 2000 && box.height <= 2400)
        return piece.screenshot({ timeout: 5000 });
      return page.screenshot({ timeout: 5000 });
    }, template.files.length === 1 ? directory : this.location(template));
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
        const paths = old.files.slice(1).map(name => this.filePath(old, name));
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
    for (const name of template.files)
      await this.files.remove(this.filePath(template, name)).catch(() => {});
    if (template.files.length > 1) await this.files.remove(this.location(template), true).catch(() => {});
  }
}
