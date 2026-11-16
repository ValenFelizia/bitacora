import type { Engine, EngineEvent, Account, ExecutionSafety, SuggestedTitle } from "../src/engine";
export class FakeEngine implements Engine {
  listeners = new Set<(event: EngineEvent) => void>();
  connected = true;
  resumed: string[] = [];
  sent: string[] = [];
  calls: string[] = [];
  count = 0;
  safe = true;
  /** What `suggestTitle` answers; undefined behaves like a sample with no usable text. */
  suggested?: string;
  /** A sample that could not run at all (engine closing, thread busy, RPC error). */
  titleFails = false;
  /** The engine refuses to store the name. */
  renameFails = false;
  /** The conversation cannot be resumed before a send. */
  resumeFails = false;
  /** Held open by a test to rename while the suggestion is in flight. */
  titleGate?: Promise<void>;
  /** Set by close(): a sample that was still waiting cannot run any more. */
  closed = false;
  private titleRelease?: () => void;
  renamed: { conversationId: string; title: string }[] = [];
  async retry() {}
  async prepareProtection() { this.safe = true; this.emit({ type: "protection", safety: this.executionSafety() }); }
  executionSafety(): ExecutionSafety {
    return { allowed: this.safe, detail: "fake restricted execution" };
  }
  async start() {}
  async connectAccount() {
    this.connected = true;
    this.emit({ type: "account", account: await this.account() });
    return { url: "https://example.test/login" };
  }
  async account(): Promise<Account> {
    return { connected: this.connected };
  }
  async createWork() {
    return { conversationId: `conversation-${++this.count}` };
  }
  async resumeWork(id: string) {
    if (this.resumeFails) throw new Error("resume failed");
    this.resumed.push(id);
  }
  async suggestTitle(id: string): Promise<SuggestedTitle | undefined> {
    this.calls.push(`title:${id}`);
    if (this.titleGate) {
      await new Promise<void>((resolve, reject) => {
        this.titleRelease = resolve;
        this.titleGate!.then(resolve, reject);
      });
    }
    if (this.closed) throw new Error("engine closed");
    if (this.titleFails) throw new Error("sample could not run");
    return this.suggested
      ? { title: this.suggested, usage: { input: 1200, cached: 1000, output: 8 } }
      : undefined;
  }
  async renameWork(id: string, title: string) {
    this.calls.push(`rename:${id}`);
    if (this.renameFails) throw new Error("rename refused");
    this.renamed.push({ conversationId: id, title });
  }
  async send(id: string, text: string, _files?: import("../src/engine").EngineFile[]) {
    this.calls.push(`send:${id}`);
    this.sent.push(text);
    this.emit({
      type: "progress",
      conversationId: id,
      activity: "reading",
    });
  }
  async interrupt(id: string) {
    this.calls.push(`interrupt:${id}`);
    this.emit({ type: "finished", conversationId: id, status: "interrupted" });
  }
  subscribe(fn: (event: EngineEvent) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event: EngineEvent) {
    for (const fn of this.listeners) fn(event);
  }
  async close() { this.closed = true; this.titleRelease?.(); }
}
