import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import type { ClientCommand, CodexChat, CodexImportMessage } from "../../server/src/contracts";
import { formatWorkDate } from "./format";

type Props = {
  online: boolean;
  workspace?: string;
  openRequest?: number;
  hideTrigger?: boolean;
  message?: CodexImportMessage;
  send: (command: ClientCommand) => void;
};

const focus = "focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2";
const button = "rounded-[6px] border px-4 py-2 hover:bg-soft disabled:opacity-40 disabled:pointer-events-none " + focus;

export function CodexImportTrigger({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={"flex items-center gap-2 rounded-[6px] px-[10px] py-2 mb-3 text-[14px] text-left hover:bg-soft disabled:opacity-40 cursor-pointer disabled:cursor-default " + focus}
      onClick={onClick}
    >
      <Download size={18} strokeWidth={1.75} aria-hidden="true" />
      Traer chats de Codex
    </button>
  );
}

export function CodexImportOffer({ online, onOpen, onDismiss }: {
  online: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2.5 rounded-[6px] border border-line bg-surface px-4 py-2.5 text-[14px] text-ink"
    >
      <span>Tenés chats de Codex en esta carpeta.</span>
      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
        <button
          type="button"
          disabled={!online}
          onClick={onOpen}
          className={"inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-[6px] border border-ink bg-surface text-ink font-bold text-[14px] hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 " + focus}
        >
          <Download size={16} strokeWidth={1.75} aria-hidden="true" />
          Traer chats de Codex
        </button>
        <button
          type="button"
          disabled={!online}
          onClick={onDismiss}
          title="Cerrar"
          aria-label="Cerrar"
          className={"w-[36px] h-[36px] max-[959px]:w-[40px] max-[959px]:h-[40px] shrink-0 inline-grid place-items-center rounded-[6px] text-muted hover:text-ink hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 " + focus}
        >
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function CodexImport({ online, workspace, openRequest = 0, hideTrigger = false, message, send }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lastWorkspace = useRef(workspace);
  const [chats, setChats] = useState<CodexChat[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "importing">("ready");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (lastWorkspace.current === workspace) return;
    lastWorkspace.current = workspace;
    if (dialog.current?.open) dialog.current.close();
    setChats([]);
    setSelected([]);
    setPhase("ready");
    setStatus("");
    setError("");
  }, [workspace]);

  useEffect(() => {
    if (!openRequest) return;
    if (!dialog.current?.open) dialog.current?.showModal();
    load();
  }, [openRequest]);

  useEffect(() => {
    if (!dialog.current?.open || !message) return;
    setPhase("ready");
    if (message.type === "codexChats") {
      setChats(message.chats);
      setError("");
    } else if (message.type === "codexImported") {
      const imported = new Set(message.imported);
      setChats(previous => previous.map(chat => imported.has(chat.id) ? { ...chat, imported: true } : chat));
      setSelected(previous => previous.filter(id => !imported.has(id)));
      setStatus(imported.size ? "Ya podés abrir los chats desde Trabajos." : "");
      setError(message.failed.length ? "Quedaron chats sin traer. Podés volver a intentarlo." : "");
    } else {
      setError(message.text);
    }
  }, [message]);

  useEffect(() => {
    if (online || !dialog.current?.open) return;
    setPhase("ready");
    setError("Se cortó la conexión con Bitácora. Cuando vuelva, probá de nuevo.");
  }, [online]);

  function load() {
    setChats([]);
    setSelected([]);
    setStatus("");
    setError("");
    setPhase("loading");
    send({ type: "listCodexChats" });
  }

  return (
    <>
      {!hideTrigger && (
        <CodexImportTrigger
          disabled={!online}
          onClick={() => {
            dialog.current?.showModal();
            load();
          }}
        />
      )}
      <dialog
        ref={dialog}
        aria-labelledby="codex-import-heading"
        onCancel={event => { if (phase === "importing") event.preventDefault(); }}
        onClose={() => { if (!dialog.current?.open) send({ type: "cancelCodexChatList" }); }}
        className="m-auto w-[calc(100%-2rem)] max-w-[560px] max-h-[calc(100dvh-2rem)] rounded-[6px] border border-line bg-surface p-0 text-ink backdrop:bg-ink/40"
      >
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <header className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
            <h2 id="codex-import-heading" className="font-display text-[20px]">Traer chats de Codex</h2>
            <button
              type="button"
              autoFocus
              disabled={phase === "importing"}
              aria-label="Cerrar"
              onClick={() => dialog.current?.close()}
              className={"grid size-10 shrink-0 place-items-center rounded-[6px] hover:bg-soft disabled:opacity-40 " + focus}
            >
              <X size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </header>
          <div className="min-h-0 overflow-y-auto px-5" aria-busy={phase !== "ready"}>
            {chats.length > 0 && (
              <ul className="border-t border-line">
                {chats.map(chat => (
                  <li key={chat.id} className="border-b border-line">
                    <label className="flex items-start gap-3 py-3 text-[15px]">
                      <input
                        type="checkbox"
                        className={"mt-1 size-4 shrink-0 accent-ink " + focus}
                        checked={chat.imported || selected.includes(chat.id)}
                        disabled={chat.imported || phase !== "ready" || !online}
                        onChange={event => {
                          const checked = event.currentTarget.checked;
                          setSelected(previous => checked ? [...previous, chat.id] : previous.filter(id => id !== chat.id));
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block break-words font-bold">{chat.title}</span>
                        <span className="block break-words text-[13px] text-muted">
                          <time dateTime={chat.date}>{formatWorkDate(chat.date)}</time>
                          {!chat.sameFolder && " · " + chat.folder}
                          {chat.imported && " · ya está en Bitácora"}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div role="status" className="text-[15px] text-muted">
              {phase === "loading" ? <p className="pb-4">Buscando tus chats…</p>
                : phase === "importing" ? <p className="pt-3">Trayendo tus chats…</p>
                : status ? <p className="pt-3">{status}</p>
                : !chats.length && !error ? <p className="pb-4">No encontré chats de Codex en esta compu.</p> : null}
            </div>
            {error && <p role="alert" className="pt-3 text-[15px] text-danger">{error}</p>}
          </div>
          {(chats.length > 0 || error) && (
            <footer className="flex justify-end gap-2 px-5 py-4 text-[14px]">
              {error && phase === "ready" && <button type="button" disabled={!online} className={button + " border-line"} onClick={load}>Actualizar lista</button>}
              {chats.length > 0 && (
                <button
                  type="button"
                  disabled={!selected.length || phase !== "ready" || !online}
                  className={button + " border-ink font-bold"}
                  onClick={() => {
                    setPhase("importing");
                    setStatus("");
                    setError("");
                    send({ type: "importCodexChats", ids: selected });
                  }}
                >
                  Traer seleccionados
                </button>
              )}
            </footer>
          )}
        </div>
      </dialog>
    </>
  );
}
