import type { Engine, EngineEvent, Account } from "../src/engine";
export class FakeEngine implements Engine {
  listeners = new Set<(event: EngineEvent) => void>();
  connected = true;
  resumed: string[] = [];
  sent: string[] = [];
  count = 0;
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
  async send(id: string, text: string) {
    this.sent.push(text);
    this.emit({
      type: "progress",
      conversationId: id,
      text: "Leyendo los archivos…",
    });
  }
  async interrupt(id: string) {
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
