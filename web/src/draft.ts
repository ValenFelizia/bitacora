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

/**
 * True when Enter in the request box sends it. Shift+Enter keeps the key for a
 * new paragraph, and a key that confirms a composition (accents, an input
 * method) belongs to the text; 229 is the code some browsers report then.
 */
export function sendsOnEnter(key: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }) {
  return key.key === "Enter" && !key.shiftKey && !key.isComposing && key.keyCode !== 229;
}

/** Drops files read for a draft the user already discarded. */
export function appendReadFiles(current: Upload[], added: Upload[], generation: number, currentGeneration: number) {
  return generation === currentGeneration ? [...current, ...added] : current;
}
