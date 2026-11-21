import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const SESSION_DIRS = ["sessions", "archived_sessions"];
export const CHAT_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const PREFIX = "bitacora-codex-history-";
const STATE_DB = /^state.*\.sqlite$/i;
const STATE_FILE = /^state.*\.sqlite(?:-wal|-shm)?$/i;
const STALE_AFTER_MS = 24 * 60 * 60_000;

export class HistoryProblem extends Error {}

export function logHistoryFailure(stage: string, error: unknown) {
  console.warn("[codex-history] " + stage + ": " + (error instanceof Error ? error.constructor.name : "Error"));
}

export function withoutWindowsPrefix(path: string) {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}

export function inside(root: string, target: string): string | undefined {
  const child = relative(root, target);
  if (child && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child)) return child;
}

function pathKey(path: string) {
  return win32.normalize(withoutWindowsPrefix(path)).toLowerCase();
}

export async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function removeSnapshot(path: string) {
  try { await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); }
  catch (error) { logHistoryFailure("cleanup", error); }
}

export async function sweepHistorySnapshots(temp = tmpdir(), now = Date.now()) {
  try {
    const root = await realpath(temp);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
      const path = join(root, entry.name);
      const info = await optionalStat(path);
      if (!info?.isDirectory() || now - info.mtimeMs < STALE_AFTER_MS) continue;
      const pid = Number(/^bitacora-codex-history-(\d+)-/.exec(entry.name)?.[1]);
      if (pid > 0) {
        try { process.kill(pid, 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
      }
      const target = await realpath(path).catch(() => undefined);
      if (target && inside(root, target) === entry.name) await removeSnapshot(target);
    }
  } catch (error) { logHistoryFailure("startup cleanup", error); }
}

async function* rollouts(root: string, folder: string, signal: AbortSignal): AsyncGenerator<string> {
  signal.throwIfAborted();
  const path = join(root, folder);
  if (!(await optionalStat(path))?.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    signal.throwIfAborted();
    const child = join(folder, entry.name);
    if (entry.isDirectory()) yield* rollouts(root, child, signal);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield child;
  }
}

export async function copyHistoryFile(source: string, target: string, signal: AbortSignal, charge?: (bytes: number) => void) {
  signal.throwIfAborted();
  const destination = await open(target, "wx");
  try {
    const count = new Transform({ transform(chunk: Buffer, _, callback) {
      try { charge?.(chunk.length); callback(null, chunk); }
      catch (error) { callback(error as Error); }
    } });
    await pipeline(createReadStream(source), count, destination.createWriteStream(), { signal });
  } catch (error) {
    await destination.close().catch(() => {});
    await rm(target, { force: true }).catch(problem => logHistoryFailure("unfinished copy cleanup", problem));
    throw error;
  }
}

async function sanitizeStateDatabase(
  database: string, source: string, snapshot: string, copies: Map<string, string>, signal: AbortSignal,
) {
  const db = new DatabaseSync(database, { enableForeignKeyConstraints: false });
  try {
    if (!db.prepare("PRAGMA table_info(threads)").all().some(column => column.name === "rollout_path"))
      throw new Error("Unrecognized state schema");
    const rows = db.prepare("SELECT id, rollout_path, cwd FROM threads").all();
    const update = db.prepare("UPDATE threads SET rollout_path = ?, cwd = ? WHERE id = ?");
    const discard = db.prepare("DELETE FROM threads WHERE id = ?");
    db.exec("BEGIN");
    for (const row of rows) {
      signal.throwIfAborted();
      if (typeof row.rollout_path !== "string") { discard.run(row.id); continue; }
      const original = withoutWindowsPrefix(row.rollout_path);
      const copied = copies.get(pathKey(original)) ??
        copies.get(pathKey(await realpath(original).catch(() => original)));
      if (!copied) { discard.run(row.id); continue; }
      const cwd = typeof row.cwd === "string" ? row.cwd : "";
      const cwdKey = pathKey(cwd && await realpath(withoutWindowsPrefix(cwd)).catch(() => cwd));
      const sourceKey = pathKey(source);
      const local = cwdKey === sourceKey || cwdKey.startsWith(sourceKey + "\\");
      update.run(copied, local ? snapshot : cwd, row.id);
    }
    // Keep discovery metadata. The other tables store settings and live paths
    // that the reader never needs, including skipped rollouts and project roots.
    for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()) {
      if (typeof name !== "string" || name === "threads" || name === "_sqlx_migrations" || name.startsWith("sqlite_")) continue;
      db.exec('DELETE FROM "' + name.replaceAll('"', '""') + '"');
    }
    db.exec("UPDATE threads SET project_id = NULL, thread_section_id = NULL, git_origin_url = NULL, agent_path = NULL, creator_user_id = NULL, creator_account_id = NULL, sandbox_policy = '{\"type\":\"read-only\"}', approval_mode = 'never'");
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    if (db.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete")
      throw new Error("Could not close the copied state journal");
    db.exec("VACUUM");
    signal.throwIfAborted();
  } finally { db.close(); }
}

async function sanitizeSessionIndex(source: string, snapshot: string, ids: ReadonlySet<string> | undefined,
  charge: (bytes: number) => void, signal: AbortSignal) {
  const file = join(source, "session_index.jsonl");
  const info = await optionalStat(file);
  if (!info?.isFile()) return;
  // The index is optional and rebuilt by Codex if absent. Bound the text read
  // individually as well as the total copy.
  if (info.size > 16 * 1024 ** 2) return;
  const original = await readFile(file, { signal });
  charge(original.length);
  const records: object[] = [];
  for (const line of original.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    signal.throwIfAborted();
    try {
      const { id, thread_name, updated_at } = JSON.parse(line);
      if (typeof id === "string" && CHAT_ID.test(id) && (!ids || ids.has(id.toLowerCase())) &&
          typeof thread_name === "string" && typeof updated_at === "string" && Number.isFinite(Date.parse(updated_at)))
        records.push({ id, thread_name, updated_at });
    } catch (error) { logHistoryFailure("session index record", error); }
  }
  await writeFile(join(snapshot, "session_index.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n", { signal });
}

export async function createHistorySnapshot<T>(
  sourcePath: string, selected: ReadonlySet<string> | undefined, signal: AbortSignal, maxBytes: number, empty: T,
  use: (snapshot: string, realSource: string) => Promise<T>,
) {
  signal.throwIfAborted();
  if (!await optionalStat(sourcePath)) return empty;
  const source = await realpath(sourcePath);
  const snapshot = await mkdtemp(join(tmpdir(), PREFIX + process.pid + "-"));
  let remaining = maxBytes;
  const charge = (bytes: number) => {
    signal.throwIfAborted();
    remaining -= bytes;
    if (remaining < 0)
      throw new HistoryProblem("Tus chats de Codex ocupan demasiado espacio para copiarlos en Bitácora.");
  };
  try {
    const copies = new Map<string, string>();
    for (const dir of SESSION_DIRS) {
      for await (const child of rollouts(source, dir, signal)) {
        const id = child.slice(-42, -6).toLowerCase();
        if (selected && !selected.has(id)) continue;
        const original = join(source, child);
        const info = await optionalStat(original);
        if (!info?.isFile()) continue;
        if (info.size > remaining) charge(info.size);
        const target = join(snapshot, child);
        await mkdir(dirname(target), { recursive: true });
        await copyHistoryFile(original, target, signal, charge);
        await utimes(target, info.atime, info.mtime);
        copies.set(pathKey(original), target);
      }
    }
    if (!copies.size) return empty;
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (!entry.isFile() || !STATE_FILE.test(entry.name)) continue;
      try { await copyHistoryFile(join(source, entry.name), join(snapshot, entry.name), signal, charge); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const name of (await readdir(snapshot)).filter(name => STATE_FILE.test(name))) {
      if (!STATE_DB.test(name)) {
        if (!await optionalStat(join(snapshot, name.replace(/-(?:wal|shm)$/i, ""))))
          await rm(join(snapshot, name), { force: true });
        continue;
      }
      const database = join(snapshot, name);
      try { await sanitizeStateDatabase(database, source, snapshot, copies, signal); }
      catch (error) {
        signal.throwIfAborted();
        logHistoryFailure("state database fallback", error);
        await rm(database, { force: true });
      }
      for (const suffix of ["-wal", "-shm", "-journal"])
        await rm(database + suffix, { force: true });
    }
    // thread_history databases hold tool output and file paths. The reader
    // reconstructs the display from the rollout (the saved chat itself).
    await sanitizeSessionIndex(source, snapshot, selected, charge, signal);
    signal.throwIfAborted();
    return await use(snapshot, source);
  } finally { await removeSnapshot(snapshot); }
}
