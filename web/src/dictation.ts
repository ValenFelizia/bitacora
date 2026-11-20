import { useLayoutEffect, useRef, useState } from "react";
import {
  DICTATION_FAILED, DICTATION_PATH, DICTATION_TOO_LARGE, MAX_DICTATION_BYTES, MAX_DICTATION_MS,
} from "../../server/src/dictation";

type Status =
  | { kind: "idle" | "permission" | "recording" | "transcribing" }
  | { kind: "error"; message: string };

type Session = {
  abort: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: number;
};

function release(session: Session) {
  window.clearTimeout(session.timer);
  if (session.recorder && session.recorder.state !== "inactive") session.recorder.stop();
  session.stream?.getTracks().forEach((track) => track.stop());
}

function microphoneError(error: unknown) {
  switch (error instanceof DOMException ? error.name : "") {
    case "NotAllowedError":
    case "SecurityError":
      return "Dale permiso a Bitácora para usar el micrófono y volvé a probar.";
    case "NotFoundError":
      return "No encontré un micrófono. Conectá uno y volvé a probar.";
    case "NotReadableError":
      return "No pude usar el micrófono. Fijate si otra app lo está usando.";
    default:
      return "No pude grabar. Revisá el micrófono y volvé a probar.";
  }
}

export function useDictation({ token, workId, onText }: {
  token?: string;
  workId?: string;
  onText: (text: string) => boolean;
}) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const session = useRef<Session>(null);

  function clearSession() {
    const current = session.current;
    session.current = null;
    if (!current) return;
    current.abort.abort();
    release(current);
  }

  function cancel() {
    clearSession();
    setStatus({ kind: "idle" });
  }

  useLayoutEffect(() => {
    setStatus({ kind: "idle" });
    return clearSession;
  }, [token, workId]);

  function fail(message: string) {
    clearSession();
    setStatus({ kind: "error", message });
  }

  function stop() {
    const current = session.current;
    if (current?.recorder?.state !== "recording") return;
    setStatus({ kind: "transcribing" });
    release(current);
  }

  async function start() {
    if (session.current || !token) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      fail("No pude usar el micrófono en esta pantalla.");
      return;
    }
    const current: Session = { abort: new AbortController() };
    session.current = current;
    setStatus({ kind: "permission" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      current.stream = stream;
      if (session.current !== current) {
        release(current);
        return;
      }
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]
        .find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
      const recorder = new MediaRecorder(stream, { mimeType: preferred, audioBitsPerSecond: 64_000 });
      current.recorder = recorder;
      const chunks: Blob[] = [];
      let size = 0;
      recorder.addEventListener("dataavailable", ({ data }) => {
        if (session.current !== current || !data.size) return;
        size += data.size;
        if (size > MAX_DICTATION_BYTES) fail(DICTATION_TOO_LARGE);
        else chunks.push(data);
      });
      recorder.addEventListener("error", () => {
        if (session.current === current) fail(microphoneError(undefined));
      });
      recorder.addEventListener("stop", async () => {
        if (session.current !== current) return;
        release(current);
        setStatus({ kind: "transcribing" });
        if (!size) {
          fail("No se grabó audio. Probá de nuevo.");
          return;
        }
        try {
          const body = new Blob(chunks, { type: recorder.mimeType || chunks[0].type });
          const response = await fetch(DICTATION_PATH, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body,
            signal: current.abort.signal,
          });
          const result: unknown = await response.json();
          if (session.current !== current) return;
          if (response.ok && result && typeof result === "object" && "text" in result &&
              typeof result.text === "string" && result.text.trim()) {
            if (onText(result.text)) cancel();
            else fail("El pedido quedó demasiado largo. Acortalo y volvé a dictar.");
          } else {
            const message = result && typeof result === "object" && "error" in result
              && typeof result.error === "string" ? result.error : DICTATION_FAILED;
            fail(message);
          }
        } catch {
          if (session.current === current) fail(DICTATION_FAILED);
        }
      }, { once: true });
      recorder.start(250);
      setStatus({ kind: "recording" });
      current.timer = window.setTimeout(stop, MAX_DICTATION_MS);
    } catch (error) {
      if (session.current === current) fail(microphoneError(error));
    }
  }

  return { status, start, stop, cancel, active: () => session.current !== null };
}
