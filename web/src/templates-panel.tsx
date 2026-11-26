import React, { useEffect, useState } from "react";
import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { TEMPLATES_PATH, type FileRef, type Upload } from "../../server/src/contracts";
import type { Template } from "../../server/src/templates";

type Form = { kind: "add" } | { kind: "edit" | "remove"; template: Template };
type Load = { kind: "loading" } | { kind: "ready"; templates: Template[] } | { kind: "error"; message: string; damaged?: boolean };
const extensions = ".pdf,.png,.jpg,.jpeg,.webp,.html,.txt,.md,.csv,.json";
const button = "inline-flex items-center gap-1.5 rounded-[6px] border border-line px-2.5 py-1.5 text-[13px] font-bold text-ink enabled:hover:bg-soft enabled:cursor-pointer disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
const field = "w-full rounded-[6px] border border-line bg-paper p-2 text-ink";

export function templateFileUrl(workspace: string, template: Template, name: string) {
  return TEMPLATES_PATH + "?" + new URLSearchParams({
    workspace, id: template.id, version: template.version, file: name,
  });
}

function readUpload(file: File): Promise<Upload> {
  if (!file.size || file.size > 20 * 1024 * 1024)
    throw new Error("El archivo tiene que tener contenido y pesar hasta 20 MB.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(",")[1] });
    reader.onerror = () => reject(new Error("No pude leer el archivo. Elegilo de nuevo."));
    reader.readAsDataURL(file);
  });
}

async function responseBody(response: Response) {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : "No pude abrir las plantillas. Probá de nuevo.";
    const error = new Error(message) as Error & { damaged?: boolean };
    if (body && typeof body === "object" && "damaged" in body && body.damaged === true) error.damaged = true;
    throw error;
  }
  return body;
}

export function TemplatesPanel({
  workspace, token, revision, busy, onPreview,
}: {
  workspace?: string;
  token?: string;
  revision?: number;
  busy: boolean;
  onPreview: (file: FileRef, url: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [form, setForm] = useState<Form>();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const url = TEMPLATES_PATH + "?" + new URLSearchParams({ workspace: workspace || "" });

  useEffect(() => {
    if (!workspace || !token) return;
    const controller = new AbortController();
    void fetch(url, { headers: { Authorization: "Bearer " + token }, signal: controller.signal })
      .then(responseBody)
      .then(body => {
        if (!body || typeof body !== "object" || !("templates" in body) || !Array.isArray(body.templates))
          throw new Error("No pude leer las plantillas.");
        if (!controller.signal.aborted) setLoad({ kind: "ready", templates: body.templates });
      })
      .catch(error => {
        if (!controller.signal.aborted) setLoad({
          kind: "error",
          message: error instanceof Error ? error.message : "No pude abrir las plantillas.",
          damaged: error instanceof Error && "damaged" in error && error.damaged === true,
        });
      });
    return () => controller.abort();
  }, [workspace, token, url, revision, reload]);

  useEffect(() => { setConfirmRebuild(false); }, [workspace]);

  async function rebuild(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || busy || saving) return;
    setSaving(true);
    setProblem("");
    try {
      await responseBody(await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "rebuild" }),
      }));
      setConfirmRebuild(false);
      setLoad({ kind: "loading" });
      setReload(value => value + 1);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "No pude rearmar la lista. Probá de nuevo.");
    } finally { setSaving(false); }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !token || busy || saving) return;
    const fields = new FormData(event.currentTarget);
    setSaving(true);
    setProblem("");
    try {
      const expected = form.kind !== "add" ? {
        name: form.template.name, purpose: form.template.purpose, version: form.template.version,
      } : undefined;
      let body;
      if (form.kind === "remove") body = { kind: "remove", id: form.template.id, expected };
      else {
        const name = String(fields.get("name") || "").trim();
        const purpose = String(fields.get("purpose") || "").trim();
        if (!name || !purpose) throw new Error("Completá el nombre y para qué sirve.");
        const chosen = fields.get("file");
        const file = chosen instanceof File && chosen.name ? await readUpload(chosen) : undefined;
        body = form.kind === "add" ? { kind: "add", name, purpose, file }
          : { kind: "edit", id: form.template.id, expected, name, purpose, file };
      }
      await responseBody(await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      setForm(undefined);
      setReload(value => value + 1);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "No pude guardar el cambio. Probá de nuevo.");
    } finally { setSaving(false); }
  }

  function start(next: Form | undefined) {
    setForm(next);
    setProblem("");
  }

  if (!workspace || !token) return <p className="text-[14px] text-muted">Esperá a que se abra la carpeta de trabajo.</p>;
  if (load.kind === "loading") return <p role="status" className="text-[14px] text-muted">Buscando plantillas…</p>;
  if (load.kind === "error") return (
    <div className="space-y-3">
      <p role="alert" className="text-[14px] text-muted">{load.message}</p>
      {load.damaged && !confirmRebuild && (
        <button type="button" className={button} disabled={busy || saving} onClick={() => { setProblem(""); setConfirmRebuild(true); }}>
          Rearmar la lista
        </button>
      )}
      {load.damaged && confirmRebuild && (
        <form onSubmit={rebuild} className="space-y-3">
          <p>Voy a apartar la lista dañada y armarla de nuevo con las carpetas que hay. No se borra ningún archivo. Después podés cambiar los nombres.</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={button} disabled={busy || saving}>Apartar y rearmar</button>
            <button type="button" className={button} disabled={saving} onClick={() => { setConfirmRebuild(false); setProblem(""); }}>Cancelar</button>
          </div>
          {saving && <p role="status" className="text-muted">Rearmando…</p>}
          {problem && <p role="alert" className="text-ink">{problem}</p>}
        </form>
      )}
      {busy && load.damaged && <p className="text-muted">Cuando termine el pedido podés rearmar la lista.</p>}
      <button type="button" className={button} disabled={saving} onClick={() => setReload(value => value + 1)}>Volver a intentar</button>
    </div>
  );

  const locked = busy || saving;
  const editing = form && form.kind !== "add" ? form.template : undefined;

  return (
    <section aria-label="Plantillas" className="space-y-4 text-[14px]">
      {!form && (
        <button type="button" className={button} disabled={locked} onClick={() => start({ kind: "add" })}>
          <Plus size={16} aria-hidden="true" /> Sumar plantilla
        </button>
      )}
      {busy && <p className="text-muted">Cuando termine el pedido podés hacer cambios.</p>}
      {form && (
        <form onSubmit={submit} className="space-y-3 rounded-[6px] border border-line p-3">
          <fieldset disabled={locked} className="min-w-0 space-y-3 disabled:opacity-60">
            <legend className="font-bold text-ink">
              {form.kind === "add" ? "Sumar plantilla" : form.kind === "edit" ? "Editar plantilla" : "Quitar plantilla"}
            </legend>
            {form.kind === "remove" ? (
              <p>¿Querés quitar «{form.template.name}» de las plantillas de esta carpeta?</p>
            ) : (
              <>
                <label className="block space-y-1">
                  <span>Nombre</span>
                  <input name="name" className={field} defaultValue={editing?.name} required maxLength={120} autoFocus />
                </label>
                <label className="block space-y-1">
                  <span>Para qué sirve</span>
                  <textarea name="purpose" className={field} defaultValue={editing?.purpose} required rows={2} maxLength={500} />
                </label>
                <label className="block space-y-1">
                  <span>{editing ? "Reemplazar archivo principal" : "Archivo"}</span>
                  <input name="file" type="file" className={field} accept={extensions} required={!editing} />
                </label>
                {editing && <p className="break-words text-muted">Actual: {editing.files.join(", ")}</p>}
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={button}>{form.kind === "remove" ? "Quitar" : "Guardar"}</button>
              <button type="button" className={button} onClick={() => start(undefined)}>Cancelar</button>
            </div>
          </fieldset>
          {saving && <p role="status" className="text-muted">Guardando…</p>}
          {problem && <p role="alert" className="text-ink">{problem}</p>}
        </form>
      )}
      {!load.templates.length && <p className="text-muted">Todavía no hay plantillas en esta carpeta.</p>}
      {load.templates.length > 0 && (
        <ul className="space-y-2">
          {load.templates.map(template => (
            <li key={template.id} className="space-y-2 rounded-[6px] border border-line p-3">
              <div className="break-words">
                <h3 className="font-bold text-ink">{template.name}</h3>
                <p className="text-muted">{template.purpose}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {template.files.map(name => (
                  <button type="button" key={name} className={button}
                    onClick={() => onPreview({
                      id: template.version + "/" + name,
                      name, path: name, mime: /\.(?:png|jpe?g|webp)$/i.test(name) ? "image/" : "",
                      createdAt: template.createdAt,
                    }, templateFileUrl(workspace, template, name))}>
                    <Eye size={15} className="shrink-0" aria-hidden="true" />
                    <span className="break-all text-left">Ver {name}</span>
                  </button>
                ))}
                <button type="button" className={button} disabled={locked || !!form} onClick={() => start({ kind: "edit", template })} aria-label={"Editar " + template.name}>
                  <Pencil size={15} aria-hidden="true" /> Editar
                </button>
                <button type="button" className={button} disabled={locked || !!form} onClick={() => start({ kind: "remove", template })} aria-label={"Quitar " + template.name}>
                  <Trash2 size={15} aria-hidden="true" /> Quitar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
