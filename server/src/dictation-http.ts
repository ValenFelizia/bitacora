import type { IncomingMessage, ServerResponse } from "node:http";
import type { Engine } from "./engine";
import { DICTATION_FAILED, DICTATION_TOO_LARGE, DictationError, MAX_DICTATION_BYTES, type DictationClip } from "./dictation";

const formats = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mp4", "m4a"],
  ["audio/wav", "wav"],
  ["audio/mpeg", "mp3"],
]);

async function readClip(req: IncomingMessage): Promise<DictationClip> {
  const mime = req.headers["content-type"]?.split(";")[0].trim().toLowerCase() || "";
  const extension = formats.get(mime);
  if (!extension) throw new DictationError(415, "No pude usar la grabación. Probá de nuevo.");
  if (Number(req.headers["content-length"]) > MAX_DICTATION_BYTES) {
    throw new DictationError(413, DICTATION_TOO_LARGE);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the socket long enough to send a 413 even for chunked uploads.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_DICTATION_BYTES) throw new DictationError(413, DICTATION_TOO_LARGE);
    chunks.push(chunk);
  }
  if (!size) throw new DictationError(400, "No se grabó audio. Probá de nuevo.");
  return { bytes: Buffer.concat(chunks, size), mime, extension };
}

export async function handleDictation(req: IncomingMessage, res: ServerResponse, engine: Engine) {
  function reply(status: number, body: { text: string } | { error: string }) {
    if (res.destroyed) return;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!req.readableEnded) res.setHeader("Connection", "close");
    res.writeHead(status).end(JSON.stringify(body));
  }

  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.once("close", onClose);
  try {
    if (!engine.transcribe) throw new DictationError(503, DICTATION_FAILED);
    const clip = await readClip(req);
    abort.signal.throwIfAborted();
    const text = await engine.transcribe(clip, abort.signal);
    reply(200, { text });
  } catch (error) {
    // Upstream errors and bodies can include sensitive data.
    if (error instanceof DictationError) reply(error.status, { error: error.message });
    else reply(502, { error: DICTATION_FAILED });
  } finally {
    res.off("close", onClose);
  }
}
