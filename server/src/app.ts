import { existsSync } from "node:fs";
import { Backups, BACKUP_LIMITS, RestoreProblem, pathKey } from './backups';
import { mkdir, readFile, writeFile, rename, copyFile, rm } from "node:fs/promises";
import { WorkspaceFiles, MAX_RESULT, type FileScan } from "./workspace-files";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { rememberUserUrls } from './allowed-urls';
import { initializeKit } from './tools/kit';
import type { Account, Engine, EngineEvent, SuggestedTitle } from "./engine";
import { problemText, EngineFailure, activityText } from "./engine";
import { fallbackTitle, MAX_TITLE } from "./titles";
import type { FileRef, Message, Work, Snapshot, ClientCommand, ServerMessage } from "./contracts";

type SavedWork = Work & { conversationId: string; titlePending?: boolean; renamedByUser?: boolean; pendingFiles?: { messageId: string; before?: Record<string, string> } };
const isText = (value: unknown) => typeof value === "string";
/** How long close() lets a title request already in flight finish before stopping the engine. */
const TITLE_CLOSE_WAIT_MS = 400;
const isFileRef = (value: unknown) => {
  const file = value as Partial<FileRef> | null;
  return !!file && isText(file.id) && isText(file.path) && isText(file.name) && isText(file.mime) && isText(file.createdAt);
};
const isMessage = (value: unknown) => {
  const message = value as Partial<Message> | null;
  return !!message && isText(message.id) && (message.role === "user" || message.role === "assistant") && isText(message.text) &&
    (message.attachments === undefined || (Array.isArray(message.attachments) && message.attachments.every(isFileRef))) &&
    (message.results === undefined || (Array.isArray(message.results) && message.results.every(isFileRef)));
};
const isSavedWork = (value: unknown) => {
  const work = value as Partial<SavedWork> | null;
  return !!work && isText(work.id) && isText(work.conversationId) && isText(work.title) && isText(work.details) &&
    isText(work.createdAt) && isText(work.updatedAt) && isText(work.progress) &&
    (work.problem === undefined || isText(work.problem)) &&
    (work.busy === undefined || typeof work.busy === "boolean") &&
    (work.titlePending === undefined || typeof work.titlePending === "boolean") &&
    (work.renamedByUser === undefined || typeof work.renamedByUser === "boolean") &&
    Array.isArray(work.messages) && work.messages.every(isMessage) &&
    (work.pendingFiles === undefined || (!!work.pendingFiles && isText(work.pendingFiles.messageId)));
};
export class App {
  private backups?: Backups;
  private backupReceipt?: string;
  private fileRevision = 0;
  private scanning = new Set<string>();
  private scans = new Set<Promise<void>>();
  private notice?: string;
  private available = false;
  private starting = true;
  private exhausted = false;
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;
  private writeRevision = 0;
  private works: SavedWork[] = [];
  private accountState?: Account;
  private writes: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private submitting = false;
  private resumed = new Set<string>();
  // Work ids whose saved request has not reached the engine yet, and pauses
  // requested during that window: they are delivered once the turn starts.
  private unsent = new Set<string>();
  private pauseRequested = new Set<string>();
  // Works created in this session whose first request has not been titled yet,
  // and works the user named by hand: a chosen name is never replaced.
  private titlePending = new Set<string>();
  private renamed = new Set<string>();
  private titleTasks = new Set<Promise<void>>();
  constructor(
    private engine: Engine,
    private data: string,
    private publish: (message: ServerMessage) => void,
    private files = { rename, copyFile },
    private workspace?: WorkspaceFiles,
    private kitSource?: string,
  ) {}
  async start() {
    await this.initialize();
    await this.startEngine();
  }
  async initialize() {
    await mkdir(this.data, { recursive: true });
    await this.workspace?.initialize();
    if (this.workspace) await initializeKit(this.workspace.root, this.data, this.kitSource);
    try {
      const saved = JSON.parse(
        await readFile(join(this.data, "works.json"), "utf8"),
      );
      if (!saved || saved.version !== 1 || !Array.isArray(saved.works) || !saved.works.every(isSavedWork))
        throw new SyntaxError("Invalid saved work list");
      this.works = saved.works;
      this.backupReceipt = typeof saved.backupReceipt === "string" ? saved.backupReceipt : undefined;
      // A work whose first request was paused or failed before it could be
      // titled stays pending across restarts, so its next finished request
      // still names it. A name the user chose is final across restarts too.
      for (const work of this.works) {
        if (work.titlePending) this.titlePending.add(work.id);
        if (work.renamedByUser) this.renamed.add(work.id);
      }
      for (const work of this.works)
        if (work.busy) {
          work.busy = false;
          work.progress =
            "El trabajo se detuvo al cerrar la app. Podés continuarlo.";
        }
    } catch (error) {
      if (error instanceof SyntaxError) {
        const source = join(this.data, "works.json");
        const target = join(this.data, `works.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        let preserved = true;
        try { await this.renameWithRetry(source, target); }
        catch {
          try { await this.files.copyFile(source, target); }
          catch { preserved = false; }
        }
        this.works = [];
        this.notice = preserved
          ? "No pude leer los trabajos guardados. Conservé el archivo dañado por separado y abrí una lista vacía."
          : "No pude leer los trabajos guardados ni conservar una copia aparte. Abrí una lista vacía.";
      } else if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
    if (this.workspace) {
      try { this.backups = new Backups(this.workspace.root, this.data, BACKUP_LIMITS, this.workspace); await this.backups.initialize(this.backupReceipt); }
      catch { this.backups = undefined; this.notice = "No pude preparar las copias. Podés trabajar, pero esta vez no vas a poder deshacer."; }
      if (this.backups?.invalidated) this.notice = "No pude confirmar que la copia sea del último pedido. No voy a ofrecer Deshacer para esa copia.";
      if (this.backups?.restoring) this.notice = "Quedó un Deshacer pendiente. Podés reintentarlo o dejar la carpeta como está.";
    }
    for (const work of this.works) if (work.pendingFiles) { await this.collectResults(work); this.dirty = true; }
  }
  async startEngine() {
    this.unsubscribe = this.engine.subscribe((event) => this.event(event));
    await this.engine.start();
    // Codex reports the account during start. Avoid a second read racing the
    // automatic MXC setup, which can replace the app-server.
    this.accountState ??= await this.engine.account();
    this.available = true;
    this.starting = false;
    this.publish({ type: "snapshot", state: this.snapshot() });
  }
  snapshot(): Snapshot {
    return {
      account: (!this.starting && this.available && this.accountState) || { connected: false },
      engine: {
        available: !this.starting && this.available,
        starting: this.starting,
        exhausted: this.exhausted,
        safety: this.engine.executionSafety(),
      },
      hasBrand: this.workspace ? existsSync(join(this.workspace.root, "marca")) : undefined,
      notice: this.notice,
      undo: !this.submitting && !this.works.some(w => w.busy) ? this.backups?.target : undefined,
      fileRevision: this.fileRevision,
      works: this.works.map(({ conversationId: _, pendingFiles: __, titlePending: ___, renamedByUser: ____, ...work }) => work),
    };
  }
  private async renameWithRetry(source: string, target: string) {
    for (let attempt = 0; ; attempt++) {
      try { await this.files.rename(source, target); return; }
      catch (error) {
        if (attempt >= 3 || !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
        await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
      }
    }
  }
  private changed() {
    const revision = ++this.writeRevision;
    this.dirty = false;
    const content = JSON.stringify({ version: 1, works: this.works, backupReceipt: this.backupReceipt }, null, 2);
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await writeFile(join(this.data, "works.json.tmp"), content, "utf8");
        await this.renameWithRetry(join(this.data, "works.json.tmp"), join(this.data, "works.json"));
      });
    // Report each failure while allowing the next write to recover. A failed
    // save stays unsaved so closing retries it instead of losing the change.
    void this.writes.catch((error) => {
      if (this.writeRevision === revision) this.dirty = true;
      this.publish({
        type: "problem",
        text: "No pude guardar el trabajo. No cierres la app todavía.",
        detail: String(error),
      });
    });
    this.publish({ type: "snapshot", state: this.snapshot() });
  }
  file(id: string) {
    return this.works.flatMap(w => w.messages.flatMap(m => [...(m.attachments || []), ...(m.results || [])])).find(f => f.id === id);
  }
  private scanDetail(work: SavedWork, scan: FileScan) {
    if (scan.warnings.length) work.details = (work.details + scan.warnings.join("\n") + "\n").slice(-100000);
  }
  private pendingPath(work: SavedWork) {
    if (!/^[a-zA-Z0-9-]+$/.test(work.id)) throw new Error('Invalid work identity');
    return join(this.data, 'pending-files', `${work.id}.json`);
  }
  private async collectResults(work: SavedWork) {
    const pending = work.pendingFiles;
    if (!pending || !this.workspace) return;
    try {
      const before = pending.before
        ? { entries: Object.fromEntries(Object.entries(pending.before).map(([p, hash]) => [p, { hash }])) } as FileScan
        : JSON.parse(await readFile(this.pendingPath(work), 'utf8')) as FileScan;
      let after: FileScan;
      if (this.backups) {
        const complete = await this.backups.finish();
        if (!complete) this.notice = "No pude guardar la copia de este pedido. Esta vez no vas a poder deshacer.";
        else if (this.backups.latestOmitted.length) this.notice = `No pude guardar copia de ${this.backups.latestOmitted.join(', ')}, así que eso no lo puedo deshacer.`;
        if (!this.backups.lastScan) throw new Error('File review unavailable');
        after = this.backups.lastScan;
      } else after = await this.workspace.scan(before);
      this.scanDetail(work, after);
      const message = work.messages.find(m => m.id === pending.messageId);
      const previous = new Map(Object.entries(before.entries).map(([p, entry]) => [pathKey(p), entry.hash]));
      const changed = Object.keys(after.entries).filter(p => this.workspace!.isResult(p) && after.entries[p].hash !== previous.get(pathKey(p)));
      // The backup keeps files up to its own limit, but a result the app cannot
      // serve must not become a card the user cannot open.
      const tooBig = changed.filter(p => after.entries[p].size > MAX_RESULT).map(p => basename(p));
      if (message) message.results = changed.filter(p => after.entries[p].size <= MAX_RESULT).map(p => this.workspace!.result(p));
      if (tooBig.length) {
        const notice = tooBig.length === 1
          ? `Se generó ${tooBig[0]}, pero es demasiado grande para mostrarlo acá.`
          : `Se generaron ${tooBig.join(', ')}, pero son demasiado grandes para mostrarlos acá.`;
        work.problem = work.problem ? `${work.problem} ${notice}` : notice;
      }
    } catch (error) {
      work.problem = "No pude revisar los resultados de ese pedido. Podés seguir trabajando.";
      work.details = (work.details + String(error) + "\n").slice(-100000);
    } finally {
      this.fileRevision++;
      delete work.pendingFiles;
      try { await rm(this.pendingPath(work), { force: true }); }
      catch (error) { work.details = (work.details + String(error) + "\n").slice(-100000); }
    }
  }
  private finishFiles(work: SavedWork) {
    if (!work.pendingFiles || !this.workspace || this.scanning.has(work.id)) return;
    work.busy = true;
    this.scanning.add(work.id);
    const scan = this.collectResults(work).finally(() => { work.busy = false; this.changed(); this.scans.delete(scan); this.scanning.delete(work.id); });
    this.scans.add(scan);
  }
  /**
   * Replaces the fallback name with the engine's short one, once, after the
   * first request. It never overwrites a name the user chose meanwhile, and a
   * failure leaves the fallback in place.
   *
   * The work stays pending until a title is applied or the sample answered
   * with no usable text: a sample that could not run (engine stopping, thread
   * busy, request error) is retried by the next finished request, even in a
   * later session: a start alone does not title it.
   */
  private clearTitlePending(work: SavedWork) {
    this.titlePending.delete(work.id);
    delete work.titlePending;
  }
  private async generateTitle(work: SavedWork) {
    if (!this.titlePending.has(work.id)) return;
    const before = work.title;
    let suggestion: SuggestedTitle | undefined;
    try { suggestion = await this.engine.suggestTitle(work.conversationId); }
    catch { return; }
    // Another sample for this work settled first (a second request finished
    // while this one was in flight): only one may name it.
    if (!this.titlePending.has(work.id)) return;
    // A name the user saved while the sample was in flight wins, even when it
    // is the same temporary name the work had.
    if (this.renamed.has(work.id)) return;
    // Someone else named the work, or the sample answered without text: there
    // is nothing left to wait for.
    if (work.title !== before || !suggestion) {
      this.clearTitlePending(work);
      this.changed();
      return;
    }
    work.title = suggestion.title;
    this.clearTitlePending(work);
    if (suggestion.usage)
      work.details = (work.details + `Título automático: ${suggestion.usage.input} de entrada (${suggestion.usage.cached} en caché), ${suggestion.usage.output} de salida.\n`).slice(-100000);
    this.changed();
    try { await this.engine.renameWork(work.conversationId, work.title); }
    catch (error) {
      work.details = (work.details + `No pude guardar el título en la sesión: ${String(error)}\n`).slice(-100000);
      this.changed();
    }
  }
  private event(event: EngineEvent) {
    if (event.type === "protection") {
      this.publish({ type: "snapshot", state: this.snapshot() });
      return;
    }
    if (event.type === "availability") {
      this.available = event.available;
      this.exhausted = event.exhausted ?? false;
      this.resumed.clear();
      if (!event.available) {
        this.accountState = { connected: false };
        for (const work of this.works)
          if (work.busy) {
            work.busy = false;
            work.progress =
              "Bitácora se detuvo. Podés continuar cuando vuelva.";
          }
      }
      if (!event.available) for (const work of this.works) this.finishFiles(work);
      this.changed();
      return;
    }
    if (event.type === "account") {
      this.accountState = event.account;
      this.publish({ type: "snapshot", state: this.snapshot() });
      return;
    }
    const work =
      "conversationId" in event
        ? this.works.find((w) => w.conversationId === event.conversationId)
        : undefined;
    if (!work) {
      if (event.type === "problem")
        this.publish({
          type: "problem",
          text: !this.available ? "Bitácora se detuvo. Tus trabajos siguen guardados." : problemText(event.kind),
          detail: event.detail,
        });
      return;
    }
    switch (event.type) {
      case "title":
        if (!this.renamed.has(work.id)) work.title = event.title;
        break;
      case "progress":
        work.progress = activityText[event.activity];
        break;
      case "message": {
        const message = work.messages.find((m) => m.id === event.id);
        if (message)
          message.text = event.delta ? message.text + event.text : event.text;
        else
          work.messages.push({
            id: event.id,
            role: "assistant",
            text: event.text,
          });
        break;
      }
      case "detail":
        work.details = (work.details + event.text + "\n").slice(-100000);
        break;
      case "problem":
        work.problem = problemText(event.kind);
        work.details = (work.details + event.detail + "\n").slice(-100000);
        if (event.kind === "disconnected")
          this.accountState = { connected: false };
        break;
      case "finished":
        work.busy = false;
        this.finishFiles(work);
        if (event.status === "completed") work.problem = undefined;
        work.progress =
          event.status === "interrupted"
            ? "Trabajo pausado."
            : event.status === "failed"
              ? "El pedido no se pudo completar."
              : "Listo.";
        // Only a completed request has a conversation worth summarizing: a
        // failed or paused one keeps the fallback name, and the next completed
        // request titles the work instead.
        if (event.status === "completed") {
          const task = this.generateTitle(work);
          this.titleTasks.add(task);
          void task.catch(() => {}).finally(() => this.titleTasks.delete(task));
        }
        break;
    }
    work.updatedAt = new Date().toISOString();
    if (
      (event.type === "message" && event.delta) ||
      event.type === "detail" ||
      event.type === "progress"
    ) {
      this.dirty = true;
      if (!this.flushTimer)
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          if (this.dirty) this.changed();
        }, 1000);
      if (event.type === "message")
        this.publish({
          type: "message",
          workId: work.id,
          id: event.id,
          text: event.text,
          delta: event.delta,
        });
      else if (event.type === "progress")
        this.publish({ type: "snapshot", state: this.snapshot() });
    } else this.changed();
  }
  async command(
    command: ClientCommand,
    reply: (message: ServerMessage) => void,
  ) {
    if (command.type === "undo" || command.type === "discardUndo") {
      if (this.submitting || this.works.some(w => w.busy) || !this.backups) {
        reply({ type: "problem", text: this.backups ? "Esperá a que termine el pedido actual para deshacer." : "No hay una copia disponible para deshacer." }); return;
      }
      this.submitting = true;
      const undoWork = this.works.find(w => w.id === this.backups!.target?.workId);
      if (undoWork) undoWork.details += `Papelera de Bitácora: ${this.backups.trashLocation}\n`;
      this.changed();
      try {
        const result = command.type === "discardUndo" ? await this.backups.discard(command.id) : await this.backups.undo(command.id);
        this.notice = `Listo. Deshice ${result.restored.length} cambios. Lo que agregaste o cambiaste después quedó como estaba.`;
        if ('remaining' in result && Array.isArray(result.remaining)) this.notice = `Dejé la carpeta como está. Podés seguir trabajando. Quedó revertido: ${result.restored.map(p => p.split(/[\\/]/).at(-1)).join(', ') || 'ningún archivo'}. No quedó revertido: ${result.remaining.join(', ') || 'ningún archivo'}.`;
        if (result.skipped.length) this.notice += ` Dejé ${result.skipped.length} sin tocar porque cambiaron después: ${result.skipped.join(', ')}.`;
        if (result.omitted.length) this.notice += ` No pude guardar copia de ${result.omitted.join(', ')}, así que eso no lo puedo deshacer.`;
        const reverted = this.works.find(w => w.id === result.target.workId)?.messages.find(m => m.id === result.target.messageId);
        for (const file of reverted?.results || []) if (result.restored.includes(file.path)) file.reverted = true;
      } catch (error) {
        this.notice = error instanceof RestoreProblem ? error.message : this.backups.restoring
          ? "No pude completar Deshacer. Podés reintentar o dejar la carpeta como está."
          : "No pude empezar Deshacer. Podés seguir trabajando o volver a intentarlo.";
      } finally { this.fileRevision++; this.submitting = false; this.changed(); }
      return;
    }
    if (command.type === "prepareProtection") {
      if (this.starting || !this.available || this.submitting || this.works.some(w => w.busy)) return;
      await this.engine.prepareProtection();
      return;
    }
    if (command.type === "retry") {
      await this.engine.retry();
      return;
    }
    if (command.type === "connect") {
      if (this.starting || this.engine.executionSafety().status === "preparing") {
        reply({ type: "problem", text: "Estoy preparando la protección de tu compu. Esperá un momento y volvé a intentar conectar." });
        return;
      }
      reply({ type: "login", ...(await this.engine.connectAccount()) });
      return;
    }
    if (command.type === "rename") {
      const work = this.works.find((w) => w.id === command.workId);
      if (!work) throw new Error("Unknown work");
      const title = typeof command.title === "string" ? command.title.trim().replace(/\s+/g, " ") : "";
      if (!title || title.length > MAX_TITLE) {
        reply({ type: "problem", text: `Escribí un nombre de hasta ${MAX_TITLE} letras.` });
        return;
      }
      work.title = title;
      // A chosen name is final: no automatic title replaces it later, not even
      // one the engine reports after a restart.
      this.titlePending.delete(work.id);
      delete work.titlePending;
      work.renamedByUser = true;
      this.renamed.add(work.id);
      this.changed();
      try { await this.engine.renameWork(work.conversationId, title); }
      catch (error) {
        work.details = (work.details + `No pude guardar el nombre en la sesión: ${String(error)}\n`).slice(-100000);
        this.changed();
      }
      return;
    }
    if (command.type === "interrupt") {
      const work = this.works.find((w) => w.id === command.workId);
      if (!work) throw new Error("Unknown work");
      // Nothing reached the engine yet: remember the pause for the moment the
      // request is sent, so it cannot run to completion in the meantime.
      if (this.unsent.has(work.id)) {
        this.pauseRequested.add(work.id);
        return;
      }
      await this.engine.interrupt(work.conversationId);
      return;
    }
    if (
      typeof command.text !== "string" ||
      !command.text.trim() ||
      command.text.length > 20000
    )
      throw new Error("Invalid request");
    if (this.backups?.restoring) { reply({ type: "problem", text: "Primero elegí Reintentar deshacer o Dejar la carpeta como está." }); return; }
    if (this.submitting || this.works.some((w) => w.busy)) {
      reply({
        type: "problem",
        text: "Esperá a que termine el pedido actual o pausalo.",
      });
      return;
    }
    if (this.starting || !this.available || !this.engine.executionSafety().allowed) {
      const safety = this.engine.executionSafety();
      reply({
        type: "problem",
        text: this.starting
          ? "Esperá a que Bitácora termine de prepararse para enviar el pedido."
          : !this.available
            ? "Bitácora está detenida. Esperá a que vuelva para enviar el pedido."
            : safety.issue === "readBlock"
              ? "No pude activar el bloqueo que impide leer archivos fuera de tu carpeta. Sin eso no puedo empezar tus pedidos. Tocá Reintentar para volver a intentarlo."
              : "No puedo enviar pedidos porque la protección de la carpeta no está preparada. Hace falta completar la preparación de Windows.",
        detail: safety.detail,
      });
      return;
    }
    const uploads = this.workspace?.validate(command.attachments);
    if (command.attachments?.length && !this.workspace) throw new Error("Attachments unavailable");
    this.submitting = true;
    let work: SavedWork | undefined;
    let attachments: FileRef[] = [];
    let committed = false;
    let newWork = false;
    try {
      this.accountState = await this.engine.account();
      this.publish({ type: "snapshot", state: this.snapshot() });
      if (!this.accountState.connected) {
        reply({ type: "problem", text: problemText("disconnected") });
        return;
      }
      if (command.workId) {
        work = this.works.find((w) => w.id === command.workId);
        if (!work) throw new Error("Unknown work");
        if (!this.resumed.has(work.id)) {
          await this.engine.resumeWork(work.conversationId);
          this.resumed.add(work.id);
        }
      } else {
        const created = await this.engine.createWork();
        const now = new Date().toISOString();
        work = {
          id: randomUUID(),
          title: created.title || fallbackTitle(command.text),
          conversationId: created.conversationId,
          createdAt: now,
          updatedAt: now,
          messages: [],
          details: "",
          busy: false,
          progress: "",
        };
        newWork = true;
        // A name the engine already provides is used as is.
        if (!created.title) {
          work.titlePending = true;
          this.titlePending.add(work.id);
        }
      }
      attachments = await this.workspace?.attach(work.id, uploads || []) || [];
      const messageId = randomUUID();
      if (this.workspace) this.backupReceipt = randomUUID();
      this.notice = undefined;
      let before: FileScan | undefined;
      if (this.backups) {
        if (!await this.backups.before({ workId: work.id, title: work.title, request: command.text.trim().slice(0, 160), messageId }, this.backupReceipt)) this.notice = "No pude guardar la copia de este pedido. Esta vez no vas a poder deshacer.";
        before = this.backups.lastScan || { entries: {}, warnings: ["No pude revisar todos los resultados."], hashedBytes: 0, visited: 0 };
      } else before = await this.workspace?.scan().catch(() => ({ entries: {}, warnings: ["No pude revisar todos los resultados."], hashedBytes: 0, visited: 0 }));
      if (before) {
        this.scanDetail(work, before);
        await mkdir(join(this.data, 'pending-files'), { recursive: true });
        await writeFile(this.pendingPath(work), JSON.stringify(before), 'utf8');
        work.pendingFiles = { messageId };
      }
      if (newWork) { this.works.unshift(work); this.resumed.add(work.id); }
      committed = true;
      work.messages.push({
        id: messageId,
        attachments,
        role: "user",
        text: command.text.trim(),
      });
      work.busy = true;
      work.problem = undefined;
      work.progress = "Preparando la respuesta…";
      this.unsent.add(work.id);
      this.changed();
      await this.writes;
      reply({ type: "selected", workId: work.id });
      await rememberUserUrls(this.data, command.text);
      const engineFiles = await Promise.all((attachments || []).map(async f => ({ path: await this.workspace!.safePath(f.path), mime: f.mime })));
      this.unsent.delete(work.id);
      const sending = this.engine.send(work.conversationId, command.text.trim(), engineFiles, { filesReverted: this.backups?.hasNotice(work.id) });
      if (this.pauseRequested.delete(work.id)) await this.engine.interrupt(work.conversationId);
      await sending;
      if (this.backups?.hasNotice(work.id)) {
        try { await this.backups.acknowledge(work.id); }
        catch { work.details += "No pude guardar que la sesión recibió el aviso de Deshacer.\n"; }
      }
    } catch (error) {
      if (work) {
        this.unsent.delete(work.id);
        this.pauseRequested.delete(work.id);
      }
      if (error instanceof EngineFailure && error.kind === "disconnected")
        this.accountState = { connected: false };
      if (!committed) {
        await this.workspace?.removeAttachments(attachments);
        if (work) {
          // Only a work created by this request is discarded: an existing one
          // keeps its own flags, including a pending title.
          if (newWork) this.clearTitlePending(work);
          delete work.pendingFiles;
          await rm(this.pendingPath(work), { force: true });
        }
      }
      if (work && committed) {
        work.busy = false;
        work.problem = problemText(
          error instanceof EngineFailure ? error.kind : "other",
        );
        work.progress =
          "El pedido se detuvo. Revisá el detalle antes de volver a enviarlo.";
        work.details += String(error) + "\n";
        this.finishFiles(work);
        this.changed();
      }
      throw error;
    } finally {
      this.submitting = false;
      this.publish({ type: "snapshot", state: this.snapshot() });
    }
  }
  async close() {
    clearTimeout(this.flushTimer);
    // The desktop shell gives us a short grace period. Queue the current
    // transcript before waiting for titles, scans or Codex shutdown.
    for (const work of this.works) {
      if (!work.busy || this.scanning.has(work.id)) continue;
      work.busy = false;
      work.progress = "El trabajo se detuvo al cerrar la app. Podés continuarlo.";
      this.dirty = true;
    }
    if (this.dirty) this.changed();
    // A title already on its way gets a short, bounded chance to finish before
    // the engine stops. If it does not, the work stays pending and the next
    // start titles it.
    await Promise.race([
      Promise.all([...this.titleTasks].map((task) => task.catch(() => {}))),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TITLE_CLOSE_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    await this.engine.close();
    this.unsubscribe?.();
    await Promise.all(this.scans);
    // Stopping the engine settles whatever title request was still in flight,
    // so nothing writes after close() returns.
    await Promise.all([...this.titleTasks].map((task) => task.catch(() => {})));
    clearTimeout(this.flushTimer);
    // Wait for the last write so a failure marks the change as unsaved, then
    // retry it before closing.
    await this.writes.catch(() => {});
    if (this.dirty) this.changed();
    await this.writes;
  }
}
