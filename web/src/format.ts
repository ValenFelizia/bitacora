import type { FileRef, Work } from "../../server/src/contracts";

/** Short Spanish date for the sidebar work list ("hoy", "14 nov"). */
export function formatWorkDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return "hoy";
  }
  return date
    .toLocaleDateString("es-AR", { day: "numeric", month: "short" })
    .replace(/\.$/, "");
}

/** 24-hour local time ("14:05") for progress log entries and deliverable metadata. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export type DeliverableGroup = {
  id: string;
  messageId: string;
  kind: "plates" | "images" | "file";
  title: string;
  meta: string;
  plates: FileRef[];
  /** Primary file to view/open/download when this is a single file or PDF. */
  primary: FileRef;
  /** Every file produced in this batch (including plates, todas.png, piezas.pdf). */
  allFiles: FileRef[];
};

export type GroupedDeliverableBatches = {
  featured?: DeliverableGroup;
  olderGroups: DeliverableGroup[];
};

const isPlate = (file: FileRef) =>
  file.mime.startsWith("image/") && /^pieza-\d+\./i.test(file.name);

export const isOverview = (file: FileRef) =>
  file.mime.startsWith("image/") && /^todas\./i.test(file.name);

function sortPlates(files: FileRef[]): FileRef[] {
  return [...files].sort((a, b) => {
    const na = Number(a.name.match(/^pieza-(\d+)\./i)?.[1] ?? NaN);
    const nb = Number(b.name.match(/^pieza-(\d+)\./i)?.[1] ?? NaN);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return a.name.localeCompare(b.name);
  });
}

function folderKey(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : "";
}

function folderTitle(dir: string, fallback: string): string {
  if (!dir) return fallback;
  const parts = dir.split("/").filter(Boolean);
  // `propuestas/<destino>/salida` -> `<destino>` when `salida` is just the output folder.
  const candidate =
    parts.length >= 2 && parts[parts.length - 1].toLowerCase() === "salida"
      ? parts[parts.length - 2]
      : parts[parts.length - 1];
  const cleaned = candidate.replace(/[-_]+/g, " ").trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : fallback;
}

function buildDeliverableGroup(
  batch: { id: string; messageId: string; title: string; files: FileRef[] },
): DeliverableGroup {
  const files = batch.files;
  const plates = sortPlates(files.filter(isPlate));
  const images = files.filter((f) => f.mime.startsWith("image/") && !isOverview(f));
  const latestTime = files.reduce(
    (max, f) => (f.createdAt > max ? f.createdAt : max),
    files[0].createdAt,
  );
  const timeText = formatTime(latestTime);

  if (plates.length >= 1) {
    const rest = files.filter((f) => !isPlate(f) && !isOverview(f));
    const countLabel = plates.length === 1 ? "1 placa" : `${plates.length} placas`;
    return {
      id: batch.id,
      messageId: batch.messageId,
      kind: "plates",
      title: batch.title,
      meta: `${countLabel}${timeText ? ` · ${timeText}` : ""}`,
      plates,
      primary: plates[0],
      allFiles: [...plates, ...files.filter(isOverview), ...rest],
    };
  }

  if (images.length >= 2) {
    const rest = files.filter((f) => !images.includes(f) && !isOverview(f));
    return {
      id: batch.id,
      messageId: batch.messageId,
      kind: "images",
      title: batch.title,
      meta: `${images.length} imágenes${timeText ? ` · ${timeText}` : ""}`,
      plates: images,
      primary: images[0],
      allFiles: [...images, ...files.filter(isOverview), ...rest],
    };
  }

  const sortedTarget = [...files].sort((a, b) => {
    const aImg = a.mime.startsWith("image/") ? 0 : 1;
    const bImg = b.mime.startsWith("image/") ? 0 : 1;
    if (aImg !== bImg) return aImg - bImg;
    return b.createdAt.localeCompare(a.createdAt);
  });
  const primary = sortedTarget[0];
  const singleImage = sortedTarget.length === 1 && primary.mime.startsWith("image/");

  return {
    id: batch.id,
    messageId: batch.messageId,
    kind: singleImage ? "images" : "file",
    title: primary.name,
    meta: timeText || "",
    plates: primary.mime.startsWith("image/") ? [primary] : [],
    primary,
    allFiles: sortedTarget,
  };
}

/**
 * Splits a message's results by proposal folder only when two or more folders
 * contain `pieza-N` plates. Otherwise keeps a single group (plates first, rest
 * as extras) so reference photos in another folder never overshadow the plates.
 * When multiple groups remain, plate groups are ordered last so the featured
 * group is always a plates group.
 */
function splitMessageBatches(
  messageId: string,
  files: FileRef[],
  workTitle: string,
): { id: string; messageId: string; title: string; files: FileRef[] }[] {
  const byDir = new Map<string, { dir: string; files: FileRef[]; hasPlates: boolean }>();
  for (const file of files) {
    const dir = folderKey(file.path);
    const key = dir.toLowerCase();
    const bucket = byDir.get(key);
    if (bucket) {
      bucket.files.push(file);
      if (isPlate(file)) bucket.hasPlates = true;
    } else {
      byDir.set(key, { dir, files: [file], hasPlates: isPlate(file) });
    }
  }
  const buckets = Array.from(byDir.values());
  const plateBucketCount = buckets.filter((b) => b.hasPlates).length;
  if (plateBucketCount < 2) {
    return [{ id: messageId, messageId, title: workTitle, files }];
  }
  // Keep non-plate buckets before plate buckets so the latest/featured slot is a plates group.
  const ordered = [
    ...buckets.filter((b) => !b.hasPlates),
    ...buckets.filter((b) => b.hasPlates),
  ];
  return ordered.map(({ dir, files: groupFiles }) => ({
    id: `${messageId}:${dir}`,
    messageId,
    title: folderTitle(dir, workTitle),
    files: groupFiles,
  }));
}

/**
 * Groups the work's results by proposal/batch so the chosen batch (latest by
 * default, or the requested message's batch) is featured at the top and older
 * batches stay grouped below in reverse chronological order.
 */
export function groupDeliverableBatches(
  work: Work | undefined,
  messageId?: string,
): GroupedDeliverableBatches {
  if (!work) return { olderGroups: [] };
  const batches = work.messages
    .filter((m) => m.results && m.results.length > 0)
    .flatMap((m) => splitMessageBatches(m.id, m.results!, work.title));

  if (!batches.length) return { olderGroups: [] };

  let chosenIndex = -1;
  if (messageId) {
    for (let i = batches.length - 1; i >= 0; i--) {
      if (batches[i].id === messageId || batches[i].messageId === messageId) {
        chosenIndex = i;
        break;
      }
    }
  }
  if (chosenIndex < 0) chosenIndex = batches.length - 1;

  const target = batches[chosenIndex];
  const olderGroups = batches
    .filter((_, idx) => idx !== chosenIndex)
    .reverse()
    .map(buildDeliverableGroup);

  return {
    featured: buildDeliverableGroup(target),
    olderGroups,
  };
}

/** Count shown on the mobile chat button so it matches the panel's piece count. */
export function messageDeliverableCount(work: Work | undefined, messageId: string): number {
  if (!work) return 0;
  const message = work.messages.find((m) => m.id === messageId);
  if (!message?.results?.length) return 0;
  const groups = splitMessageBatches(message.id, message.results, work.title).map(
    buildDeliverableGroup,
  );
  return groups.reduce(
    (sum, g) => sum + (g.plates.length > 0 ? g.plates.length : g.allFiles.length),
    0,
  );
}

export function undoSummary(
  undo: { workId: string; messageId?: string },
  works: Work[],
): string {
  const work = works.find((w) => w.id === undo.workId);
  const message = undo.messageId
    ? work?.messages.find((m) => m.id === undo.messageId)
    : undefined;
  if (message) {
    if (!message.results?.length) return "";
    const groups = splitMessageBatches(message.id, message.results, work!.title).map(
      buildDeliverableGroup,
    );
    const totalPlates = groups.reduce((sum, g) => sum + g.plates.length, 0);
    if (groups.every((g) => g.kind === "plates")) {
      return totalPlates === 1 ? "Se cambió 1 placa" : `Se cambiaron ${totalPlates} placas`;
    }
    if (groups.every((g) => g.kind === "images")) {
      return totalPlates === 1 ? "Se cambió 1 imagen" : `Se cambiaron ${totalPlates} imágenes`;
    }
    const count = message.results.length;
    return count === 1
      ? "Se cambió 1 archivo"
      : `Se cambiaron ${count} archivos`;
  }
  return "Hubo cambios en los archivos";
}
