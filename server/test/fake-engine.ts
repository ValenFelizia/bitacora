import type { Engine, EngineEvent, Account } from "../src/engine";
export class FakeEngine implements Engine {
  listeners = new Set<(event: EngineEvent) => void>();
  connected = true;
  resumed: string[] = [];
  sent: string[] = [];
  calls: string[] = [];
  count = 0;
  safe = true;
  async retry() {}
  async prepareProtection() { this.safe = true; this.emit({ type: "protection", safety: this.executionSafety() }); }
  executionSafety() {
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
    this.resumed.push(id);
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
  async close() {}
}
