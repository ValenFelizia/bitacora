/**
 * A work is titled by a cheap extra model request (`thread/sample`) that reuses
 * the work's own context and never shows up as a turn. Codex does not name
 * threads on its own: `thread/start` reports `name: null` and the app-server
 * only stores whatever `thread/name/set` sends.
 *
 * The request costs one model call over the conversation that just finished
 * (mostly cached input) plus a few output tokens; the exact numbers come back
 * with the sample and are kept in the work's folded detail. When it fails, the
 * work keeps the beginning of the first request as its name.
 */
export const TITLE_PROMPT =
  "Escribí un título corto para este trabajo: el nombre con el que la usuaria lo va a reconocer en su lista. " +
  "Entre 2 y 5 palabras, en castellano rioplatense, con el tema concreto (por ejemplo «Porto de Galinhas, febrero»). " +
  "Sin comillas, sin punto final y sin explicaciones. No uses herramientas: respondé solo con el título.";

/** Longest name the app accepts, both for the automatic one and for a rename. */
export const MAX_TITLE = 60;

/** Cuts a name to the limit without leaving half a word behind. */
function cutToLimit(title: string): string {
  if (title.length <= MAX_TITLE) return title;
  const cut = title.slice(0, MAX_TITLE);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut).trim();
}

/** Turns the model's answer into a name: first line, no quotes, no trailing dots. */
export function cleanTitle(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const strip = (value: string) =>
    value.replace(/^["'«»“”‘’*_\s]+|["'«»“”‘’*_\s]+$/g, "");
  let title = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  title = strip(title);
  title = title.replace(/^(t[ií]tulo|nombre)\s*:\s*/i, "");
  title = strip(title);
  title = title.replace(/[.;,]+$/, "");
  title = strip(title).replace(/\s+/g, " ");
  if (!title) return undefined;
  return cutToLimit(title) || undefined;
}

/**
 * Name a work carries until a better one arrives: the start of the first
 * request. It obeys the same limit as a rename, so saving the pre-filled name
 * unchanged is accepted.
 */
export function fallbackTitle(text: string): string {
  return cutToLimit(text.trim().replace(/\s+/g, " "));
}
