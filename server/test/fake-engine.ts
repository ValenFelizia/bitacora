import type { Engine, EngineEvent, Account, ExecutionSafety, SuggestedTitle } from "../src/engine";
import type { EngineModel, ModelSelection } from "../src/models";

const model = (id: string, displayName: string, isDefault = false): EngineModel => ({
  id,
  displayName,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "low",
  isDefault,
});
/** The visible part of the catalogue 0.168.0 returned for a Plus account on 18/11. */
export const FAKE_CATALOGUE: EngineModel[] = [
  model("gpt-6.2-sol", "GPT-6.2-Sol", true),
  model("gpt-6.2-astra", "GPT-6.2-Astra"),
  model("gpt-6.1-terra", "GPT-6.1 Terra"),
  model("gpt-6.1-sol", "GPT-6.1-Sol"),
  model("gpt-6-astra", "GPT-6-Astra"),
  model("gpt-6-luna", "GPT-6-Luna"),
];

export class FakeEngine implements Engine {
  /** What `models()` answers; `"fail"` makes it reject. */
  catalogue: EngineModel[] | "fail" = FAKE_CATALOGUE;
  /** The model each thread start, resume and turn asked for, in order. */
  modelRequests: { call: "create" | "resume" | "send"; model?: ModelSelection }[] = [];
  /** How many times the app asked for the list. */
  modelLists = 0;
  async models() {
    this.modelLists++;
    if (this.catalogue === "fail") throw new Error("model list failed");
    return this.catalogue;
  }
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
  /** The account's mail; another value is another account. */
  email?: string;
  async account(): Promise<Account> {
    return this.email ? { connected: this.connected, email: this.email } : { connected: this.connected };
  }
  async createWork(model?: ModelSelection) {
    this.modelRequests.push({ call: "create", model });
    return { conversationId: `conversation-${++this.count}` };
  }
  async resumeWork(id: string, model?: ModelSelection) {
    if (this.resumeFails) throw new Error("resume failed");
    this.modelRequests.push({ call: "resume", model });
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
  async send(id: string, text: string, _files?: import("../src/engine").EngineFile[], context?: { filesReverted?: boolean; model?: ModelSelection }) {
    this.modelRequests.push({ call: "send", model: context?.model });
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
  /** Answers the app sent, in order. */
  answers: { conversationId: string; questionId: string; answers: Record<string, string[]> }[] = [];
  /** The question is no longer waiting on the engine side. */
  answerFails = false;
  async answer(conversationId: string, questionId: string, answers: Record<string, string[]>) {
    if (this.answerFails) throw new Error("question no longer waiting");
    this.answers.push({ conversationId, questionId, answers });
  }
  /** Keys the app asked to forget, so a test can tell a dropped notice apart. */
  forgotten: string[] = [];
  forgetDetails(keys: readonly string[]) {
    this.forgotten.push(...keys);
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
