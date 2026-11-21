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
  kind: "plates" | "images" | "file";
  title: string;
  meta: string;
  plates: FileRef[];
  /** Primary file to view/open/download when this is a single file or PDF. */
  primary: FileRef;
  /** Every file produced in this latest batch (including plates, todas.png, piezas.pdf). */
  allFiles: FileRef[];
};

export type GroupedDeliverables = {
  featured?: DeliverableGroup;
  older: FileRef[];
};

export type GroupedDeliverableBatches = {
  featured?: DeliverableGroup;
  olderGroups: DeliverableGroup[];
};

const isPlate = (file: FileRef) =>
  file.mime.startsWith("image/") && /^pieza-\d+\./i.test(file.name);

const isOverview = (file: FileRef) =>
  file.mime.startsWith("image/") && /^todas\./i.test(file.name);

function sortPlates(files: FileRef[]): FileRef[] {
  return [...files].sort((a, b) => {
    const na = Number(a.name.match(/^pieza-(\d+)\./i)?.[1] ?? NaN);
    const nb = Number(b.name.match(/^pieza-(\d+)\./i)?.[1] ?? NaN);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return a.name.localeCompare(b.name);
  });
}

function buildDeliverableGroup(
  batch: { id: string; files: FileRef[] },
  workTitle: string,
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
      kind: "plates",
      title: workTitle,
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
      kind: "images",
      title: workTitle,
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
    kind: singleImage ? "images" : "file",
    title: primary.name,
    meta: timeText || "",
    plates: primary.mime.startsWith("image/") ? [primary] : [],
    primary,
    allFiles: sortedTarget,
  };
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
    .map((m) => ({ id: m.id, files: m.results! }));

  if (!batches.length) return { olderGroups: [] };

  const requestedIndex = messageId
    ? batches.findIndex((b) => b.id === messageId)
    : -1;
  const chosenIndex = requestedIndex >= 0 ? requestedIndex : batches.length - 1;
  const target = batches[chosenIndex];
  const olderGroups = batches
    .filter((_, idx) => idx !== chosenIndex)
    .reverse()
    .map((batch) => buildDeliverableGroup(batch, work.title));

  return {
    featured: buildDeliverableGroup(target, work.title),
    olderGroups,
  };
}

/**
 * Groups the work's results so the chosen batch (latest by default, or the
 * requested message's batch) becomes the hero in the right panel, and files from
 * other messages stay in the `older` list without overlapping the `allFiles`
 * menu.
 */
export function groupDeliverables(
  work: Work | undefined,
  messageId?: string,
): GroupedDeliverables {
  const { featured, olderGroups } = groupDeliverableBatches(work, messageId);
  if (!featured) return { older: [] };
  const older = olderGroups
    .flatMap((g) => g.allFiles)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { featured, older };
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
    const grouped = groupDeliverables(work, message.id);
    const featured = grouped.featured;
    if (featured?.kind === "plates") {
      const count = featured.plates.length;
      return count === 1
        ? "Se cambió 1 placa"
        : `Se cambiaron ${count} placas`;
    }
    if (featured?.kind === "images") {
      const count = featured.plates.length;
      return count === 1
        ? "Se cambió 1 imagen"
        : `Se cambiaron ${count} imágenes`;
    }
    const count = message.results.length;
    return count === 1
      ? "Se cambió 1 archivo"
      : `Se cambiaron ${count} archivos`;
  }
  return "Hubo cambios en los archivos";
}


