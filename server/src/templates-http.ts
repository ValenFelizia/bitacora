import type { IncomingMessage, ServerResponse } from "node:http";
import { FileProblem, MAX_FILE } from "./workspace-files";
import { DamagedTemplates, Templates, TemplateProblem, templateMutation } from "./templates";

const MAX_BODY = Math.ceil(MAX_FILE / 3) * 4 + 4096;

async function readMutation(req: IncomingMessage) {
  if (Number(req.headers["content-length"]) > MAX_BODY)
    throw new FileProblem("El archivo puede pesar hasta 20 MB.");
  const data: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) throw new FileProblem("El archivo puede pesar hasta 20 MB.");
    data.push(chunk);
  }
  try { return templateMutation.parse(JSON.parse(Buffer.concat(data, size).toString("utf8"))); }
  catch { throw new TemplateProblem("Revisá el nombre, para qué sirve y el archivo."); }
}

export function templateReply(res: ServerResponse, status: number, body: unknown) {
  return res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }).end(JSON.stringify(body));
}

export async function handleTemplates(req: IncomingMessage, res: ServerResponse, url: URL, templates: Templates, updated: () => void) {
  try {
    if (req.method === "GET") {
      const file = url.searchParams.get("file");
      if (file !== null) {
        const id = url.searchParams.get("id") || "";
        const version = url.searchParams.get("version") || "";
        const { bytes, mime, name } = url.searchParams.has("preview")
          ? { bytes: await templates.previewHtml(id, version, file), mime: "image/png", name: "vista.png" }
          : await templates.open(id, version, file);
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": bytes.length,
          "Cache-Control": "no-store",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(/'/g, "%27"),
        }).end(bytes);
      } else templateReply(res, 200, { templates: await templates.list() });
    } else if (req.method === "POST") {
      const mutation = await readMutation(req);
      if (res.destroyed) return;
      if (mutation.kind === "add") {
        const { name, purpose, file } = mutation;
        await templates.add({ name, purpose, origin: "manual" }, [templates.fromUpload(file)]);
      } else if (mutation.kind === "edit") {
        const { id, name, purpose, file, expected } = mutation;
        await templates.update(id, { name, purpose }, file && { kind: "primary", file: templates.fromUpload(file) }, expected);
      } else if (mutation.kind === "rebuild") {
        await templates.recover();
      } else {
        await templates.remove(mutation.id, mutation.expected);
      }
      updated();
      templateReply(res, 200, { ok: true });
    } else templateReply(res, 405, { error: "No pude hacer ese cambio." });
  } catch (error) {
    if (res.destroyed) return;
    if (!req.readableEnded && req.method === "POST") res.setHeader("Connection", "close");
    const damaged = error instanceof DamagedTemplates;
    const status = error instanceof TemplateProblem ? error.status
      : error instanceof FileProblem ? 400
      : 500;
    const message = error instanceof Error ? error.message : "";
    templateReply(res, status, {
      error: status < 500 ? message
        : req.method === "POST" ? "No pude guardar el cambio. Volvé a intentarlo." : "No pude abrir las plantillas. Volvé a intentarlo.",
      ...(damaged ? { damaged: true } : {}),
    });
  }
}
