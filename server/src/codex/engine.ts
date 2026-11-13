import {
  spawn,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import type { Engine, EngineEvent, Account, ExecutionSafety } from "../engine";
import { EngineFailure } from "../engine";
import type { ClientRequest } from "./generated/ClientRequest";
import type { ServerNotification } from "./generated/ServerNotification";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse";
import type { ConfigReadResponse } from "./generated/v2/ConfigReadResponse";
import type { WindowsSandboxReadinessResponse } from "./generated/v2/WindowsSandboxReadinessResponse";

type Responses = {
  initialize: unknown;
  "windowsSandbox/readiness": WindowsSandboxReadinessResponse;
  "config/read": ConfigReadResponse;
  "account/read": GetAccountResponse;
  "account/login/start": LoginAccountResponse;
  "account/login/cancel": unknown;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "turn/start": TurnStartResponse;
  "turn/interrupt": unknown;
};
export function classifyProblem(
  error: unknown,
): Extract<EngineEvent, { type: "problem" }>["kind"] {
  const text = JSON.stringify(error);
  if (/usageLimitExceeded|sessionBudgetExceeded/.test(text)) return "limit";
  if (/unauthorized|not authenticated|not logged in|401/i.test(text))
    return "disconnected";
  if (/rateLimitExceeded|serverOverloaded/.test(text)) return "temporary";
  return "other";
}

export class CodexEngine implements Engine {
  private safety: ExecutionSafety = {
    allowed: false,
    detail: "Execution safety has not been checked",
  };
  private available = false;
  private restartTimer?: NodeJS.Timeout;
  private attempts = 0;
  private starting = new Map<
    string,
    { completed: boolean; interrupt: boolean }
  >();
  executionSafety() {
    return this.safety;
  }
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private listeners = new Set<(event: EngineEvent) => void>();
  private turns = new Map<string, string>();
  private loginId?: string;
  private stopping = false;
  private stderr = "";
  constructor(
    private options: {
      home: string;
      workspace: string;
      binary?: string;
      args?: string[];
      restartDelayMs?: number;
    },
  ) {}
  subscribe(listener: (event: EngineEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: EngineEvent) {
    for (const listener of this.listeners) listener(event);
  }
  async start() {
    await mkdir(this.options.home, { recursive: true });
    await mkdir(this.options.workspace, { recursive: true });
    const binary = this.options.binary || "codex";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: this.options.home,
    };
    for (const key of Object.keys(env)) {
      if (
        /^CODEX_/i.test(key) ||
        /(?:API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN)$/i.test(key)
      )
        delete env[key];
    }
    env.CODEX_HOME = this.options.home;
    const version = this.options.args
      ? "codex-cli 0.168.0"
      : execFileSync(binary, ["--version"], {
          env,
          encoding: "utf8",
          windowsHide: true,
        }).trim();
    if (version !== "codex-cli 0.168.0")
      throw new Error(`Expected codex-cli 0.168.0, received ${version}`);
    this.child = spawn(
      binary,
      this.options.args || [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        'cli_auth_credentials_store="file"',
      ],
      { cwd: this.options.workspace, env, windowsHide: true, stdio: "pipe" },
    );
    const child = this.child;
    let failed = false;
    const failedChild = (error: Error) => {
      if (failed || this.child !== child) return;
      failed = true;
      this.child = undefined;
      child.kill();
      this.fail(error);
    };
    this.stderr = "";
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch (error) {
        failedChild(new Error(`Invalid engine message: ${String(error)}`));
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-16000);
    });
    this.child.stdin.on("error", failedChild);
    this.child.on("error", failedChild);
    this.child.on("exit", () => {
      failedChild(new Error(`Codex process stopped. ${this.stderr}`));
    });
    try {
      await this.rpc("initialize", {
        clientInfo: { name: "bitacora", title: "Bitácora", version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.write({ method: "initialized" });
      try {
        const readiness = await this.rpc("windowsSandbox/readiness", undefined);
        const { config } = await this.rpc("config/read", {
          includeLayers: false,
        });
        const windows = config.windows as { sandbox?: string } | null;
        const mode = windows?.sandbox;
        this.safety = {
          allowed: readiness.status === "ready",
          detail: `windowsSandbox/readiness=${readiness.status}; windows.sandbox=${mode || (readiness.status === "ready" ? "effective restricted backend (legacy features or managed configuration)" : "disabled")}; workspace-write`,
        };
      } catch (error) {
        if (this.child !== child) throw error;
        this.safety = {
          allowed: false,
          detail: `Execution safety check failed: ${String(error)}`,
        };
      }
      if (this.child !== child)
        throw new Error("Engine stopped during initialization");
      this.available = true;
      const account = await this.account();
      if (this.child !== child)
        throw new Error("Engine stopped during account read");
      this.emit({ type: "availability", available: true, safety: this.safety });
      this.emit({ type: "account", account });
    } catch (error) {
      failedChild(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  private write(value: unknown) {
    if (!this.child || this.child.stdin.destroyed)
      throw new Error("Engine unavailable");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  private rpc<M extends keyof Responses>(
    method: M,
    params: Extract<ClientRequest, { method: M }>["params"],
  ): Promise<Responses[M]> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Engine request timed out: ${method}. Do not automatically retry.`,
          ),
        );
      }, 45000);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.available = false;
    if (!this.stopping) {
      this.emit({
        type: "availability",
        available: false,
        safety: this.safety,
      });
      for (const conversationId of this.turns.keys()) {
        this.emit({
          type: "problem",
          conversationId,
          kind: "other",
          detail: error.message,
        });
        this.emit({ type: "finished", conversationId, status: "failed" });
      }
      this.turns.clear();
      this.starting.clear();
      this.loginId = undefined;
      this.emit({ type: "problem", kind: "other", detail: error.message });
      if (!this.restartTimer && this.attempts < 5) {
        const delay =
          (this.options.restartDelayMs ?? 500) * 2 ** this.attempts++;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          void this.start().catch((error) => {
            if (!this.restartTimer) this.fail(error);
          });
        }, delay);
      }
    }
  }
  private receive(message: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  }) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new EngineFailure(
            classifyProblem(message.error),
            JSON.stringify(message.error),
          ),
        );
      else pending.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      // Interactive tools are outside this issue. Reject explicitly; never leave Codex waiting.
      this.write({
        id: message.id,
        error: {
          code: -32601,
          message: "Interactive requests are not supported by Bitacora.",
        },
      });
    } else if (message.method) this.notification(message as ServerNotification);
  }
  private notification(n: ServerNotification) {
    switch (n.method) {
      case "account/updated":
      case "account/login/completed":
        if (n.method === "account/login/completed") {
          this.loginId = undefined;
          if (!n.params.success)
            this.emit({
              type: "problem",
              kind: "disconnected",
              detail: n.params.error || "Login cancelled",
            });
        }
        void this.account()
          .then((account) => this.emit({ type: "account", account }))
          .catch((error) =>
            this.emit({
              type: "problem",
              kind: "other",
              detail: String(error),
            }),
          );
        break;
      case "thread/name/updated":
        if (n.params.threadName)
          this.emit({
            type: "title",
            conversationId: n.params.threadId,
            title: n.params.threadName,
          });
        break;
      case "turn/started":
        this.turns.set(n.params.threadId, n.params.turn.id);
        this.emit({
          type: "progress",
          conversationId: n.params.threadId,
          activity: "preparing",
        });
        break;
      case "item/agentMessage/delta":
        this.emit({
          type: "message",
          conversationId: n.params.threadId,
          id: n.params.itemId,
          text: n.params.delta,
          delta: true,
        });
        break;
      case "item/started":
      case "item/completed": {
        const { threadId: conversationId, item } = n.params;
        if (item.type === "agentMessage") {
          if (n.method === "item/started")
            this.emit({
              type: "progress",
              conversationId,
              activity: "responding",
            });
          if (n.method === "item/completed")
            this.emit({
              type: "message",
              conversationId,
              id: item.id,
              text: item.text,
              delta: false,
            });
        } else if (item.type !== "userMessage") {
          const activity =
            item.type === "commandExecution"
              ? item.commandActions.length > 0 &&
                item.commandActions.every((action) => action.type !== "unknown")
                ? "reading"
                : "executing"
              : item.type === "fileChange"
                ? "writing"
                : item.type === "webSearch" || item.type === "mcpToolCall"
                  ? "tool"
                  : "preparing";
          this.emit({ type: "progress", conversationId, activity });
          this.emit({
            type: "detail",
            conversationId,
            text: JSON.stringify(item),
          });
        }
        if (n.method === "item/completed")
          this.emit({ type: "checkpoint", conversationId });
        break;
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        this.emit({
          type: "detail",
          conversationId: n.params.threadId,
          text: n.params.delta,
        });
        break;
      case "error":
        // The final failure belongs to turn/completed; retries are only activity.
        this.emit({
          type: "detail",
          conversationId: n.params.threadId,
          text: JSON.stringify(n.params),
        });
        if (n.params.willRetry)
          this.emit({
            type: "progress",
            conversationId: n.params.threadId,
            activity: "retrying",
          });
        break;
      case "turn/completed": {
        const { threadId: conversationId, turn } = n.params;
        this.turns.delete(conversationId);
        const starting = this.starting.get(conversationId);
        if (starting) starting.completed = true;
        if (turn.error)
          this.emit({
            type: "problem",
            conversationId,
            kind: classifyProblem(turn.error),
            detail: JSON.stringify(turn.error),
          });
        this.emit({
          type: "finished",
          conversationId,
          status: turn.status === "inProgress" ? "failed" : turn.status,
        });
        break;
      }
    }
  }
  async account(): Promise<Account> {
    const { account } = await this.rpc("account/read", { refreshToken: false });
    return account?.type === "chatgpt"
      ? { connected: true, email: account.email || undefined }
      : { connected: false };
  }
  async connectAccount() {
    if (this.loginId)
      await this.rpc("account/login/cancel", { loginId: this.loginId });
    const login = await this.rpc("account/login/start", { type: "chatgpt" });
    if (login.type !== "chatgpt") throw new Error("Expected ChatGPT login");
    this.loginId = login.loginId;
    return { url: login.authUrl };
  }
  private settings() {
    return {
      cwd: this.options.workspace,
      approvalPolicy: "never" as const,
      sandbox: "workspace-write" as const,
      developerInstructions:
        "Respondé en castellano rioplatense, simple y sin términos técnicos. Trabajá en la carpeta actual. No generes imágenes con IA.",
    };
  }
  async createWork() {
    const { thread } = await this.rpc("thread/start", this.settings());
    return { conversationId: thread.id, title: thread.name || undefined };
  }
  async resumeWork(conversationId: string) {
    await this.rpc("thread/resume", {
      threadId: conversationId,
      ...this.settings(),
    });
  }
  async send(conversationId: string, text: string) {
    if (!this.available || !this.safety.allowed)
      throw new EngineFailure("other", this.safety.detail);
    const state = { completed: false, interrupt: false };
    this.starting.set(conversationId, state);
    try {
      const { turn } = await this.rpc("turn/start", {
        threadId: conversationId,
        input: [{ type: "text", text, text_elements: [] }],
        cwd: this.options.workspace,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [this.options.workspace],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
      if (!state.completed && turn.status === "inProgress" && this.available) {
        this.turns.set(conversationId, turn.id);
        if (state.interrupt) await this.interrupt(conversationId);
      }
    } finally {
      this.starting.delete(conversationId);
    }
  }
  async interrupt(conversationId: string) {
    const starting = this.starting.get(conversationId);
    if (starting) starting.interrupt = true;
    const turnId = this.turns.get(conversationId);
    if (turnId)
      await this.rpc("turn/interrupt", { threadId: conversationId, turnId });
  }
  async close() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill(), 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  }
}
