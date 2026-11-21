import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { codexBinary } from "../../../scripts/codex-runtime.mjs";
import { AGENCY_ENVIRONMENT } from "../agency-environment";
import type { CodexChat, Message } from "../contracts";
import { cleanTitle, fallbackTitle } from "../titles";
import { codexEnvironmentArgs } from "./environment";
import type { ClientRequest } from "./generated/ClientRequest";
import type { Thread } from "./generated/v2/Thread";
import type { ThreadItem } from "./generated/v2/ThreadItem";
import type { ThreadItemsListResponse } from "./generated/v2/ThreadItemsListResponse";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse";

const SESSION_DIRS = ["sessions", "archived_sessions"];
const STATE_DB = /^state.*\.sqlite$/i;
// Paginated chats keep their visible items in a separate Codex history DB.
const HISTORY_DB_FILE = /^(?:state.*|thread_history_\d+)\.sqlite(?:-wal|-shm)?$/i;
const CHAT_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

type HistoryRequest = Extract<ClientRequest, { method: "initialize" | "thread/list" | "thread/read" | "thread/items/list" }>;
type Reader = <R>(method: HistoryRequest["method"], params: HistoryRequest["params"]) => Promise<R>;

function withoutWindowsPrefix(path: string) {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}

function inside(root: string, target: string): string | undefined {
  const child = relative(root, target);
  if (child && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child)) return child;
}

async function folderKey(folder: string) {
  if (!folder) return "";
  const actual = await realpath(folder).catch(() => folder);
  return win32.normalize(withoutWindowsPrefix(actual))
    .replace(/\\+$/, "").toLowerCase();
}

async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function copyHistory(source: string, home: string, signal: AbortSignal) {
  let hasHistory = false;
  for (const name of SESSION_DIRS) {
    const path = join(source, name);
    if (!(await optionalStat(path))?.isDirectory()) continue;
    await cp(path, join(home, name), {
      recursive: true,
      preserveTimestamps: true,
      filter: async (entry) => {
        signal.throwIfAborted();
        const stat = await lstat(entry);
        const rollout = stat.isFile() && entry.endsWith(".jsonl");
        if (rollout) hasHistory = true;
        return stat.isDirectory() || rollout;
      },
    });
  }
  if (!hasHistory) return false;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    signal.throwIfAborted();
    if (!entry.isFile() || (!HISTORY_DB_FILE.test(entry.name) && entry.name !== "session_index.jsonl")) continue;
    await copyFile(join(source, entry.name), join(home, entry.name));
  }
  return true;
}

/** The copied DB still contains absolute references to the user's live rollouts. */
function rebaseStateDatabase(database: string, source: string, home: string) {
  const db = new DatabaseSync(database);
  try {
    const columns = db.prepare("PRAGMA table_info(threads)").all();
    if (!columns.some(column => column.name === "rollout_path")) return;
    const rows = db.prepare("SELECT DISTINCT rollout_path FROM threads").all();
    const update = db.prepare("UPDATE threads SET rollout_path = ? WHERE rollout_path = ?");
    db.exec("BEGIN");
    for (const { rollout_path: path } of rows) {
      if (typeof path !== "string") continue;
      const child = inside(source, resolve(withoutWindowsPrefix(path)));
      const isSession = child && SESSION_DIRS.includes(child.split(sep)[0]);
      update.run(isSession ? join(home, child) : join(home, "missing-rollout"), path);
    }
    db.exec("COMMIT");
  } finally { db.close(); }
}

async function withReader<T>(binary: string, home: string, signal: AbortSignal, use: (rpc: Reader) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CODEX_|OPENAI_|ANTHROPIC_)/i.test(key) && !/TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL/i.test(key)));
  const child = spawn(binary, [
    "app-server", "--listen", "stdio://",
    "-c", 'cli_auth_credentials_store="file"',
    ...codexEnvironmentArgs({ ...AGENCY_ENVIRONMENT, aiImages: false, webSearch: "disabled", goals: false }),
  ], { cwd: home, env: { ...env, CODEX_HOME: home }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise<void>(done => child.once("close", () => done()));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = lines[Symbol.asyncIterator]();
  child.on("error", () => lines.close());
  child.stdin.on("error", () => lines.close());
  const stop = () => child.kill();
  signal.addEventListener("abort", stop, { once: true });
  let id = 0;
  const rpc: Reader = async <R>(method: HistoryRequest["method"], params: HistoryRequest["params"]) => {
    const requestId = ++id;
    const timeout = setTimeout(stop, 60_000);
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
    } finally { clearTimeout(timeout); }
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
    await closed;
  }
}

async function readList(rpc: Reader) {
  const threads = new Map<string, Thread>();
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: ThreadListResponse = await rpc("thread/list", {
        archived, cursor, limit: 100, modelProviders: [], sortKey: "updated_at",
      });
      for (const thread of page.data) if (!threads.has(thread.id)) threads.set(thread.id, thread);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Codex repeated a history cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  return [...threads.values()];
}

function transcript(items: ThreadItem[]): Message[] {
  return items.flatMap((item): Message[] => {
    if (item.type === "agentMessage" && item.text.trim())
      return [{ id: item.id, role: "assistant", text: item.text }];
    if (item.type !== "userMessage") return [];
    const text = item.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    return text.trim() ? [{ id: item.id, role: "user", text }] : [];
  });
}

async function readMessages(rpc: Reader, thread: Thread): Promise<Message[]> {
  if (thread.historyMode !== "paginated") {
    const { thread: full } = await rpc<ThreadReadResponse>("thread/read", { threadId: thread.id, includeTurns: true });
    return transcript(full.turns.flatMap(turn => turn.items));
  }
  const messages: Message[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: ThreadItemsListResponse = await rpc("thread/items/list", {
      threadId: thread.id, cursor, limit: 100, sortDirection: "asc", deferOutput: { commandExecution: true },
    });
    messages.push(...transcript(page.data.map(entry => entry.item)));
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Codex repeated an item cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
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
  ) {}

  private async withSnapshot<T>(empty: T, signal: AbortSignal, use: (rpc: Reader, snapshot: string) => Promise<T>): Promise<T> {
    if (!await optionalStat(this.source)) return empty;
    const source = await realpath(this.source);
    const snapshot = await mkdtemp(join(tmpdir(), "bitacora-codex-history-"));
    try {
      if (!await copyHistory(source, snapshot, signal)) return empty;
      for (const name of await readdir(snapshot)) {
        if (STATE_DB.test(name)) rebaseStateDatabase(join(snapshot, name), source, snapshot);
      }
      return await withReader(this.binary || codexBinary(), snapshot, signal, rpc => use(rpc, snapshot));
    } finally {
      await rm(snapshot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  list(workspace: string, signal: AbortSignal): Promise<Omit<CodexChat, "imported">[]> {
    return this.withSnapshot([], signal, async rpc => {
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
    return this.withSnapshot([...ids], signal, async (rpc, snapshot) => {
      // Populate the snapshot index before reading by ID (also works without a copied DB).
      const listed = new Set((await readList(rpc)).map(thread => thread.id));
      const failed: string[] = [];
      for (const id of ids) {
        signal.throwIfAborted();
        try {
          if (!CHAT_ID.test(id) || !listed.has(id)) throw new Error("Unknown Codex chat ID");
          const { thread } = await rpc<ThreadReadResponse>("thread/read", { threadId: id });
          if (thread.id !== id || !thread.path) throw new Error("Codex chat has no rollout");
          const path = await realpath(thread.path);
          const child = inside(await realpath(snapshot), path);
          if (!child || !SESSION_DIRS.includes(child.split(sep)[0]) || !basename(path).endsWith(".jsonl"))
            throw new Error("Codex chat rollout is outside the snapshot");
          const messages = await readMessages(rpc, thread);
          const metadata = { ...summary(thread), createdAt: new Date(thread.createdAt * 1000).toISOString() };
          const source = await realpath(this.source);
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
          try { await copyFile(path, target, constants.COPYFILE_EXCL); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            // A previous interrupted save may have left a copy. Never overwrite it.
            const retry = await mkdtemp(join(parent, "import-"));
            target = join(retry, basename(path));
            try { await copyFile(path, target, constants.COPYFILE_EXCL); }
            catch (error) { await rm(retry, { recursive: true, force: true }); throw error; }
          }
          accept({ ...metadata, messages, rollout: relative(home, target) });
        } catch {
          signal.throwIfAborted();
          failed.push(id);
        }
      }
      return failed;
    });
  }
}
