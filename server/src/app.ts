import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Engine, EngineEvent } from "./engine";
import { problemText, EngineFailure } from "./engine";
import type { Work, Snapshot, ClientCommand, ServerMessage } from "./contracts";

type SavedWork = Work & { conversationId: string };
export class App {
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
  ) {}
  async start() {
    await mkdir(this.data, { recursive: true });
    try {
      const saved = JSON.parse(
        await readFile(join(this.data, "works.json"), "utf8"),
      );
      if (saved.version !== 1 || !Array.isArray(saved.works))
        throw new Error("Invalid saved work list");
      this.works = saved.works;
      for (const work of this.works)
        if (work.busy) {
          work.busy = false;
          work.progress =
            "El trabajo se detuvo al cerrar la app. Podés continuarlo.";
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.unsubscribe = this.engine.subscribe((event) => this.event(event));
    await this.engine.start();
    this.accountState = await this.engine.account();
  }
  snapshot(): Snapshot {
    return {
      account: this.accountState,
      works: this.works.map(({ conversationId: _, ...work }) => work),
    };
  }
  private changed() {
    const content = JSON.stringify({ version: 1, works: this.works }, null, 2);
    this.writes = this.writes.then(async () => {
      await writeFile(join(this.data, "works.json.tmp"), content, "utf8");
      await rename(
        join(this.data, "works.json.tmp"),
        join(this.data, "works.json"),
      );
    });
    // Keep a failed persistence operation visible and prevent subsequent writes from masking it.
    void this.writes.catch((error) =>
      this.publish({
        type: "problem",
        text: "No pude guardar el trabajo. No cierres la app todavía.",
        detail: String(error),
      }),
    );
    this.publish({ type: "snapshot", state: this.snapshot() });
  }
  private event(event: EngineEvent) {
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
          text: problemText(event.kind),
          detail: event.detail,
        });
      return;
    }
    switch (event.type) {
      case "title":
        work.title = event.title;
        break;
      case "progress":
        work.progress = event.text;
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
    this.changed();
  }
  async command(
    command: ClientCommand,
    reply: (message: ServerMessage) => void,
  ) {
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
    this.submitting = true;
    let work: SavedWork | undefined;
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
        this.works.unshift(work);
        this.resumed.add(work.id);
      }
      work.messages.push({
        id: randomUUID(),
        role: "user",
        text: command.text.trim(),
      });
      work.busy = true;
      work.problem = undefined;
      work.progress = "Preparando la respuesta…";
      this.changed();
      await this.writes;
      reply({ type: "selected", workId: work.id });
      await this.engine.send(work.conversationId, command.text.trim());
    } catch (error) {
      if (error instanceof EngineFailure && error.kind === "disconnected")
        this.accountState = { connected: false };
      if (work) {
        work.busy = false;
        work.problem = problemText(
          error instanceof EngineFailure ? error.kind : "other",
        );
        work.progress =
          "El pedido se detuvo. Revisá el detalle antes de volver a enviarlo.";
        work.details += String(error) + "\n";
        this.changed();
      }
      throw error;
    } finally {
      this.submitting = false;
    }
  }
  async close() {
    await this.engine.close();
    this.unsubscribe?.();
    await this.writes;
  }
}
