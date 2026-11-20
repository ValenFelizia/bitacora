import { useLayoutEffect, useRef, useState } from "react";
import {
  DICTATION_FAILED, DICTATION_PATH, DICTATION_TOO_LARGE, MAX_DICTATION_BYTES, MAX_DICTATION_MS,
} from "../../server/src/dictation";

type Status =
  | { kind: "idle" | "permission" | "recording" | "transcribing" }
  | { kind: "error" | "notice"; message: string };

type Session = {
  abort: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: number;
};

function releaseMicrophone(session: Session) {
  window.clearTimeout(session.timer);
  session.stream?.getTracks().forEach((track) => track.stop());
}

const CONNECTION_LOST = "Se cortó la conexión con Bitácora. Volvé a dictar cuando se reconecte.";
const WINDOWS_MICROPHONE = "Activá el micrófono para las aplicaciones de escritorio en la configuración de privacidad de Windows y volvé a probar.";

function microphoneError(error: unknown, desktop: boolean) {
  switch (error instanceof DOMException ? error.name : "") {
    case "NotAllowedError":
    case "SecurityError":
      return desktop ? WINDOWS_MICROPHONE : "Dale permiso al navegador para usar el micrófono y volvé a probar.";
    case "NotFoundError":
      return "No encontré un micrófono. Conectá uno y volvé a probar.";
    case "NotReadableError":
      return desktop
        ? "No pude usar el micrófono. Revisá la privacidad de Windows o si otra app lo está usando."
        : "No pude usar el micrófono. Fijate si otra app lo está usando.";
    default:
      return "No pude grabar. Revisá el micrófono y volvé a probar.";
  }
}

export function useDictation({ token, workId, online, desktop, onText, focusInput }: {
  token?: string;
  workId?: string;
  online: boolean;
  desktop: boolean;
  onText: (text: string) => string | undefined;
  focusInput: () => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const session = useRef<Session>(null);

  function clearSession() {
    const current = session.current;
    session.current = null;
    if (!current) return;
    current.abort.abort();
    if (current.recorder && current.recorder.state !== "inactive") current.recorder.stop();
    releaseMicrophone(current);
  }

  function cancel() {
    clearSession();
    setStatus({ kind: "idle" });
  }

  function fail(message: string) {
    clearSession();
    setStatus({ kind: "error", message });
    focusInput();
  }

  useLayoutEffect(() => clearSession, []);
  useLayoutEffect(cancel, [workId]);
  useLayoutEffect(() => {
    if (!session.current) return;
    if (!online) fail(CONNECTION_LOST);
    else cancel();
  }, [token, online]);

  function stop() {
    const current = session.current;
    if (current?.recorder?.state !== "recording") return;
    setStatus({ kind: "transcribing" });
    window.clearTimeout(current.timer);
    current.recorder.stop();
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
        releaseMicrophone(current);
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
        if (session.current === current) fail(microphoneError(undefined, desktop));
      });
      recorder.addEventListener("stop", async () => {
        if (session.current !== current) return;
        // The final dataavailable fires before stop. Keep the tracks live until then.
        releaseMicrophone(current);
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
            const notice = onText(result.text);
            clearSession();
            setStatus(notice ? { kind: "notice", message: notice } : { kind: "idle" });
          } else {
            const message = result && typeof result === "object" && "error" in result
              && typeof result.error === "string" ? result.error : DICTATION_FAILED;
            fail(message);
          }
        } catch (error) {
          if (session.current === current) {
            fail(error instanceof TypeError ? CONNECTION_LOST : DICTATION_FAILED);
          }
        }
      }, { once: true });
      recorder.start(250);
      setStatus({ kind: "recording" });
      current.timer = window.setTimeout(stop, MAX_DICTATION_MS);
    } catch (error) {
      if (session.current === current) fail(microphoneError(error, desktop));
    }
  }

  return { status, start, stop, cancel, active: () => session.current !== null };
}
