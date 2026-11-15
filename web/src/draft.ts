import type { Upload } from "../../server/src/contracts";

// What the user submitted, so a late reply only clears that draft.
export type SentDraft = { workId?: string; text: string; attachments: Upload[]; generation: number };

/** False when the draft was discarded ("Nuevo trabajo") before the reply came. */
export function isCurrentDraft(sent: SentDraft, currentGeneration: number) {
  return sent.generation === currentGeneration;
}

/** Clears the submitted text unless the user typed something else meanwhile. */
export function clearSentText(current: string, sent: SentDraft) {
  return current === sent.text ? "" : current;
}

/** Clears the submitted attachments unless the user changed them meanwhile. */
export function clearSentAttachments(current: Upload[], sent: SentDraft) {
  return current === sent.attachments ? [] : current;
}

/** Keeps the work the user opened while the reply was on its way. */
export function keepSelectedWork(current: string | undefined, sent: SentDraft, created: string) {
  return current === sent.workId ? created : current;
}

/** Drops files read for a draft the user already discarded. */
export function appendReadFiles(current: Upload[], added: Upload[], generation: number, currentGeneration: number) {
  return generation === currentGeneration ? [...current, ...added] : current;
}
