import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join, relative, basename } from "node:path";
import { codexBinary, codexVersion } from "../../../scripts/codex-runtime.mjs";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { registerKit } from './kit';
import { cleanTitle, TITLE_PROMPT } from "../titles";
import {
  AGENCY_ENVIRONMENT,
  isAllowedSkill,
  skillPathKey,
  type AgencyEnvironment,
} from "../agency-environment";
import { codexEnvironmentArgs } from "./environment";
import type { Engine, EngineEvent, Account, ExecutionSafety, Question } from "../engine";
import { EngineFailure } from "../engine";
import type { ClientRequest } from "./generated/ClientRequest";
import type { RequestId } from "./generated/RequestId";
import type { ServerNotification } from "./generated/ServerNotification";
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { ThreadSampleResponse } from "./generated/v2/ThreadSampleResponse";
import type { ThreadSetNameResponse } from "./generated/v2/ThreadSetNameResponse";
import type { Turn } from "./generated/v2/Turn";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse";
import type { ConfigReadResponse } from "./generated/v2/ConfigReadResponse";
import type { CommandExecResponse } from "./generated/v2/CommandExecResponse";
import type { PermissionProfileListResponse } from "./generated/v2/PermissionProfileListResponse";
import type { SkillsConfigWriteResponse } from "./generated/v2/SkillsConfigWriteResponse";
import type { SkillsListResponse } from "./generated/v2/SkillsListResponse";
import type { WindowsSandboxReadinessResponse } from "./generated/v2/WindowsSandboxReadinessResponse";
import type { ModelListResponse } from "./generated/v2/ModelListResponse";
import { TITLE_EFFORT, type EngineModel, type ModelSelection } from "../models";

/**
 * Named Codex permissions profile that keeps the agent's commands inside the
 * agency folder: `:workspace` grants read and write there, `:root` deny keeps
 * the rest of the disk out of reach and `:minimal` read leaves only the runtime
 * paths PowerShell needs. Verified on Windows 11 with MXC in issue #4.
 */
export const PERMISSIONS_PROFILE = "agencia";

/**
 * Command-line overrides that define the profile for the app-server process.
 * `-c` values are TOML, so the whole profile is one inline table; nothing is
 * written to the user's config file and an upgrade cannot leave a stale copy.
 * Exported so the real-sandbox test runs the very same profile.
 */
export const PROFILE_ARGS = [
  "-c",
  `default_permissions="${PERMISSIONS_PROFILE}"`,
  "-c",
  `permissions.${PERMISSIONS_PROFILE}={extends=":workspace",filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"},network={enabled=false}}`,
];

/** The Windows sandbox backend the app-server runs with. */
export type SandboxBackend = "mxc" | "elevated";

/**
 * Total time one skill sync may take, list and writes included: a machine with
 * many skills and a slow app-server cannot keep the app from opening or from
 * answering a request. The whole cycle shares this budget, so a request that
 * waits for it never waits for several passes of 20 s (DEC-011).
 */
const SKILL_SYNC_TIMEOUT_MS = 20_000;

/**
 * Wait before the single retry of a `skills/config/write`: a real request saw
 * one of 167 writes fail with `failed to persist config` while Windows had
 * `config.toml` busy, and the user does not need to read about that.
 */
const SKILL_WRITE_RETRY_MS = 150;

/**
 * Arguments for an app-server of a decided backend. A machine without MXC runs
 * the `elevated` backend, which refuses any profile that denies reading
 * `:root`, so that process is started without the profile: defining it as the
 * default would make every command fail. Before the check decides
 * (`undefined`) the profile is the safe default, because nothing runs until
 * the check passes.
 */
export function appServerArgs(
  backend: SandboxBackend | undefined,
  environment: AgencyEnvironment = AGENCY_ENVIRONMENT,
): string[] {
  const args = [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    'cli_auth_credentials_store="file"',
    ...codexEnvironmentArgs(environment),
  ];
  return backend === "elevated" ? args : [...args, ...PROFILE_ARGS];
}

type Responses = {
  initialize: unknown;
  "windowsSandbox/readiness": WindowsSandboxReadinessResponse;
  "permissionProfile/list": PermissionProfileListResponse;
  "command/exec": CommandExecResponse;
  "config/read": ConfigReadResponse;
  "config/value/write": unknown;
  "skills/list": SkillsListResponse;
  "skills/config/write": SkillsConfigWriteResponse;
  "windowsSandbox/setupStart": { started: boolean };
  "account/read": GetAccountResponse;
  "account/login/start": LoginAccountResponse;
  "account/login/cancel": unknown;
  "model/list": ModelListResponse;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "thread/sample": ThreadSampleResponse;
  "thread/name/set": ThreadSetNameResponse;
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

/**
 * Reads the `item/tool/requestUserInput` params (`ToolRequestUserInputParams`,
 * experimental in 0.168.0). Undefined when they cannot be shown to the user:
 * the request is then answered empty instead of left waiting.
 */
export function readQuestions(
  params: unknown,
): { conversationId: string; questions: Question[] } | undefined {
  const value = params as { threadId?: unknown; questions?: unknown } | null;
  if (!value || typeof value.threadId !== "string" || !Array.isArray(value.questions) || !value.questions.length)
    return undefined;
  const questions: Question[] = [];
  const ids = new Set<string>();
  for (const raw of value.questions as Record<string, unknown>[]) {
    if (!raw || typeof raw.id !== "string" || !raw.id || ids.has(raw.id) || typeof raw.question !== "string" || !raw.question.trim())
      return undefined;
    ids.add(raw.id);
    const rawOptions = raw.options ?? [];
    if (!Array.isArray(rawOptions)) return undefined;
    const options: Question["options"] = [];
    for (const option of rawOptions as Record<string, unknown>[]) {
      if (!option || typeof option.label !== "string" || !option.label.trim()) return undefined;
      // The answer is the label: a repeated one could not be told apart.
      if (options.some((existing) => existing.label === option.label)) continue;
      options.push({
        label: option.label,
        description: typeof option.description === "string" ? option.description : "",
      });
    }
    const other = raw.isOther === true;
    if (!options.length && !other) return undefined;
    questions.push({
      id: raw.id,
      header: typeof raw.header === "string" ? raw.header : "",
      text: raw.question,
      options,
      other,
      secret: raw.isSecret === true,
    });
  }
  return { conversationId: value.threadId, questions };
}

/** Schedules `run` and returns a cancel function. Defaults to `setTimeout`. */
export type ScheduleTimer = (run: () => void, delayMs: number) => () => void;

/** Runs `taskkill /T /F` on a live process tree. */
export type KillProcessTree = (pid: number) => Promise<boolean>;

/** Result of stopping a process tree. */
export type TreeStop = {
  /** False when only the app-server could be stopped. */
  complete: boolean;
  /** False when the app-server was still alive when the wait ran out. */
  exited: boolean;
};

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
  /**
   * Sandbox backend the startup check decided. It is set once per check and
   * every thread and turn is started for it: the two modes are never mixed
   * inside one process. `undefined` while the check has not decided.
   */
  private backend?: SandboxBackend;
  /** True when the running app-server was started with the permissions profile. */
  private spawnedWithProfile = false;
  private available = false;
  private restartTimer?: () => void;
  private attempts = 0;
  private stableTimer?: () => void;
  private exhausted = false;
  private interrupted = new Set<string>();
  private starting = new Map<
    string,
    {
      completed: boolean;
      interrupt: boolean;
      started: boolean;
      /** True while the skill check before the turn is still running. */
      preparing?: boolean;
    }
  >();
  // Conversation whose turn made the engine stop answering: its problem event
  // tells the user the engine was restarted instead of the generic failure.
  private failing?: string;
  private pauseTimers = new Map<string, NodeJS.Timeout>();
  // Children that already exited, and the tree stops already in flight: a child
  // is never killed twice and never killed once it is gone.
  private exitedChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private treeStops = new WeakMap<ChildProcessWithoutNullStreams, Promise<TreeStop>>();
  executionSafety() {
    return this.safety;
  }
  private child?: ChildProcessWithoutNullStreams;
  // The last process this engine spawned. `child` is cleared as soon as a
  // process fails, so close() needs this to make sure nothing is left running.
  private lastChild?: ChildProcessWithoutNullStreams;
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
  /**
   * Questions waiting for the user, by the id the app sees. The request id is
   * only valid for the process that asked: a restarted app-server numbers its
   * requests again, so an old answer must never reach the new one.
   */
  private questions = new Map<
    string,
    { conversationId: string; requestId: RequestId; child: ChildProcessWithoutNullStreams }
  >();
  private turns = new Map<string, string>();
  /** Last finished turn of each conversation: the only source `thread/sample` accepts. */
  private lastTurn = new Map<string, string>();
  private loginId?: string;
  private stopping = false;
  private startAttempt?: Promise<void>;
  private skillsSync?: { promise: Promise<void> };
  private skillsDirty = false;
  private reportedSkillErrors = new Set<string>();
  private stderr = "";
  constructor(
    private options: {
      mcpEntry?: string;
      home: string;
      workspace: string;
      binary?: string;
      /**
       * Arguments for the app-server. A function receives the backend the
       * check decided, so a test app-server can be started with the arguments
       * the real one would get; a fixed list is used as is.
       */
      args?: string[] | ((backend: SandboxBackend | undefined) => string[]);
      restartDelayMs?: number;
      stableAfterMs?: number;
      scheduleTimer?: ScheduleTimer;
      probeProtection?: () => Promise<boolean>;
      requestTimeoutMs?: number;
      /** Deadline for the `turn/start` reply. Defaults to `requestTimeoutMs`. */
      turnStartTimeoutMs?: number;
      pauseTimeoutMs?: number;
      killTimeoutMs?: number;
      /** Total limit of one skill check, its lists and writes included. */
      skillsSyncTimeoutMs?: number;
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
    const attempt = this.startInDecidedMode();
    this.startAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.startAttempt === attempt) this.startAttempt = undefined;
    }
  }
  /**
   * The backend is only known after the app-server answers the startup check,
   * so the first process may have been started for the other one. It is
   * stopped and started once more with the arguments the decision asks for: a
   * process never keeps running with a mode the check did not choose.
   */
  private async startInDecidedMode() {
    if (await this.runStart()) return;
    // The check must not change its mind twice in a row: if it does, the
    // engine refuses to start instead of running a mode it did not choose.
    if (await this.runStart()) return;
    throw new Error("The sandbox backend changed while the engine was starting");
  }
  private async runStart() {
    if (this.stopping) return true;
    // A process that could not be stopped may still be writing in the same
    // folder: starting another one would let two engines work at once.
    if (this.lastChild && this.childRunning(this.lastChild))
      throw new Error("The previous engine process is still running");
    await mkdir(this.options.home, { recursive: true });
    await mkdir(this.options.workspace, { recursive: true });
    if (!this.options.args) {
      await registerKit(this.options.home, this.options.workspace, this.options.mcpEntry);
    }
    if (this.stopping) return true;
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
      : (await promisify(execFile)(binary, ["--version"], {
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        })).stdout.trim();
    if (this.stopping) return true;
    if (version !== codexVersion)
      throw new Error(`Expected ${codexVersion}, received ${version}`);
    const args =
      typeof this.options.args === "function"
        ? this.options.args(this.backend)
        : this.options.args;
    const spawnArgs = args ?? appServerArgs(this.backend);
    // The mode is read back from the arguments the process really got: a
    // process started for the other backend is never mistaken for a match.
    this.spawnedWithProfile = spawnArgs.some((arg) =>
      arg.startsWith("default_permissions="),
    );
    this.child = spawn(binary, spawnArgs, {
      cwd: this.options.workspace,
      env,
      windowsHide: true,
      stdio: "pipe",
    });
    const child = this.child;
    this.lastChild = child;
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
      const stopped = () => failedChild(new Error(`Codex process stopped. ${this.stderr}`));
      // A stop in flight owns the release: the app must not scan while the tree
      // is still being killed.
      const stop = this.treeStops.get(child);
      if (stop) void stop.then(stopped, stopped);
      else stopped();
    });
    try {
      await this.rpc("initialize", {
        clientInfo: { name: "bitacora", title: "Bitácora", version: "0.1.0" },
        // The read-restricting profile is an experimental field: without this
        // capability the app-server refuses `permissions` on thread and turn.
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.write({ method: "initialized" });
      this.environment = env;
      await this.checkProtection();
      if (this.child !== child)
        throw new Error("Engine stopped during initialization");
      if (!this.modeMatches()) {
        // The check decided the other backend: this process was started for a
        // mode it cannot use. Stop it and let start() spawn the right one.
        this.child = undefined;
        this.cancelPending(new Error("Engine restarting in the decided sandbox mode"));
        await this.stopTree(child);
        return false;
      }
      // The protection state and the availability are published in the same
      // step, and nothing is awaited between them: `start()` returns at once and
      // no later wait can leave the app refusing work with a ready engine. The
      // skill check runs in the background; `createWork`, `resumeWork` and
      // `send` wait for it before a turn, and it never rejects.
      this.available = true;
      this.exhausted = false;
      this.stableTimer?.();
      this.stableTimer = this.scheduleTimer(() => { this.attempts = 0; }, this.options.stableAfterMs ?? 60_000);
      this.reportedSkillErrors.clear();
      this.skillsDirty = false;
      this.skillsSync = undefined;
      this.emit({ type: "availability", available: true, safety: this.safety });
      void this.syncSkills();
      const account = await this.account();
      if (this.child !== child)
        throw new Error("Engine stopped during account read");
      this.emit({ type: "account", account });
      if (this.safety.status === "needed" && !this.safety.needsPermission) void this.prepareProtection();
      return true;
    } catch (error) {
      failedChild(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  /**
   * True when the running app-server was started for the backend the check
   * decided. Before anything is decided (`undefined`) it is true: that process
   * carries the profile, the safe default, and no work is allowed until the
   * check decides.
   */
  private modeMatches() {
    if (!this.backend) return true;
    return this.spawnedWithProfile === (this.backend === "mxc");
  }
  private setupMode?: "mxc" | "elevated";
  private environment: NodeJS.ProcessEnv = {};
  private mxcAvailable?: boolean;
  private setupTimer?: NodeJS.Timeout;
  private setupPending = false;
  private setupInterrupted = false;
  private checking?: Promise<void>;
  private setProtection(safety: ExecutionSafety) {
    // Work is only allowed for a process started in the decided mode. A check
    // that allows work while the running process was started for the other
    // backend would mix the two, so the decision is published as blocked and
    // the process is replaced; the next check allows work on the new one.
    if (safety.allowed && !this.modeMatches()) {
      this.safety = { ...safety, allowed: false };
      this.emit({ type: "protection", safety: this.safety });
      this.replaceProcess();
      return;
    }
    this.safety = safety;
    this.emit({ type: "protection", safety });
  }
  /**
   * Replaces the app-server when the check decided a backend the running
   * process was not started for. During startup `runStart` owns that restart
   * (it returns false and `startInDecidedMode` spawns again); here it is a
   * process that is already serving, so the replacement is a reload.
   */
  private replaceProcess() {
    if (!this.available || this.stopping) return;
    void this.reloadProtection().catch(() => { /* fail() owns restart errors */ });
  }
  /**
   * Whether the native sandbox can run here, asked every time the check reads
   * the state. A saved `elevated` mode is only the fallback for a computer
   * without MXC: a Windows update can bring it, and an old setting must not
   * keep the agent reading the whole disk.
   *
   * When the saved mode already works, an inconclusive probe (a timeout, an
   * unexpected answer) is not allowed to take away the protection this
   * computer has: the app keeps the mode it knows works and warns.
   */
  private async probeMxcFor(mode: string | undefined, readiness: string) {
    try {
      return await this.probeMxc();
    } catch (error) {
      if (mode !== "elevated" || readiness !== "ready") throw error;
      return false;
    }
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
      const detail = `windowsSandbox/readiness=${readiness.status}; windows.sandbox=${mode || "disabled"}; permissions=${PERMISSIONS_PROFILE}`;
      const mxc = await this.probeMxcFor(mode, readiness.status);
      if (readiness.status === "ready" && mode === "mxc" && mxc) {
        this.backend = "mxc";
        const refusal = await this.checkPermissions();
        if (refusal) {
          // The folder is protected for writes but the agent could still read
          // every file on the computer: say so instead of working anyway. On a
          // machine with MXC there is no fallback to the weaker mode.
          this.setProtection({ allowed: false, status: "failed", detail: `${detail}; ${refusal}`, issue: "readBlock" });
          return;
        }
        this.setProtection({ allowed: true, status: "ready", readBlock: true, detail });
        return;
      }
      if (readiness.status === "ready" && mode === "elevated" && !mxc) {
        // A machine without MXC: the elevated backend refuses any profile that
        // denies reading `:root`, so the read block cannot be applied. The app
        // works with the write protection it always had and says what is
        // missing, instead of refusing all work.
        this.backend = "elevated";
        this.setProtection({
          allowed: true,
          status: "ready",
          readBlock: false,
          detail: `windowsSandbox/readiness=${readiness.status}; windows.sandbox=elevated; readBlock=off`,
        });
        return;
      }
      this.backend = mxc ? "mxc" : "elevated";
      this.setupMode = this.backend;
      this.setProtection({ allowed: false, status: interrupted ? "failed" : "needed",
        needsPermission: !mxc, detail, issue: interrupted ? "interrupted" : undefined });
    } catch (error) {
      this.setProtection({ allowed: false, status: "failed", detail: String(error), issue: "check" });
    }
  }
  /**
   * Asks the running app-server whether the read-restricting profile can really
   * be used. Returns why it cannot, or undefined when it can.
   *
   * The profile list alone is not enough: it says the profile exists, not that
   * this machine can run it. The elevated Windows backend refuses a profile
   * that denies `:root` read, and a machine without the native sandbox cannot
   * run it at all. One harmless command under the profile answers both, and an
   * app-server that does not know the call is a refusal too: the app never
   * falls back to a profile that reads the whole computer.
   */
  private async checkPermissions(): Promise<string | undefined> {
    try {
      const { data } = await this.rpc("permissionProfile/list", { cwd: this.options.workspace });
      const profile = data.find((p) => p.id === PERMISSIONS_PROFILE);
      if (!profile) return `permissionProfile/list does not offer ${PERMISSIONS_PROFILE}`;
      if (!profile.allowed) return `permissionProfile/list does not allow ${PERMISSIONS_PROFILE}`;
    } catch (error) {
      return `permissionProfile/list failed: ${String(error)}`;
    }
    try {
      const { exitCode, stdout, stderr } = await this.rpc("command/exec", {
        command: [join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), "/d", "/c", "echo BITACORA_PROFILE_OK"],
        cwd: this.options.workspace,
        permissionProfile: PERMISSIONS_PROFILE,
        timeoutMs: 15000,
      });
      if (exitCode === 0 && stdout.includes("BITACORA_PROFILE_OK")) return undefined;
      return `command/exec under ${PERMISSIONS_PROFILE} exited ${exitCode}: ${stderr.slice(0, 400)}`;
    } catch (error) {
      return `command/exec under ${PERMISSIONS_PROFILE} failed: ${String(error)}`;
    }
  }
  async prepareProtection() {
    if (!this.available) return;
    // The check decided the other backend than the one this process was
    // started for (for example, the Windows setup finished after the app gave
    // up waiting): restart it in the decided mode instead of working with a
    // mixed engine.
    if (!this.modeMatches()) {
      await this.reloadProtection();
      return;
    }
    if (this.safety.allowed || this.safety.status === "preparing" || this.setupPending) return;
    // An unknown/ambiguous result is retried by reading state, never by
    // repeating an administrative setup whose outcome is not yet known.
    if (!this.setupMode) {
      await this.checkProtection();
      // The check may have decided the other backend (the first check failed
      // and this retry succeeded): the process is replaced in the decided mode
      // before any work is allowed.
      if (!this.modeMatches()) {
        await this.reloadProtection();
        return;
      }
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
   *  `complete` is false when only the app-server could be stopped; `exited` is
   *  false when the app-server was still alive when the wait ran out. */
  private stopTree(child: ChildProcessWithoutNullStreams): Promise<TreeStop> {
    if (!this.childRunning(child)) return Promise.resolve({ complete: true, exited: true });
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
  private async runStopTree(child: ChildProcessWithoutNullStreams): Promise<TreeStop> {
    // Listen before killing, so an exit that happens during the kill is seen.
    const exited = this.waitExit(child, this.options.killTimeoutMs ?? 5000);
    const complete = await this.killChildTree(child);
    return { complete, exited: await exited };
  }
  /** The stop already running for the current child, if any. */
  private currentStop() {
    const child = this.child;
    return child ? this.treeStops.get(child) : undefined;
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
    const { complete, exited } = await this.stopTree(child);
    // A parent-only termination leaves commands running: the app must not scan
    // as if every writer had stopped.
    if (!complete)
      this.emit({
        type: "detail",
        conversationId,
        text: "No pude detener todos los procesos de Bitácora: puede quedar algo escribiendo archivos.",
      });
    if (!exited) {
      // The app-server is still alive and may still be writing. It must not
      // take new work: fail() releases the app, and start() refuses to spawn
      // another process while this one is running.
      this.child = undefined;
      this.fail(new Error("The engine process did not stop"));
    }
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
   *  so a silent engine cannot keep it waiting for the request timeout. While
   *  the turn is still being prepared there is nothing to interrupt yet: the
   *  deadline starts when the turn is really requested. */
  private watchPause(conversationId: string) {
    if (this.pauseTimers.has(conversationId)) return;
    // A pause asked for while the turn is still being prepared is delivered
    // when the turn is requested, and its deadline starts then: the skill check
    // before the turn is not a turn that does not end.
    if (this.starting.get(conversationId)?.preparing) return;
    const timer = setTimeout(() => {
      this.pauseTimers.delete(conversationId);
      if (!this.running(conversationId)) return;
      void this.stopUnresponsive(conversationId);
    }, this.options.pauseTimeoutMs ?? 15000);
    timer.unref();
    this.pauseTimers.set(conversationId, timer);
  }
  private reloading?: Promise<void>;
  /**
   * Stops the app-server and starts a new one for the decided mode. Two checks
   * can decide the same replacement at once: only one process is replaced, and
   * every caller waits for the same one.
   */
  private reloadProtection() {
    if (this.reloading) return this.reloading;
    // The reload starts in a microtask, so the promise is stored before a
    // listener of the events it emits can ask for another one.
    const reload = Promise.resolve()
      .then(() => this.runReload())
      .finally(() => {
        if (this.reloading === reload) this.reloading = undefined;
      });
    this.reloading = reload;
    return reload;
  }
  private async runReload() {
    const child = this.child;
    this.child = undefined;
    this.available = false;
    this.setupPending = false;
    // The login belongs to the process that is about to be replaced.
    this.loginId = undefined;
    this.safety = { ...this.safety, allowed: false };
    this.cancelPending(new Error("Engine reloading protection"));
    this.closeQuestions("stopped");
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
    timeoutMs?: number,
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
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 45000);
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
    // The process that asked is gone: its questions cannot be answered.
    this.closeQuestions("stopped");
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
      // A question with options waits for the user's answer on the screen.
      if (message.method === "item/tool/requestUserInput" && this.ask(message.id, message.params)) return;
      // Never approve an escalation; any other interactive request is declined.
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
  /** Shows a question to the user. False when it cannot be shown. */
  private ask(requestId: RequestId, params: unknown) {
    const asked = readQuestions(params);
    if (!asked || !this.child) return false;
    const id = randomUUID();
    this.questions.set(id, { conversationId: asked.conversationId, requestId, child: this.child });
    this.emit({ type: "question", id, ...asked });
    return true;
  }
  /**
   * Stops waiting for the questions that match, and says why: one event per
   * conversation, so the app closes them together instead of showing the next
   * one in line just before it is closed too.
   */
  private closeQuestions(
    reason: Extract<EngineEvent, { type: "questionClosed" }>["reason"],
    match: (question: { conversationId: string; requestId: RequestId }) => boolean = () => true,
  ) {
    const closed = new Map<string, string[]>();
    for (const [id, question] of this.questions) {
      if (!match(question)) continue;
      this.questions.delete(id);
      closed.set(question.conversationId, [...(closed.get(question.conversationId) ?? []), id]);
    }
    if (this.stopping) return;
    for (const [conversationId, ids] of closed) this.emit({ type: "questionClosed", conversationId, ids, reason });
  }
  async answer(conversationId: string, questionId: string, answers: Record<string, string[]>) {
    const question = this.questions.get(questionId);
    if (!question || question.conversationId !== conversationId || question.child !== this.child)
      throw new EngineFailure("other", "The question is no longer waiting for an answer");
    this.questions.delete(questionId);
    const result: ToolRequestUserInputResponse = {
      answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])),
    };
    this.write({ id: question.requestId, result });
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
      case "skills/changed":
        // A change asks for another pass. A request that joins the running
        // cycle also marks it dirty, so the list it gets is taken after its
        // request; the cycle shares one deadline, so that never adds unbounded
        // waiting.
        if (!this.available) break;
        if (this.skillsSync) this.skillsDirty = true;
        else void this.syncSkills().catch(() => {});
        break;
      case "serverRequest/resolved": {
        // The app-server stopped waiting (a pause or another turn change) for a
        // question the user had not answered yet.
        const { threadId, requestId } = n.params;
        this.closeQuestions(
          this.interrupted.has(threadId) ? "paused" : "finished",
          (question) => question.conversationId === threadId && question.requestId === requestId,
        );
        break;
      }
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
        this.lastTurn.delete(n.params.threadId);
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
        } else if (
          item.type !== "userMessage" &&
          // The user's answers, secret ones included, never go to the detail.
          !(item.type === "functionCallOutput" && item.name === "request_user_input")
        ) {
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
        // A question of a turn that ended can no longer be answered.
        this.closeQuestions(
          turn.status === "interrupted" || this.interrupted.has(conversationId) ? "paused" : "finished",
          (question) => question.conversationId === conversationId,
        );
        this.turns.delete(conversationId);
        this.lastTurn.set(conversationId, turn.id);
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
  /**
   * The catalogue `model/list` returns for the account, without the models it
   * hides from pickers. It reads the catalogue only: no thread, no quota.
   */
  async models(): Promise<EngineModel[]> {
    if (!this.available) throw new Error("The engine is not available");
    const models: EngineModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const list: ModelListResponse = await this.rpc("model/list", { cursor, includeHidden: false });
      for (const model of list.data)
        if (!model.hidden)
          models.push({
            id: model.id,
            displayName: model.displayName,
            efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
            defaultEffort: model.defaultReasoningEffort,
            isDefault: model.isDefault,
          });
      cursor = list.nextCursor;
      if (!cursor) break;
    }
    return models;
  }
  private settings(model?: ModelSelection) {
    return {
      cwd: this.options.workspace,
      approvalPolicy: "never" as const,
      // A named profile cannot be combined with `sandbox`: the profile decides
      // both the writable root and what stays readable. Without MXC there is no
      // profile to run, so the thread keeps the plain write protection.
      ...(this.backend === "elevated"
        ? { sandbox: "workspace-write" as const }
        : { permissions: PERMISSIONS_PROFILE }),
      developerInstructions: AGENCY_ENVIRONMENT.developerInstructions,
      // `thread/start` and `thread/resume` have no effort field: it travels as
      // the config override, verified against 0.168.0 (DEC-014).
      ...(model && { model: model.model, config: { model_reasoning_effort: model.effort } }),
    };
  }
  /**
   * A thread that did not take the profile would run with the default one, so
   * it is refused instead of used. `thread/start` always reports the profile it
   * took; `thread/resume` reports it "when known", so a missing value there is
   * not a refusal: the turn still sends the profile and the configured default
   * is the same one. The app turns off execution and says why.
   *
   * Without MXC there is no profile to check: the thread runs with the plain
   * write protection, which is all that machine can do.
   */
  private checkProfile(active: { id: string } | null | undefined, required: boolean) {
    if (this.backend === "elevated") return;
    if (active?.id === PERMISSIONS_PROFILE) return;
    if (!required && !active) return;
    const refusal = `the engine started the work with permissions=${active?.id ?? "none"} instead of ${PERMISSIONS_PROFILE}`;
    this.setProtection({ allowed: false, status: "failed", detail: refusal, issue: "readBlock" });
    throw new EngineFailure("other", refusal);
  }
  private reportSkillError(key: string, text: string, conversationId?: string) {
    if (this.reportedSkillErrors.has(key)) return;
    this.reportedSkillErrors.add(key);
    this.emit({ type: "detail", conversationId, text, key });
  }
  /**
   * Forgets notices the app never delivered: a notice that was dropped is not
   * a notice that was said, so the next check has to say it again.
   */
  forgetDetails(keys: readonly string[]) {
    for (const key of keys) this.reportedSkillErrors.delete(key);
  }
  /**
   * Lists the skills Codex can see and leaves only the ones the kit provides:
   * every other enabled skill is turned off and every kit skill that is off is
   * turned on. The batch of writes is verified with a new list:
   * `effectiveEnabled` of 0.168.0 repeats what the request asked for, so only
   * the list says which ones are really in the state the kit wants.
   *
   * Every call is bounded by `deadline`, so a slow engine can never keep the
   * app from opening or from sending a request.
   */
  private async runSkillSync(
    child: ChildProcessWithoutNullStreams,
    conversationId?: string,
    deadline?: number,
  ): Promise<{ timedOut: boolean; verified: boolean }> {
    if (this.child !== child || this.stopping)
      return { timedOut: false, verified: true };
    // `verified` starts false and is raised only by a list asked after the
    // writes, or by a pass with nothing to change: a pass that runs out of time
    // before confirming cannot claim the skills are the way the kit wants.
    const result = { timedOut: false, verified: false };
    const outOfTime = () => deadline !== undefined && Date.now() >= deadline;
    const timeLimit = () =>
      deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    const stopForTime = () => {
      if (!outOfTime()) return false;
      result.timedOut = true;
      this.reportSkillError(
        "timeout",
        "No terminé de revisar los complementos a tiempo.",
        conversationId,
      );
      return true;
    };
    let list: SkillsListResponse;
    try {
      list = await this.rpc(
        "skills/list",
        { cwds: [this.options.workspace], forceReload: true },
        timeLimit(),
      );
    } catch (error) {
      if (this.child !== child || this.stopping || stopForTime()) return result;
      this.reportSkillError(
        "list",
        `No pude revisar los complementos del kit: ${String(error)}`,
        conversationId,
      );
      return result;
    }
    // The list also carries the skills it could not read: they stay invisible to
    // the agent, but a broken file is worth saying once instead of silently.
    for (const entry of Array.isArray(list?.data) ? list.data : [])
      for (const problem of entry?.errors ?? [])
        this.reportSkillError(
          `error:${problem.path}`,
          `No pude leer un complemento (${problem.path}): ${problem.message}`,
          conversationId,
        );
    if (!Array.isArray(list?.data)) {
      this.reportSkillError(
        "list",
        "No pude revisar los complementos del kit: la lista llegó incompleta.",
        conversationId,
      );
      return result;
    }
    // An entry without a list of skills is an incomplete answer too: what it
    // omits could be a skill that stays on, so it is said instead of guessed.
    const entries = list.data.filter((entry) => Array.isArray(entry?.skills));
    if (entries.length === list.data.length) this.reportedSkillErrors.delete("list");
    else
      this.reportSkillError(
        "list",
        "No pude revisar los complementos del kit: la lista llegó incompleta.",
        conversationId,
      );
    // One at a time lets the loop stop and say so when the time runs out. The
    // app-server serializes these writes itself, so the order is not about
    // avoiding a race on `config.toml`.
    //
    // Every target and every comparison uses the normalized path: Windows
    // reports the same file with another separator or case, and that is not a
    // different skill.
    const disable = new Map<string, { path: string; failure?: string }>();
    const enable = new Map<string, { path: string; failure?: string }>();
    for (const entry of entries)
      for (const skill of entry.skills) {
        if (!skill?.path) continue;
        const key = skillPathKey(skill.path);
        if (this.allowsSkill(skill)) {
          if (!skill.enabled) enable.set(key, { path: skill.path });
        } else if (skill.enabled) {
          disable.set(key, { path: skill.path });
        }
      }
    // Nothing to change proves the state only when the list was complete: an
    // entry the app-server could not read could be a skill that stays on, and
    // that is not something this pass can call verified.
    if (!disable.size && !enable.size) {
      result.verified = entries.length === list.data.length;
      return result;
    }
    for (const target of disable.values()) {
      if (this.child !== child || this.stopping || stopForTime()) return result;
      target.failure = await this.writeSkill(child, target.path, false, timeLimit, deadline);
      if (this.child !== child || this.stopping) return result;
    }
    for (const target of enable.values()) {
      if (this.child !== child || this.stopping || stopForTime()) return result;
      target.failure = await this.writeSkill(child, target.path, true, timeLimit, deadline);
      if (this.child !== child || this.stopping) return result;
    }
    // Ask again: an accepted write is not a skill that is off (or on). When this
    // list fails, runs out of time or comes back incomplete, nothing proves the
    // batch worked, so the app says it could not check.
    const written = [...disable.values(), ...enable.values()].map((target) => target.path);
    let after: SkillsListResponse | undefined;
    try {
      after = await this.rpc(
        "skills/list",
        { cwds: [this.options.workspace], forceReload: true },
        timeLimit(),
      );
    } catch {
      after = undefined;
    }
    if (this.child !== child || this.stopping) return result;
    const complete =
      Array.isArray(after?.data) && after.data.every((entry) => Array.isArray(entry?.skills));
    if (!complete) {
      stopForTime();
      this.reportSkillError(
        "verify",
        `No pude comprobar si los complementos quedaron como tienen que estar: ${written.join(", ")}.`,
        conversationId,
      );
      return result;
    }
    const afterSkills = new Map<
      string,
      { path: string; enabled: boolean; allowed: boolean }
    >();
    for (const entry of after!.data)
      for (const skill of entry.skills ?? []) {
        if (!skill?.path) continue;
        afterSkills.set(skillPathKey(skill.path), {
          path: skill.path,
          enabled: skill.enabled,
          allowed: this.allowsSkill(skill),
        });
      }
    // A complete list that shows every foreign skill off and every kit skill
    // that is listed on is the only thing that counts as verified. A foreign
    // skill that appeared after the first list (it is on and was not a target)
    // stays named even though nothing tried to turn it off.
    const stillOn = [...afterSkills.entries()].filter(([, skill]) => skill.enabled && !skill.allowed);
    const stillOff = [...afterSkills.entries()].filter(([, skill]) => !skill.enabled && skill.allowed);
    const unknownOn = stillOn.filter(([key]) => !disable.has(key));
    const verified = !stillOn.length && !stillOff.length;
    if (verified) this.reportedSkillErrors.delete("verify");
    else
      this.reportSkillError(
        "verify",
        `No pude comprobar si los complementos quedaron como tienen que estar: ${[...stillOn, ...stillOff].map(([, skill]) => skill.path).join(", ")}.`,
        conversationId,
      );
    for (const [key, target] of disable) {
      const reportKey = `skill:${key}`;
      if (!afterSkills.get(key)?.enabled) {
        this.reportedSkillErrors.delete(reportKey);
        continue;
      }
      const detail = target.failure ? ` ${target.failure}` : "";
      this.reportSkillError(
        reportKey,
        `No pude desactivar un complemento que no es del kit: ${target.path}.${detail}`,
        conversationId,
      );
    }
    for (const [key, target] of enable) {
      const reportKey = `skill:${key}`;
      const current = afterSkills.get(key);
      if (!current || current.enabled) {
        this.reportedSkillErrors.delete(reportKey);
        continue;
      }
      const detail = target.failure ? ` ${target.failure}` : "";
      this.reportSkillError(
        reportKey,
        `No pude activar un complemento del kit: ${target.path}.${detail}`,
        conversationId,
      );
    }
    for (const [key, skill] of unknownOn) {
      this.reportSkillError(
        `skill:${key}`,
        `No pude desactivar un complemento que no es del kit: ${skill.path}.`,
        conversationId,
      );
    }
    for (const [key, skill] of stillOff) {
      if (enable.has(key)) continue;
      this.reportSkillError(
        `skill:${key}`,
        `No pude activar un complemento del kit: ${skill.path}.`,
        conversationId,
      );
    }
    result.verified = verified;
    return result;
  }
  /** Whether the kit provides this exact skill, at the path Bitácora copied it to. */
  private allowsSkill(skill: { name: string; scope: string; path?: string | null }) {
    return isAllowedSkill(skill, this.options.workspace);
  }
  /**
   * One skill switch, with a single retry. A write that fails twice is returned
   * so the caller names it in the work detail instead of the user seeing a
   * transient Windows lock as a problem. Neither the wait nor the retry goes
   * past the cycle's deadline: a request never waits longer than the shared
   * limit.
   */
  private async writeSkill(
    child: ChildProcessWithoutNullStreams,
    path: string,
    enabled: boolean,
    timeLimit: () => number | undefined,
    deadline?: number,
  ): Promise<string | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.rpc("skills/config/write", { path, enabled }, timeLimit());
        return undefined;
      } catch (error) {
        if (this.child !== child || this.stopping) return undefined;
        if (attempt >= 1) return String(error);
        const remaining = deadline === undefined ? SKILL_WRITE_RETRY_MS : deadline - Date.now();
        if (remaining <= 0) return String(error);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(SKILL_WRITE_RETRY_MS, remaining)),
        );
        // The wait may have used the rest of the cycle: a retry now would only
        // add a request the deadline cannot wait for.
        if (deadline !== undefined && Date.now() >= deadline) return String(error);
      }
    }
  }
  /**
   * Runs the skill sync, coalescing concurrent requests and never rejecting:
   * the app keeps working and the failure is reported as a work detail. The
   * whole cycle shares one deadline, so a request waits at most `timeoutMs` no
   * matter how many changes arrive while it runs.
   *
   * A turn the engine starts on its own (a goal, once goals are back on) never
   * passes through here: that is why the skill catalogue stays off for the
   * whole process (DEC-011) instead of relying on this check before each turn.
   */
  private syncSkills(
    conversationId?: string,
    timeoutMs = this.options.skillsSyncTimeoutMs ?? SKILL_SYNC_TIMEOUT_MS,
  ): Promise<void> {
    const child = this.child;
    if (!child || this.stopping) return Promise.resolve();
    const running = this.skillsSync;
    // A request that arrives while a cycle runs asks for one more pass, so the
    // list it gets is taken after its request. The cycle shares a single
    // deadline, so that extra pass can never keep anyone waiting past it.
    if (running) {
      this.skillsDirty = true;
      return running.promise;
    }
    const deadline = Date.now() + timeoutMs;
    const slot: { promise: Promise<void> } = { promise: Promise.resolve() };
    slot.promise = (async () => {
      let clean = false;
      try {
        do {
          this.skillsDirty = false;
          const pass = await this.runSkillSync(child, conversationId, deadline);
          clean = !pass.timedOut;
          if (pass.verified) this.reportedSkillErrors.delete("verify");
        } while (
          this.skillsDirty &&
          this.child === child &&
          !this.stopping &&
          Date.now() < deadline
        );
        // A change that arrived during the last pass never got its own pass:
        // the cycle was cut at its deadline, so say the check did not finish.
        if (this.skillsDirty && this.child === child && !this.stopping) {
          this.reportSkillError(
            "timeout",
            "No terminé de revisar los complementos a tiempo.",
            conversationId,
          );
        }
        // A check that ended in time and left nothing pending is the only one
        // that proves the next failure is new, so the notices it would repeat
        // are allowed again. A cycle cut with a change pending keeps the cap
        // notice: that pass never ran.
        if (clean && !this.skillsDirty && this.child === child && !this.stopping) {
          this.reportedSkillErrors.delete("timeout");
          this.reportedSkillErrors.delete("sync");
        }
      } catch (error) {
        if (this.child !== child || this.stopping) return;
        this.reportSkillError(
          "sync",
          `No pude revisar los complementos del kit: ${String(error)}`,
          conversationId,
        );
      } finally {
        // Released in the same step the loop ends: a caller that arrives right
        // after starts a fresh list instead of waiting for a promise that
        // already resolved without seeing the skills that just appeared.
        if (this.skillsSync === slot) this.skillsSync = undefined;
      }
    })();
    this.skillsSync = slot;
    return slot.promise;
  }
  async createWork(model?: ModelSelection) {
    await this.syncSkills();
    const { thread, activePermissionProfile } = await this.rpc("thread/start", this.settings(model));
    this.checkProfile(activePermissionProfile, true);
    return { conversationId: thread.id, title: thread.name || undefined };
  }
  async resumeWork(conversationId: string, model?: ModelSelection) {
    await this.syncSkills(conversationId);
    const { activePermissionProfile } = await this.rpc("thread/resume", {
      threadId: conversationId,
      ...this.settings(model),
    });
    this.checkProfile(activePermissionProfile, false);
  }
  /**
   * Asks the engine for a short name without starting a visible turn:
   * `thread/sample` runs one model request on an ephemeral fork of the last
   * finished turn, so it sees the conversation and costs one extra call. The
   * answer is only the text: a tool call makes the sample empty and the work
   * keeps its fallback name.
   *
   * It rejects when the sample could not run at all, so the caller keeps the
   * work pending instead of treating it as answered.
   */
  async suggestTitle(conversationId: string) {
    const expectedTurnId = this.lastTurn.get(conversationId);
    if (!this.available) throw new Error("The engine is not available");
    if (!expectedTurnId) throw new Error("No finished turn to sample");
    for (let attempt = 0; ; attempt++) {
      try {
        const sample = await this.rpc("thread/sample", {
          threadId: conversationId,
          expectedTurnId,
          prompt: TITLE_PROMPT,
          disableMcp: true,
          effort: TITLE_EFFORT,
        });
        const title = cleanTitle(sample.text);
        if (!title) return undefined;
        const count = (value: bigint | null) => (value === null ? 0 : Number(value));
        return {
          title,
          usage: {
            input: count(sample.inputTokens),
            cached: count(sample.cachedInputTokens),
            output: count(sample.outputTokens),
          },
        };
      } catch (error) {
        // The finished turn may still be closing when the app asks: one retry.
        if (attempt === 0 && /must be idle/.test(String(error))) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        throw error;
      }
    }
  }
  async renameWork(conversationId: string, title: string) {
    await this.rpc("thread/name/set", { threadId: conversationId, name: title });
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
      }, this.options.turnStartTimeoutMs ?? this.options.requestTimeoutMs ?? 45000);
      this.pending.set(id, {
        resolve: (value) => resolve((value as TurnStartResponse).turn),
        // A stop caused by this same conversation must reach the app as the
        // restart warning, not as a generic failure, and only after the tree is
        // really stopped: the app scans as soon as this rejects.
        reject: (error) => {
          const failure =
            this.failing === conversationId
              ? new EngineFailure(
                  "unresponsive",
                  `The engine stopped answering turn/start and was restarted. ${error.message}`,
                )
              : error;
          const stop = this.currentStop();
          if (stop) void stop.then(() => reject(failure), () => reject(failure));
          else reject(failure);
        },
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
  async send(conversationId: string, text: string, files: import("../engine").EngineFile[] = [], context?: { filesReverted?: boolean; model?: ModelSelection }) {
    if (!this.available || !this.safety.allowed)
      throw new EngineFailure("other", this.safety.detail);
    this.interrupted.delete(conversationId);
    // The turn is registered before the skill check, so a pause asked for while
    // that check runs reaches this turn instead of being lost.
    const state = { completed: false, interrupt: false, started: false, preparing: true };
    this.starting.set(conversationId, state);
    try {
      // A skill that appeared after the last turn is turned off before this one
      // starts: the turn never sees one the kit does not provide.
      await this.syncSkills(conversationId);
      state.preparing = false;
      if (!this.available || !this.safety.allowed)
        throw new EngineFailure("other", this.safety.detail);
      // The pause may have been asked while the request was being prepared: the
      // turn is sent anyway, with its text, and the pause is delivered to it.
      // The deadline starts with the request, never during the preparation.
      if (state.interrupt) this.watchPause(conversationId);
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
        ...(context?.model && { model: context.model.model, effort: context.model.effort }),
        // Same mode as the thread: the turn cannot be widened back to a policy
        // that reads the whole computer. With the profile, a sandbox policy
        // cannot be sent at all; without MXC, the write protection is the same
        // one the app always had.
        ...(this.backend === "elevated"
          ? {
              sandboxPolicy: {
                type: "workspaceWrite" as const,
                writableRoots: [this.options.workspace],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              },
            }
          : { permissions: PERMISSIONS_PROFILE }),
      }, state);
      if (!state.completed && this.available && (!turn || turn.status === "inProgress")) {
        if (turn) this.turns.set(conversationId, turn.id);
        // A refused pause must not reject send(): the app would scan and release
        // the work while the turn still runs. The pause deadline stops it.
        if (state.interrupt)
          await this.interrupt(conversationId).catch(error => this.emit({ type: "detail", conversationId, text: String(error) }));
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
    this.closeQuestions("stopped");
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
    if (child) {
      // Let the app-server close on its own, then stop the whole tree. Both
      // waits are bounded: a stuck kill must never hang the app.
      child.stdin.end();
      if (!(await this.waitExit(child, 2000))) await this.stopTree(child);
    }
    // A process that failed or was replaced is no longer `child`: it must not
    // be left running after close() returns.
    const last = this.lastChild;
    if (last && last !== child && this.childRunning(last)) await this.stopTree(last);
  }
}
