import { mkdir, readFile, writeFile, rename, copyFile, rm } from "node:fs/promises";
import { WorkspaceFiles, type FileScan } from "./workspace-files";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rememberUserUrls } from './allowed-urls';
import { initializeKit } from './tools/kit';
import type { Engine, EngineEvent } from "./engine";
import { problemText, EngineFailure, activityText } from "./engine";
import type { FileRef, Work, Snapshot, ClientCommand, ServerMessage } from "./contracts";

type SavedWork = Work & { conversationId: string; pendingFiles?: { messageId: string; before?: Record<string, string> } };
export class App {
  private scanning = new Set<string>();
  private scans = new Set<Promise<void>>();
  private notice?: string;
  private available = false;
  private exhausted = false;
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;
  private works: SavedWork[] = [];
  private accountState = { connected: false };
  private writes: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private submitting = false;
  private resumed = new Set<string>();
  constructor(
    private engine: Engine,
    private data: string,
    private publish: (message: ServerMessage) => void,
    private files = { rename, copyFile },
    private workspace?: WorkspaceFiles,
  ) {}
  async start() {
    await mkdir(this.data, { recursive: true });
    await this.workspace?.initialize();
    if (this.workspace) await initializeKit(this.workspace.root, this.data);
    try {
      const saved = JSON.parse(
        await readFile(join(this.data, "works.json"), "utf8"),
      );
      if (!saved || saved.version !== 1 || !Array.isArray(saved.works))
        throw new SyntaxError("Invalid saved work list");
      if (
        saved.works.some(
          (w: SavedWork) =>
            !w ||
            typeof w.id !== "string" ||
            typeof w.conversationId !== "string" ||
            !Array.isArray(w.messages) ||
            typeof w.details !== "string",
        )
      )
        throw new SyntaxError("Invalid saved work");
      this.works = saved.works;
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
    for (const work of this.works) if (work.pendingFiles) { await this.collectResults(work); this.dirty = true; }
    this.unsubscribe = this.engine.subscribe((event) => this.event(event));
    await this.engine.start();
    this.available = true;
    this.accountState = await this.engine.account();
  }
  snapshot(): Snapshot {
    return {
      account: this.available ? this.accountState : { connected: false },
      engine: {
        available: this.available,
        exhausted: this.exhausted,
        safety: this.engine.executionSafety(),
      },
      notice: this.notice,
      works: this.works.map(({ conversationId: _, pendingFiles: __, ...work }) => work),
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
    this.dirty = false;
    const content = JSON.stringify({ version: 1, works: this.works }, null, 2);
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await writeFile(join(this.data, "works.json.tmp"), content, "utf8");
        await this.renameWithRetry(join(this.data, "works.json.tmp"), join(this.data, "works.json"));
      });
    // Report each failure while allowing the next write to recover.
    void this.writes.catch((error) =>
      this.publish({
        type: "problem",
        text: "No pude guardar el trabajo. No cierres la app todavía.",
        detail: String(error),
      }),
    );
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
      const after = await this.workspace.scan(before);
      this.scanDetail(work, after);
      const message = work.messages.find(m => m.id === pending.messageId);
      if (message) message.results = Object.keys(after.entries).filter(p => after.entries[p].hash !== before.entries[p]?.hash).map(p => this.workspace!.result(p));
    } catch (error) {
      work.problem = "No pude revisar los resultados de ese pedido. Podés seguir trabajando.";
      work.details = (work.details + String(error) + "\n").slice(-100000);
    } finally {
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
              "El motor se detuvo. Podés continuar cuando vuelva.";
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
          text: !this.available ? "El motor se detuvo. Tus trabajos siguen guardados." : problemText(event.kind),
          detail: event.detail,
        });
      return;
    }
    switch (event.type) {
      case "title":
        work.title = event.title;
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
    if (command.type === "prepareProtection") {
      if (!this.available || this.submitting || this.works.some(w => w.busy)) return;
      await this.engine.prepareProtection();
      return;
    }
    if (command.type === "retry") {
      await this.engine.retry();
      return;
    }
    if (command.type === "connect") {
      reply({ type: "login", ...(await this.engine.connectAccount()) });
      return;
    }
    if (command.type === "interrupt") {
      const work = this.works.find((w) => w.id === command.workId);
      if (!work) throw new Error("Unknown work");
      await this.engine.interrupt(work.conversationId);
      return;
    }
    if (
      typeof command.text !== "string" ||
      !command.text.trim() ||
      command.text.length > 20000
    )
      throw new Error("Invalid request");
    if (this.submitting || this.works.some((w) => w.busy)) {
      reply({
        type: "problem",
        text: "Esperá a que termine el pedido actual o pausalo.",
      });
      return;
    }
    if (!this.available || !this.engine.executionSafety().allowed) {
      reply({
        type: "problem",
        text: !this.available
          ? "El motor está detenido. Esperá a que vuelva para enviar el pedido."
          : "No puedo enviar pedidos porque la protección de la carpeta no está preparada. Hace falta completar la preparación de Windows.",
        detail: this.engine.executionSafety().detail,
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
          title:
            created.title ||
            command.text.trim().replace(/\s+/g, " ").slice(0, 64),
          conversationId: created.conversationId,
          createdAt: now,
          updatedAt: now,
          messages: [],
          details: "",
          busy: false,
          progress: "",
        };
        newWork = true;
      }
      attachments = await this.workspace?.attach(work.id, uploads || []) || [];
      const messageId = randomUUID();
      const before = await this.workspace?.scan();
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
      this.changed();
      await this.writes;
      reply({ type: "selected", workId: work.id });
      await rememberUserUrls(this.data, command.text);
      await this.engine.send(work.conversationId, command.text.trim(), await Promise.all((attachments || []).map(async f => ({ path: await this.workspace!.safePath(f.path), mime: f.mime }))));
    } catch (error) {
      if (error instanceof EngineFailure && error.kind === "disconnected")
        this.accountState = { connected: false };
      if (!committed) {
        await this.workspace?.removeAttachments(attachments);
        if (work) {
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
    }
  }
  async close() {
    clearTimeout(this.flushTimer);
    await this.engine.close();
    this.unsubscribe?.();
    await Promise.all(this.scans);
    clearTimeout(this.flushTimer);
    if (this.dirty) this.changed();
    await this.writes;
  }
}
