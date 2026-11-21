import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { basename, join, relative, sep, win32 } from "node:path";
import { createInterface } from "node:readline";

import { codexBinary } from "../../../scripts/codex-runtime.mjs";
import { AGENCY_ENVIRONMENT } from "../agency-environment";
import type { CodexChat, Message } from "../contracts";
import { cleanTitle, fallbackTitle } from "../titles";
import { codexEnvironmentArgs } from "./environment";
import {
  CHAT_ID, HistoryProblem, SESSION_DIRS, copyHistoryFile, createHistorySnapshot,
  inside, logHistoryFailure, removeSnapshot, withoutWindowsPrefix,
} from "./history-snapshot";
import type { ThreadSourceKind } from "./generated/v2/ThreadSourceKind";
import type { ClientRequest } from "./generated/ClientRequest";
import type { Thread } from "./generated/v2/Thread";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse";

const CHAT_SOURCES: ThreadSourceKind[] = ["cli", "vscode", "exec", "appServer", "unknown"];
const DEFAULT_LIMITS = { maxBytes: 3 * 1024 ** 3, timeoutMs: 30_000 };

type HistoryRequest = Extract<ClientRequest, { method: "initialize" | "thread/list" | "thread/read" }>;
type Reader = <R>(method: HistoryRequest["method"], params: HistoryRequest["params"]) => Promise<R>;

async function folderKey(folder: string) {
  if (!folder) return "";
  const actual = await realpath(folder).catch(() => folder);
  return win32.normalize(withoutWindowsPrefix(actual)).replace(/\\+$/, "").toLowerCase();
}

async function withReader<T>(binary: string, home: string, signal: AbortSignal, use: (rpc: Reader) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CODEX_|OPENAI_|ANTHROPIC_)/i.test(key) && !/TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL/i.test(key)));
  const child = spawn(binary, [
    "app-server", "--listen", "stdio://",
    "-c", 'cli_auth_credentials_store="file"',
    "-c", 'sandbox_mode="read-only"',
    "-c", 'approval_policy="never"',
    ...codexEnvironmentArgs({ ...AGENCY_ENVIRONMENT, aiImages: false, webSearch: "disabled", goals: false }),
  ], { cwd: home, env: { ...env, CODEX_HOME: home }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise<void>(done => child.once("close", () => done()));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = lines[Symbol.asyncIterator]();
  child.on("error", () => lines.close());
  child.stdin.on("error", () => lines.close());
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    lines.close();
    child.stdin.destroy();
    child.stdout.destroy();
    try { child.kill(); }
    catch (error) { logHistoryFailure("reader stop", error); }
  };
  signal.addEventListener("abort", stop, { once: true });
  let id = 0;
  const rpc: Reader = async <R>(method: HistoryRequest["method"], params: HistoryRequest["params"]) => {
    const requestId = ++id;
    try {
      signal.throwIfAborted();
      child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
      for (;;) {
        const line = await replies.next();
        if (line.done) throw new Error("Codex history reader stopped");
        const message = JSON.parse(line.value);
        if (message.id !== requestId || message.method) continue;
        if (message.error || !message.result) throw new Error("Codex history request failed: " + method);
        return message.result as R;
      }
    } catch (error) {
      signal.throwIfAborted();
      logHistoryFailure(method, error);
      throw error;
    }
  };
  try {
    await rpc("initialize", {
      clientInfo: { name: "bitacora-history", title: "Bitácora", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin.write('{"method":"initialized"}\n');
    return await use(rpc);
  } finally {
    signal.removeEventListener("abort", stop);
    lines.close();
    stop();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 500); })]);
    clearTimeout(timer);
  }
}

async function readList(rpc: Reader) {
  const threads = new Map<string, Thread>();
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: ThreadListResponse = await rpc("thread/list", {
        archived, cursor, limit: 100, modelProviders: [], sourceKinds: CHAT_SOURCES, sortKey: "updated_at",
      });
      for (const thread of page.data) if (!threads.has(thread.id)) threads.set(thread.id, thread);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Codex repeated a history cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  return [...threads.values()];
}

async function readRolloutMessages(path: string, signal: AbortSignal): Promise<Message[]> {
  // A paginated store is optional. Its canonical rollout carries the display
  // events as well as the model context. Consume only completed text messages.
  const input = createReadStream(path, { signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const messages: Message[] = [];
  const seen = new Set<string>();
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      let record;
      try { record = JSON.parse(line); }
      catch (error) { logHistoryFailure("rollout record", error); continue; }
      if (record.type !== "event_msg" || !record.payload) continue;
      const event = record.payload;
      if (event.type === "user_message" || event.type === "agent_message") {
        if (typeof event.message === "string" && event.message.trim())
          messages.push({ id: "message-" + messages.length, role: event.type === "user_message" ? "user" : "assistant", text: event.message });
        continue;
      }
      if (event.type !== "item_completed") continue;
      const item = event.item;
      if (!item || !["UserMessage", "AgentMessage"].includes(item.type) ||
          typeof item.id !== "string" || seen.has(item.id) || !Array.isArray(item.content)) continue;
      const text = item.content.flatMap((part: {type?: string; text?: string}) =>
        part?.type?.toLowerCase() === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
      if (!text.trim()) continue;
      seen.add(item.id);
      messages.push({ id: item.id, role: item.type === "UserMessage" ? "user" : "assistant", text });
    }
  } finally {
    lines.close();
    input.destroy();
  }
  signal.throwIfAborted();
  return messages;
}

function summary(thread: Thread) {
  return {
    id: thread.id,
    title: cleanTitle(thread.name) || fallbackTitle(thread.preview) || "Chat sin título",
    date: new Date(thread.updatedAt * 1000).toISOString(),
  };
}

export type ImportedChat = ReturnType<typeof summary> & { createdAt: string; messages: Message[]; rollout: string };

export class CodexHistory {
  constructor(
    private source: string,
    private home: string,
    private binary?: string,
    private limits = DEFAULT_LIMITS,
  ) {}

  private async withSnapshot<T>(empty: T, signal: AbortSignal, selected: ReadonlySet<string> | undefined,
    use: (rpc: Reader, snapshot: string, source: string, operation: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = AbortSignal.timeout(this.limits.timeoutMs);
    const operation = AbortSignal.any([signal, deadline]);
    const attempt = (withState: boolean) =>
      createHistorySnapshot(this.source, selected, operation, this.limits.maxBytes, empty,
        (snapshot, source) => withReader(this.binary || codexBinary(), snapshot, operation,
          rpc => use(rpc, snapshot, source, operation)), withState);
    try {
      try { return await attempt(true); }
      catch (error) {
        // A state database from a newer Codex can stop the bundled reader.
        // The rollouts alone are enough, so try once more without it.
        if (operation.aborted || error instanceof HistoryProblem) throw error;
        logHistoryFailure("reader with state database", error);
        return await attempt(false);
      }
    } catch (error) {
      if (deadline.aborted && !signal.aborted)
        throw new HistoryProblem("Traer tus chats de Codex tardó demasiado. Probá de nuevo.");
      throw error;
    }
  }

  list(workspace: string, signal: AbortSignal): Promise<Omit<CodexChat, "imported">[]> {
    return this.withSnapshot([], signal, undefined, async rpc => {
      const workspaceKey = await folderKey(workspace);
      const threads = await readList(rpc);
      const folders = new Map<string, Promise<string>>();
      return (await Promise.all(threads.map(async thread => {
        if (!folders.has(thread.cwd)) folders.set(thread.cwd, folderKey(thread.cwd));
        const sameFolder = !!workspaceKey && await folders.get(thread.cwd) === workspaceKey;
        return {
          ...summary(thread), sameFolder,
          folder: win32.basename(thread.cwd) || thread.cwd || "Carpeta desconocida",
        };
      }))).sort((a, b) => Number(b.sameFolder) - Number(a.sameFolder) || b.date.localeCompare(a.date));
    });
  }

  import(ids: string[], signal: AbortSignal, accept: (chat: ImportedChat) => void): Promise<string[]> {
    const selected = new Set(ids.filter(id => CHAT_ID.test(id)).map(id => id.toLowerCase()));
    if (!selected.size) return Promise.resolve([...ids]);
    return this.withSnapshot([...ids], signal, selected, async (rpc, snapshot, source, operation) => {
      // Populate the snapshot index before reading by ID (also works without a copied DB).
      const listed = new Set((await readList(rpc)).map(thread => thread.id));
      const failed: string[] = [];
      for (const id of ids) {
        operation.throwIfAborted();
        try {
          if (!CHAT_ID.test(id) || !listed.has(id)) throw new Error("Unknown Codex chat ID");
          const { thread } = await rpc<ThreadReadResponse>("thread/read", { threadId: id });
          if (thread.id !== id || !thread.path) throw new Error("Codex chat has no rollout");
          const path = await realpath(thread.path);
          const child = inside(await realpath(snapshot), path);
          if (!child || !SESSION_DIRS.includes(child.split(sep)[0]) || !basename(path).endsWith(".jsonl"))
            throw new Error("Codex chat rollout is outside the snapshot");
          // 0.168 cannot defer outputs on thread/read. Read metadata there
          // and stream the display events without hydrating command output.
          const messages = await readRolloutMessages(path, operation);
          const metadata = { ...summary(thread), createdAt: new Date(thread.createdAt * 1000).toISOString() };
          // The data directory already exists. Reject junctions before creating anything below it.
          const data = await realpath(join(this.home, ".."));
          const home = join(data, basename(this.home));
          let parent = data;
          const date = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(basename(path));
          if (!date || !relative(source, data) || inside(source, data))
            throw new Error("Invalid Codex rollout destination");
          const directories = ["sessions", ...date.slice(1)];
          for (const name of [basename(this.home), ...directories]) {
            parent = join(parent, name);
            if (!relative(source, parent) || inside(source, parent))
              throw new Error("Codex homes must be separate");
            await mkdir(parent, { recursive: true });
            if (!(await lstat(parent)).isDirectory()) throw new Error("Unsafe Codex rollout directory");
          }
          let target = join(parent, basename(path));
          try { await copyHistoryFile(path, target, operation); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            // A previous interrupted save may have left a copy. Never overwrite it.
            const retry = await mkdtemp(join(parent, "import-"));
            target = join(retry, basename(path));
            try { await copyHistoryFile(path, target, operation); }
            catch (error) { await removeSnapshot(retry); throw error; }
          }
          accept({ ...metadata, messages, rollout: relative(home, target) });
        } catch (error) {
          operation.throwIfAborted();
          logHistoryFailure("import", error);
          failed.push(id);
        }
      }
      return failed;
    });
  }
}
