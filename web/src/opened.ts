import type { FileRef } from "../../server/src/contracts";

const STORAGE_KEY = "bitacora:opened-deliverables";
const MAX_STORED = 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function getStorage(storage?: StorageLike): StorageLike | undefined {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the set of deliverable IDs the viewer has already opened, previewed, or downloaded. */
export function readOpenedIds(storage?: StorageLike): Set<string> {
  try {
    const store = getStorage(storage);
    const raw = store?.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function writeOpenedIds(ids: Set<string>, storage?: StorageLike): void {
  try {
    const store = getStorage(storage);
    if (!store) return;
    const list = Array.from(ids);
    const trimmed = list.length > MAX_STORED ? list.slice(list.length - MAX_STORED) : list;
    store.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage errors (private mode, quota, disabled storage).
  }
}

/** True when a deliverable is still present and has not been opened yet by this viewer. */
export function isDeliverableUnopened(file: FileRef, opened: Set<string>): boolean {
  return !file.reverted && !opened.has(file.id);
}

/** Marks the given files as opened and persists them; returns `current` if nothing changed. */
export function markDeliverablesOpened(
  current: Set<string>,
  files: FileRef[],
  storage?: StorageLike,
): Set<string> {
  let changed = false;
  for (const file of files) {
    if (file.id && !current.has(file.id)) {
      changed = true;
      break;
    }
  }
  if (!changed) return current;
  const next = new Set(current);
  for (const file of files) {
    if (file.id) next.add(file.id);
  }
  writeOpenedIds(next, storage);
  return next;
}
