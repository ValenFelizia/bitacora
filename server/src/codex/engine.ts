import {
  spawn,
  execFileSync,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { join, relative, basename } from "node:path";
import { codexBinary, codexVersion } from "../../../scripts/codex-runtime.mjs";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { registerKit } from './kit';
import type { Engine, EngineEvent, Account, ExecutionSafety } from "../engine";
import { EngineFailure } from "../engine";
import type { ClientRequest } from "./generated/ClientRequest";
import type { ServerNotification } from "./generated/ServerNotification";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { Turn } from "./generated/v2/Turn";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse";
import type { ConfigReadResponse } from "./generated/v2/ConfigReadResponse";
import type { WindowsSandboxReadinessResponse } from "./generated/v2/WindowsSandboxReadinessResponse";

type Responses = {
  initialize: unknown;
  "windowsSandbox/readiness": WindowsSandboxReadinessResponse;
  "config/read": ConfigReadResponse;
  "config/value/write": unknown;
  "windowsSandbox/setupStart": { started: boolean };
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

/** Schedules `run` and returns a cancel function. Defaults to `setTimeout`. */
export type ScheduleTimer = (run: () => void, delayMs: number) => () => void;

/** Runs `taskkill /T /F` on a live process tree. */
export type KillProcessTree = (pid: number) => Promise<boolean>;

/**
 * Kills the child and everything it spawned. `child.kill()` only stops the
 * app-server: the sandboxed commands the agent runs are grandchildren and
 * could keep writing files after the app takes its "after" snapshot.
 *
 * A child that already exited is never touched. Windows reuses PIDs quickly, so
 * `taskkill /T` on a dead number would stop whatever program owns it now.
 * Returns false when only the app-server could be stopped.
 */
export async function killTree(
  child: {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => boolean;
  },
  exited: boolean,
  killProcessTree?: KillProcessTree,
): Promise<boolean> {
  if (exited || child.exitCode !== null || child.signalCode !== null) return true;
  if (!child.pid) return true;
  if (!killProcessTree) {
    child.kill();
    return true;
  }
  try {
    return await killProcessTree(child.pid);
  } catch {
    // The tree could not be stopped: at least stop the app-server.
    child.kill();
    return false;
  }
}

export class CodexEngine implements Engine {
  private safety: ExecutionSafety = {
    allowed: false,
    detail: "Execution safety has not been checked",
  };
  private available = false;
  private restartTimer?: () => void;
  private attempts = 0;
  private stableTimer?: () => void;
  private exhausted = false;
  private interrupted = new Set<string>();
  private starting = new Map<
    string,
    { completed: boolean; interrupt: boolean; started: boolean }
  >();
  // Conversation whose turn made the engine stop answering: its problem event
  // tells the user the engine was restarted instead of the generic failure.
  private failing?: string;
  private pauseTimers = new Map<string, NodeJS.Timeout>();
  // Children that already exited, and the tree stops already in flight: a child
  // is never killed twice and never killed once it is gone.
  private exitedChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private treeStops = new WeakMap<ChildProcessWithoutNullStreams, Promise<boolean>>();
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
  private startAttempt?: Promise<void>;
  private stderr = "";
  constructor(
    private options: {
      home: string;
      workspace: string;
      binary?: string;
      args?: string[];
      restartDelayMs?: number;
      stableAfterMs?: number;
      scheduleTimer?: ScheduleTimer;
      probeProtection?: () => Promise<boolean>;
      requestTimeoutMs?: number;
      pauseTimeoutMs?: number;
      killTimeoutMs?: number;
      /** Test seam: replaces the `taskkill` call. */
      killProcessTree?: KillProcessTree;
      setupTimeoutMs?: number;
    },
  ) {}
  private scheduleTimer(run: () => void, delayMs: number) {
    if (this.options.scheduleTimer) return this.options.scheduleTimer(run, delayMs);
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  }
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
    const attempt = this.runStart();
    this.startAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.startAttempt === attempt) this.startAttempt = undefined;
    }
  }
  private async runStart() {
    if (this.stopping) return;
    await mkdir(this.options.home, { recursive: true });
    await mkdir(this.options.workspace, { recursive: true });
    if (!this.options.args) {
      await registerKit(this.options.home, this.options.workspace);
    }
    if (this.stopping) return;
    const binary = this.options.binary || codexBinary();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: this.options.home,
    };
    for (const key of Object.keys(env)) {
      if (
        /^(CODEX_|OPENAI_|ANTHROPIC_)/i.test(key) ||
        /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL/i.test(key)
      )
        delete env[key];
    }
    env.CODEX_HOME = this.options.home;
    const version = this.options.args
      ? codexVersion
      : execFileSync(binary, ["--version"], {
          env,
          encoding: "utf8",
          windowsHide: true,
        }).trim();
    if (version !== codexVersion)
      throw new Error(`Expected ${codexVersion}, received ${version}`);
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
        if (this.child === child) this.receive(JSON.parse(line));
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
      this.exitedChildren.add(child);
      failedChild(new Error(`Codex process stopped. ${this.stderr}`));
    });
    try {
      await this.rpc("initialize", {
        clientInfo: { name: "bitacora", title: "Bitácora", version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.write({ method: "initialized" });
      this.environment = env;
      await this.checkProtection();
      if (this.child !== child)
        throw new Error("Engine stopped during initialization");
      this.available = true;
      this.exhausted = false;
      this.stableTimer?.();
      this.stableTimer = this.scheduleTimer(() => { this.attempts = 0; }, this.options.stableAfterMs ?? 60_000);
      const account = await this.account();
      if (this.child !== child)
        throw new Error("Engine stopped during account read");
      this.emit({ type: "availability", available: true, safety: this.safety });
      this.emit({ type: "account", account });
      if (this.safety.status === "needed" && !this.safety.needsPermission) void this.prepareProtection();
    } catch (error) {
      failedChild(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  private setupMode?: "mxc" | "elevated";
  private environment: NodeJS.ProcessEnv = {};
  private mxcAvailable?: boolean;
  private setupTimer?: NodeJS.Timeout;
  private setupPending = false;
  private setupInterrupted = false;
  private checking?: Promise<void>;
  private setProtection(safety: ExecutionSafety) {
    this.safety = safety;
    this.emit({ type: "protection", safety });
  }
  private async probeMxc() {
    if (this.mxcAvailable !== undefined) return this.mxcAvailable;
    if (this.options.probeProtection) return this.mxcAvailable = await this.options.probeProtection();
    try {
      const result = await promisify(execFile)(this.options.binary || codexBinary(), [
        "-c", "windows.sandbox=mxc", "sandbox", "--include-managed-config",
        "--permission-profile", ":workspace", "--", "cmd.exe", "/d", "/c", "echo MXC_OK",
      ], { cwd: this.options.workspace, env: this.environment, windowsHide: true, timeout: 30000 });
      if (result.stdout.trim() !== "MXC_OK") throw new Error("Unexpected MXC probe output");
      return this.mxcAvailable = true;
    } catch (error) {
      // Exact diagnostic from codex-mxc-sandbox 0.168.0; timeouts and other
      // failures must never select an administrative setup.
      if (!(error as { killed?: boolean }).killed &&
          String((error as { stderr?: string }).stderr).includes("native MXC is unavailable on this Windows build"))
        return this.mxcAvailable = false;
      throw error;
    }
  }
  private checkProtection(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = this.readProtection().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async readProtection() {
    const interrupted = this.safety.status === "preparing" || this.setupInterrupted;
    this.setupInterrupted = false;
    this.setupMode = undefined;
    try {
      const readiness = await this.rpc("windowsSandbox/readiness", undefined);
      const { config } = await this.rpc("config/read", { includeLayers: false });
      const mode = (config.windows as { sandbox?: string } | null)?.sandbox;
      const detail = `windowsSandbox/readiness=${readiness.status}; windows.sandbox=${mode || "disabled"}; workspace-write`;
      const mxc = mode === "elevated" && readiness.status === "ready" ? undefined : await this.probeMxc();
      if (readiness.status === "ready" && (mode === "elevated" || (mode === "mxc" && mxc))) {
        this.setProtection({ allowed: true, status: "ready", detail });
        return;
      }
      this.setupMode = mxc ? "mxc" : "elevated";
      this.setProtection({ allowed: false, status: interrupted ? "failed" : "needed",
        needsPermission: !mxc, detail, issue: interrupted ? "interrupted" : undefined });
    } catch (error) {
      this.setProtection({ allowed: false, status: "failed", detail: String(error), issue: "check" });
    }
  }
  async prepareProtection() {
    if (!this.available || this.safety.allowed || this.safety.status === "preparing" || this.setupPending) return;
    // An unknown/ambiguous result is retried by reading state, never by
    // repeating an administrative setup whose outcome is not yet known.
    if (!this.setupMode) {
      await this.checkProtection();
      if (this.safety.status === "needed" && !this.safety.needsPermission) await this.prepareProtection();
      return;
    }
    // Mark the preparation as started before awaiting anything, so a second
    // click cannot start the Windows setup again.
    this.setProtection({ ...this.safety, allowed: false, status: "preparing", issue: undefined });
    // The setup replaces the process, so a login in progress cannot survive:
    // cancel it explicitly instead of killing it silently.
    if (this.loginId) {
      const loginId = this.loginId;
      this.loginId = undefined;
      try { await this.rpc("account/login/cancel", { loginId }); }
      catch { /* the process is replaced anyway */ }
    }
    try {
      if (this.setupMode === "mxc") {
        await this.rpc("config/value/write", { keyPath: "windows.sandbox", value: "mxc",
          mergeStrategy: "replace", filePath: join(this.options.home, "config.toml") });
        await this.reloadProtection();
      } else {
        this.setupPending = true;
        const { started } = await this.rpc("windowsSandbox/setupStart", { mode: "elevated", cwd: this.options.workspace });
        if (!started) throw new Error("Windows did not start protection setup");
        if (this.setupPending) this.setupTimer = setTimeout(() => {
          this.setupPending = false;
          this.setupMode = undefined;
          this.protectionFailed("Windows setup completion timed out", "uncertain");
        }, this.options.setupTimeoutMs ?? 180000);
      }
    } catch (error) {
      this.setupPending = false;
      if (this.setupMode === "elevated" && !(error instanceof EngineFailure)) {
        this.setupMode = undefined;
        this.protectionFailed(String(error), "uncertain");
      } else if (this.child) this.protectionFailed(String(error), "setup");
    }
  }
  private protectionFailed(detail: string, issue: ExecutionSafety["issue"] = "setup") {
    clearTimeout(this.setupTimer);
    this.setProtection({ ...this.safety, allowed: false, status: "failed", detail, issue });
  }
  private cancelPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  /** Kills the process tree and waits (bounded) until the child really exited.
   *  Returns false when only the app-server could be stopped. */
  private stopTree(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    if (!this.childRunning(child)) return Promise.resolve(true);
    const stopping = this.treeStops.get(child);
    if (stopping) return stopping;
    const stop = this.runStopTree(child);
    this.treeStops.set(child, stop);
    void stop.then(
      () => this.treeStops.delete(child),
      () => this.treeStops.delete(child),
    );
    return stop;
  }
  private async runStopTree(child: ChildProcessWithoutNullStreams) {
    // Listen before killing, so an exit that happens during the kill is seen.
    const exited = this.waitExit(child, this.options.killTimeoutMs ?? 5000);
    const complete = await this.killChildTree(child);
    return complete && (await exited);
  }
  private killChildTree(child: ChildProcessWithoutNullStreams) {
    const killProcessTree =
      this.options.killProcessTree ??
      (process.platform === "win32" ? (pid: number) => this.taskkill(pid) : undefined);
    return killTree(child, this.exitedChildren.has(child), killProcessTree);
  }
  /** `taskkill` without blocking the event loop: RPC replies and exit events
   *  must keep flowing while the tree is being stopped. */
  private async taskkill(pid: number) {
    await promisify(execFile)(
      join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: this.options.killTimeoutMs ?? 5000 },
    );
    return true;
  }
  /** Resolves true when the child is gone, false when the wait ran out. */
  private waitExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    if (!this.childRunning(child)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        child.off("exit", done);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      child.once("exit", done);
    });
  }
  private childRunning(child: ChildProcessWithoutNullStreams) {
    return (
      !this.exitedChildren.has(child) &&
      child.exitCode === null &&
      child.signalCode === null
    );
  }
  /**
   * Stops the engine for good when a turn may still be running and nothing
   * proves it will end. The exit handler runs fail(), which releases the app,
   * shows the problem and schedules the automatic restart.
   */
  private async stopUnresponsive(conversationId: string) {
    const child = this.child;
    if (!child) return;
    this.failing = conversationId;
    const complete = await this.stopTree(child);
    // A parent-only termination leaves commands running: the app must not scan
    // as if every writer had stopped.
    if (!complete)
      this.emit({
        type: "detail",
        conversationId,
        text: "No pude detener todos los procesos del motor: puede quedar algo escribiendo archivos.",
      });
  }
  private clearPause(conversationId?: string) {
    for (const [id, timer] of this.pauseTimers) {
      if (conversationId && id !== conversationId) continue;
      clearTimeout(timer);
      this.pauseTimers.delete(id);
    }
  }
  /** True while a turn is running or a request to start one is still open. */
  private running(conversationId: string) {
    return (
      this.turns.has(conversationId) ||
      this.starting.get(conversationId)?.completed === false
    );
  }
  /** A pause that does not end the turn within the pause timeout kills the
   *  engine: the turn could keep writing files the app already scanned. The
   *  deadline starts when the pause is requested, even before the turn exists,
   *  so a silent engine cannot keep it waiting for the request timeout. */
  private watchPause(conversationId: string) {
    if (this.pauseTimers.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.pauseTimers.delete(conversationId);
      if (!this.running(conversationId)) return;
      void this.stopUnresponsive(conversationId);
    }, this.options.pauseTimeoutMs ?? 15000);
    timer.unref();
    this.pauseTimers.set(conversationId, timer);
  }
  private async reloadProtection() {
    const child = this.child;
    this.child = undefined;
    this.available = false;
    this.setupPending = false;
    // The login belongs to the process that is about to be replaced.
    this.loginId = undefined;
    this.safety = { ...this.safety, allowed: false };
    this.cancelPending(new Error("Engine reloading protection"));
    clearTimeout(this.setupTimer);
    this.stableTimer?.();
    this.emit({ type: "availability", available: false, safety: this.safety });
    if (child) await this.stopTree(child);
    if (!this.stopping) try { await this.start(); } catch (error) {
      if (!this.restartTimer) this.fail(error instanceof Error ? error : new Error(String(error)));
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
      }, this.options.requestTimeoutMs ?? 45000);
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
    const failing = this.failing;
    this.setupInterrupted ||= this.safety.status === "preparing";
    this.cancelPending(error);
    this.protectionFailed(error.message, "restart");
    this.available = false;
    this.setupPending = false;
    this.safety = { ...this.safety, allowed: false };
    clearTimeout(this.setupTimer);
    this.stableTimer?.();
    this.clearPause();
    if (!this.stopping) {
      this.emit({
        type: "availability",
        available: false,
        safety: this.safety,
        exhausted: this.attempts >= 5,
      });
      for (const conversationId of this.turns.keys()) {
        this.emit({
          type: "problem",
          conversationId,
          kind: conversationId === failing ? "unresponsive" : "other",
          detail: error.message,
        });
        this.emit({ type: "finished", conversationId, status: "failed" });
      }
      this.turns.clear();
      this.starting.clear();
      this.loginId = undefined;
      this.exhausted = this.attempts >= 5;
      if (!this.restartTimer && this.attempts < 5) {
        const delay =
          (this.options.restartDelayMs ?? 500) * 2 ** this.attempts++;
        this.restartTimer = this.scheduleTimer(() => {
          this.restartTimer = undefined;
          void this.start().catch((error) => {
            if (this.child) return;
            if (!this.restartTimer && !this.exhausted) this.fail(error);
          });
        }, delay);
      }
    }
    this.failing = undefined;
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
      // Never approve an escalation or surface an interactive request to the user.
      const responses: Record<string, unknown> = {
        "item/commandExecution/requestApproval": { decision: "decline" },
        "item/fileChange/requestApproval": { decision: "decline" },
        "execCommandApproval": { decision: "abort" },
        "applyPatchApproval": { decision: "abort" },
        "item/permissions/requestApproval": { permissions: {}, scope: "turn" },
        "item/tool/requestUserInput": { answers: {} },
        "mcpServer/elicitation/request": { action: "decline", content: null, _meta: null },
        "item/tool/call": { success: false, contentItems: [] },
      };
      if (Object.hasOwn(responses, message.method)) this.write({ id: message.id, result: responses[message.method] });
      else this.write({ id: message.id, error: { code: -32601, message: "Interactive requests are not supported by Bitacora." } });
    } else if (message.method) this.notification(message as ServerNotification);
  }
  private notification(n: ServerNotification) {
    switch (n.method) {
      case "windowsSandbox/setupCompleted":
        this.setupPending = false;
        clearTimeout(this.setupTimer);
        if (!n.params.success) this.protectionFailed(n.params.error || "Windows setup failed");
        else void this.reloadProtection().catch(() => { /* fail() owns restart errors */ });
        break;
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
        {
          const starting = this.starting.get(n.params.threadId);
          if (starting) {
            // The turn is alive even if its reply never arrives.
            starting.started = true;
            if (starting.interrupt)
              void this.interrupt(n.params.threadId).catch(error => this.emit({ type: "detail", conversationId: n.params.threadId, text: String(error) }));
          }
        }
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
          this.emit({ type: "progress", conversationId, activity: item.type === 'mcpToolCall' && item.server === 'bitacora' && ['traer', 'controlar', 'dibujar'].includes(item.tool) ? item.tool as 'traer' | 'controlar' | 'dibujar' : activity });
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
        this.interrupted.delete(conversationId);
        this.clearPause(conversationId);
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
    // The engine is about to be replaced: a login started now would be lost.
    if (!this.available || this.safety.status === "preparing")
      throw new EngineFailure("other", "Protection is being prepared");
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
  /**
   * Starts a turn and resolves with its reply. When the reply does not arrive
   * in time but `turn/started` already did, it resolves without a turn: the
   * turn is running and the app must keep waiting for `turn/completed`.
   * It rejects only when the turn is certainly not running, and by then the
   * engine has been stopped and its whole process tree is gone.
   */
  private startTurn(
    conversationId: string,
    params: Extract<ClientRequest, { method: "turn/start" }>["params"],
    state: { started: boolean },
  ): Promise<Turn | undefined> {
    const id = ++this.nextId;
    return new Promise<Turn | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (state.started) {
          resolve(undefined);
          return;
        }
        void this.stopUnresponsive(conversationId).then(
          () =>
            reject(
              new EngineFailure(
                "unresponsive",
                "The engine stopped answering turn/start and was restarted",
              ),
            ),
          (error) =>
            reject(error instanceof Error ? error : new Error(String(error))),
        );
      }, this.options.requestTimeoutMs ?? 45000);
      this.pending.set(id, {
        resolve: (value) => resolve((value as TurnStartResponse).turn),
        // A stop caused by this same conversation must reach the app as the
        // restart warning, not as a generic failure.
        reject: (error) =>
          reject(
            this.failing === conversationId
              ? new EngineFailure(
                  "unresponsive",
                  `The engine stopped answering turn/start and was restarted. ${error.message}`,
                )
              : error,
          ),
        timer,
      });
      try {
        this.write({ id, method: "turn/start", params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async send(conversationId: string, text: string, files: import("../engine").EngineFile[] = [], context?: { filesReverted?: boolean }) {
    if (!this.available || !this.safety.allowed)
      throw new EngineFailure("other", this.safety.detail);
    this.interrupted.delete(conversationId);
    const state = { completed: false, interrupt: false, started: false };
    this.starting.set(conversationId, state);
    try {
      const turn = await this.startTurn(conversationId, {
        threadId: conversationId,
        input: [
          { type: "text", text, text_elements: [] },
          ...(context?.filesReverted ? [{ type: "text" as const, text: "Aviso de Bitácora (no escrito por la usuaria): se deshicieron los cambios de archivos del pedido anterior. Revisá el estado actual antes de continuar.", text_elements: [] }] : []),
          ...files.filter(f => !f.mime.startsWith("image/")).map(f => ({ type: "mention" as const, name: basename(f.path), path: relative(this.options.workspace, f.path) })),
          ...files.filter(f => f.mime.startsWith("image/")).map(f => ({ type: "localImage" as const, path: f.path })),
        ],
        cwd: this.options.workspace,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [this.options.workspace],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      }, state);
      if (!state.completed && this.available && (!turn || turn.status === "inProgress")) {
        if (turn) this.turns.set(conversationId, turn.id);
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
    if (!turnId && !this.running(conversationId)) return;
    // The deadline starts when the pause is requested, even while the turn is
    // still starting: a silent engine must not keep it waiting for the request
    // timeout.
    this.watchPause(conversationId);
    if (!turnId || this.interrupted.has(conversationId)) return;
    this.interrupted.add(conversationId);
    await this.rpc("turn/interrupt", { threadId: conversationId, turnId });
  }
  async retry() {
    if (this.available || !this.exhausted || this.stopping) return;
    this.attempts = 0;
    this.exhausted = false;
    this.emit({ type: "availability", available: false, exhausted: false, safety: this.safety });
    try { await this.start(); } catch (error) {
      if (!this.restartTimer) this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  async close() {
    this.stopping = true;
    clearTimeout(this.setupTimer);
    this.restartTimer?.();
    this.stableTimer?.();
    this.clearPause();
    const attempt = this.startAttempt;
    if (attempt) {
      // A restart may already own a child: stop it and wait for the attempt to
      // settle, so no new child can appear after close() returns.
      const child = this.child;
      if (child) await this.stopTree(child);
      await attempt.catch(() => {});
    }
    const child = this.child;
    if (!child) return;
    // Let the app-server close on its own, then stop the whole tree. Both waits
    // are bounded: a stuck kill must never hang the app.
    child.stdin.end();
    if (await this.waitExit(child, 2000)) return;
    await this.stopTree(child);
  }
}
