import type { FileRef, Work } from "../../server/src/contracts";

const STORAGE_KEY = "bitacora:opened-deliverables";
const MAX_STORED = 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type OpenedState = {
  /** False when localStorage is unavailable or throws; shows no dots to avoid noise. */
  available: boolean;
  /** ISO timestamp from first run; deliverables created at or before this are treated as opened. */
  since: string;
  /** Deliverable IDs opened, previewed, downloaded, or copied since tracking began (LRU order). */
  ids: Set<string>;
};

function getStorage(storage?: StorageLike): StorageLike | undefined {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function capIds(ids: Set<string>): Set<string> {
  if (ids.size <= MAX_STORED) return ids;
  const trimmed = new Set<string>();
  const skip = ids.size - MAX_STORED;
  let index = 0;
  for (const id of ids) {
    if (index++ >= skip) trimmed.add(id);
  }
  return trimmed;
}

function writeOpenedState(state: OpenedState, storage?: StorageLike): boolean {
  try {
    const store = getStorage(storage);
    if (!store) return false;
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({ since: state.since, ids: Array.from(state.ids) }),
    );
    return true;
  } catch {
    return false;
  }
}

function sameOrder(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  const iterA = a.values();
  const iterB = b.values();
  for (let i = 0; i < a.size; i++) {
    if (iterA.next().value !== iterB.next().value) return false;
  }
  return true;
}

/**
 * Initializes per-viewer tracking of opened deliverables. On first run (no key
 * saved yet), stores a `since` timestamp so existing deliverables do not all
 * show unread dots. When storage fails or is blocked, returns `available: false`
 * so no dots are shown.
 */
export function initOpenedState(
  storage?: StorageLike,
  now: () => string = () => new Date().toISOString(),
): OpenedState {
  const unavailable: OpenedState = { available: false, since: "", ids: new Set() };
  try {
    const store = getStorage(storage);
    if (!store) return unavailable;
    const raw = store.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as { since?: unknown }).since === "string" &&
        Array.isArray((parsed as { ids?: unknown }).ids)
      ) {
        const ids = capIds(
          new Set(
            (parsed as { ids: unknown[] }).ids.filter(
              (id): id is string => typeof id === "string",
            ),
          ),
        );
        return { available: true, since: (parsed as { since: string }).since, ids };
      }
    }
    const fresh: OpenedState = { available: true, since: now(), ids: new Set() };
    return writeOpenedState(fresh, store) ? fresh : unavailable;
  } catch {
    return unavailable;
  }
}

/** True when a deliverable is still present and has not been opened yet by this viewer. */
export function isDeliverableUnopened(file: FileRef, state: OpenedState): boolean {
  if (!state.available || file.reverted || state.ids.has(file.id)) return false;
  const created = Date.parse(file.createdAt);
  const since = Date.parse(state.since);
  if (Number.isFinite(created) && Number.isFinite(since) && created <= since) {
    return false;
  }
  return true;
}

/**
 * Marks the given deliverable files as opened (moving existing IDs to the tail
 * for LRU retention), enforces the in-memory cap, and persists the state.
 */
export function markDeliverablesOpened(
  state: OpenedState,
  files: FileRef[],
  storage?: StorageLike,
): OpenedState {
  if (!state.available) return state;
  const idsToMark = files.map((f) => f.id).filter(Boolean);
  if (!idsToMark.length) return state;

  const next = new Set(state.ids);
  for (const id of idsToMark) {
    next.delete(id);
    next.add(id);
  }
  const capped = capIds(next);
  if (sameOrder(state.ids, capped)) return state;
  const updated: OpenedState = { ...state, ids: capped };
  writeOpenedState(updated, storage);
  return updated;
}

/** Drops stored IDs that are no longer present in any work's deliverable results. */
export function pruneOpenedState(
  state: OpenedState,
  works: Work[],
  storage?: StorageLike,
): OpenedState {
  if (!state.available || state.ids.size === 0) return state;
  const liveIds = new Set<string>();
  for (const work of works) {
    for (const message of work.messages) {
      for (const file of message.results ?? []) {
        if (file.id) liveIds.add(file.id);
      }
    }
  }
  const pruned = new Set<string>();
  for (const id of state.ids) {
    if (liveIds.has(id)) pruned.add(id);
  }
  if (pruned.size === state.ids.size) return state;
  const updated: OpenedState = { ...state, ids: pruned };
  writeOpenedState(updated, storage);
  return updated;
}
