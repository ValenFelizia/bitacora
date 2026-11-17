import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import {
  AlertCircle,
  ArrowRight,
  ArrowUp,
  Info,
  LayoutGrid,
  LogIn,
  Mail,
  Menu,
  Package,
  Paperclip,
  Pencil,
  PenLine,
  Plus,
  RotateCcw,
  Shield,
  ShieldAlert,
  Square,
  WifiOff,
  X,
} from "lucide-react";
import type {
  ClientCommand,
  FileRef,
  ServerMessage,
  Snapshot,
  Upload,
  Work,
} from "../../server/src/contracts";
import { MAX_TITLE } from "../../server/src/titles";
import "./style.css";
import { DeliverablesPanel, FileCard, ImagePreviewModal } from "./files";
import { formatTime, formatWorkDate, undoSummary } from "./format";
import { protectionText, protectionWarning } from "./protection-text";
import {
  appendReadFiles,
  clearSentAttachments,
  clearSentText,
  isCurrentDraft,
  keepSelectedWork,
  type SentDraft,
} from "./draft";

// Matches the server limit for a request (server/src/app.ts).
const MAX_REQUEST_TEXT = 20000;

const SUGGESTED_ROUTES = [
  "Armame una propuesta con este link",
  "Armame una cotización rápida",
  "Revisá este PDF",
] as const;

const latestResult = (work: Work) =>
  work.messages
    .flatMap((m) => m.results || [])
    .reduce((latest, f) => (f.createdAt > latest ? f.createdAt : latest), "");

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";
const buttonBordered = `inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[6px] border border-ink bg-surface text-ink font-bold text-[14px] hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`;
const buttonQuiet = `inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[6px] border border-line bg-surface text-ink text-[14px] hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`;
const iconButton = `w-[36px] h-[36px] max-[959px]:w-[40px] max-[959px]:h-[40px] shrink-0 inline-grid place-items-center rounded-[6px] text-muted hover:text-ink hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`;

function DetailsToggle({
  text,
  prefix,
  trailing,
  className = "",
}: {
  text?: string;
  prefix?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2.5">
        {prefix && (
          <div className="flex items-center gap-2.5 min-w-0 flex-1">{prefix}</div>
        )}
        <div className="flex items-center gap-1.5 shrink-0">
          {text && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              title="Ver detalle"
              aria-label="Ver detalle"
              className={iconButton}
            >
              <Info size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {trailing}
        </div>
      </div>
      {open && text && (
        <pre className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] max-h-[220px] overflow-auto p-3 bg-soft border border-line rounded-[6px] text-[13px] text-ink">
          {text}
        </pre>
      )}
    </div>
  );
}

function App() {
  const [state, setState] = useState<Snapshot>({
    account: { connected: false },
    works: [],
    engine: { available: false, safety: { allowed: false, detail: "" } },
  });
  const [confirmUndo, setConfirmUndo] = useState<string>();
  const [gallery, setGallery] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [deliverablesOpen, setDeliverablesOpen] = useState(false);
  const [focusedMessageId, setFocusedMessageId] = useState<string>();
  const [preview, setPreview] = useState<{ file: FileRef; list: FileRef[] }>();
  const [attachments, setAttachments] = useState<Upload[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const sentDraft = useRef<SentDraft | undefined>(undefined);
  // Incremented when the draft is discarded, so unfinished reads are ignored.
  const draftGeneration = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const navCloseRef = useRef<HTMLButtonElement>(null);
  const deliverablesToggleRef = useRef<HTMLButtonElement>(null);
  const deliverablesCloseRef = useRef<HTMLButtonElement>(null);
  const reconnectRef = useRef<() => void>(() => {});
  const [selected, setSelected] = useState<string>();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  // The name sent but not yet confirmed by the server: the form stays open
  // until the work shows it, or until a problem says it was not saved.
  const [savingName, setSavingName] = useState<string>();
  const [text, setText] = useState("");
  const [online, setOnline] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{ text: string; detail?: string }>();
  const [login, setLogin] = useState<string>();
  const loginWindow = useRef<Window | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const work = state.works.find((w) => w.id === selected);
  const busy = state.works.some((w) => w.busy);
  const hasGalleryResults = state.works.some((w) =>
    w.messages.some((m) => m.results?.length),
  );
  const workResultCount =
    work?.messages.reduce((sum, m) => sum + (m.results?.length || 0), 0) || 0;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    function connect() {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => setOnline(true);
      ws.onmessage = (e) => {
        const message = JSON.parse(e.data) as ServerMessage;
        if (message.type === "snapshot") {
          setState(message.state);
          if (message.state.account.connected) setLogin(undefined);
        }
        if (message.type === "message") {
          setState((previous) => ({
            ...previous,
            works: previous.works.map((w) => {
              if (w.id !== message.workId) return w;
              const existing = w.messages.some((m) => m.id === message.id);
              return {
                ...w,
                messages: existing
                  ? w.messages.map((m) =>
                      m.id === message.id
                        ? {
                            ...m,
                            text: message.delta
                              ? m.text + message.text
                              : message.text,
                          }
                        : m,
                    )
                  : [
                      ...w.messages,
                      { id: message.id, role: "assistant", text: message.text },
                    ],
              };
            }),
          }));
        }
        if (message.type === "selected") {
          const sent = sentDraft.current;
          sentDraft.current = undefined;
          if (sent) {
            // A discarded draft must not reopen the work the user left.
            const keep = isCurrentDraft(sent, draftGeneration.current);
            setText((current) => (keep ? clearSentText(current, sent) : current));
            setAttachments((current) =>
              keep ? clearSentAttachments(current, sent) : current,
            );
            setSelected((current) =>
              keep ? keepSelectedWork(current, sent, message.workId) : current,
            );
          } else setSelected(message.workId);
          setPending(false);
        }
        if (message.type === "problem") {
          setProblem(message);
          setPending(false);
          // A rename that was refused keeps its form open with the message.
          setSavingName(undefined);
        }
        if (message.type === "login") {
          setLogin(message.url);
          if (loginWindow.current && !loginWindow.current.closed)
            loginWindow.current.location.replace(message.url);
        }
      };
      ws.onclose = () => {
        setOnline(false);
        setPending(false);
        // A rename in flight may never be answered: the form stays open with
        // the typed name so it can be saved again.
        setSavingName(undefined);
        if (!disposed) timer = setTimeout(connect, 1500);
      };
    }
    reconnectRef.current = () => {
      clearTimeout(timer);
      const prev = socket.current;
      if (prev && prev.readyState !== WebSocket.OPEN) {
        prev.onclose = null;
        try {
          prev.close();
        } catch {
          // Ignore close error
        }
      }
      if (!disposed && socket.current?.readyState !== WebSocket.OPEN) connect();
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket.current?.close();
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 960px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setNavOpen(false);
        setDeliverablesOpen(false);
        setFocusedMessageId(undefined);
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (navOpen) navCloseRef.current?.focus();
  }, [navOpen]);

  useEffect(() => {
    if (deliverablesOpen) deliverablesCloseRef.current?.focus();
  }, [deliverablesOpen]);

  useEffect(() => {
    if (!navOpen && !deliverablesOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (navOpen) {
        setNavOpen(false);
        navToggleRef.current?.focus();
      } else if (deliverablesOpen) {
        setDeliverablesOpen(false);
        setFocusedMessageId(undefined);
        deliverablesToggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navOpen, deliverablesOpen]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [selected, work?.messages.length, work?.messages.at(-1)?.text]);

  useEffect(() => {
    const resize = () => {
      const el = composerInput.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [text, gallery]);

  useEffect(() => {
    // The form closes only when the server's snapshot shows the saved name.
    // The input is locked while saving, so the submitted name is the one shown.
    if (savingName && work?.title === savingName) {
      setRenaming(false);
      setSavingName(undefined);
    }
  }, [savingName, work?.title]);

  function send(command: ClientCommand) {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    setProblem(undefined);
    socket.current.send(JSON.stringify(command));
  }

  function startConnect() {
    loginWindow.current = window.open("about:blank", "_blank");
    if (loginWindow.current) loginWindow.current.opener = null;
    send({ type: "connect" });
  }

  // One send path: the draft and the attachments always travel together.
  function submitRequest(opening?: string) {
    const typed = text.trim();
    if (
      (!typed && !attachments.length && !opening) ||
      readingFiles ||
      busy ||
      pending ||
      !online ||
      !state.engine.available ||
      !state.engine.safety.allowed ||
      !state.account.connected
    )
      return;
    const combined =
      [opening, typed].filter(Boolean).join("\n\n") ||
      "Revisá los archivos adjuntos.";
    // The server rejects longer requests; keep the draft so nothing is lost.
    if (combined.length > MAX_REQUEST_TEXT) {
      setProblem({
        text: "El texto es demasiado largo para mandarlo junto con este pedido. Acortalo un poco y volvé a intentar.",
      });
      return;
    }
    setPending(true);
    sentDraft.current = {
      workId: selected,
      text,
      attachments,
      generation: draftGeneration.current,
    };
    send({ type: "send", workId: selected, text: combined, attachments });
  }

  async function addFiles(files: File[]) {
    if (readingFiles || pending) return;
    const generation = draftGeneration.current;
    setReadingFiles(true);
    try {
      if (attachments.length + files.length > 10)
        throw new Error("Podés adjuntar hasta 10 archivos.");
      const total =
        attachments.reduce((n, f) => n + (f.data.length * 3) / 4, 0) +
        files.reduce((n, f) => n + f.size, 0);
      if (total > 40 * 1024 * 1024)
        throw new Error("Los adjuntos pueden pesar hasta 40 MB en total.");
      for (const f of files) {
        if (!/\.(png|jpe?g|webp|pdf|txt|md|csv|json)$/i.test(f.name))
          throw new Error(
            "Elegí una imagen, un PDF o texto (txt, md, csv o json).",
          );
        if (!f.size || f.size > 20 * 1024 * 1024)
          throw new Error(
            "Cada archivo debe tener contenido y pesar hasta 20 MB.",
          );
      }
      const added = await Promise.all(
        files.map(
          (f) =>
            new Promise<Upload>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({
                  name: f.name,
                  data: String(reader.result).split(",")[1],
                });
              reader.onerror = () =>
                reject(new Error("No pude leer el archivo. Elegilo de nuevo."));
              reader.readAsDataURL(f);
            }),
        ),
      );
      setAttachments((previous) =>
        appendReadFiles(previous, added, generation, draftGeneration.current),
      );
      if (generation === draftGeneration.current) setProblem(undefined);
    } catch (error) {
      setProblem({ text: String((error as Error).message) });
    } finally {
      setReadingFiles(false);
    }
  }

  useEffect(() => {
    const dragover = (event: DragEvent) => {
      event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer?.files.length) {
        setGallery(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }
    };
    window.addEventListener("dragover", dragover);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", dragover);
      window.removeEventListener("drop", drop);
    };
  });

  useEffect(() => {
    document.title = gallery ? "Galería · Bitácora" : "Bitácora";
    document.querySelector<HTMLElement>("main")?.focus();
  }, [gallery]);

  const lastUserIndex = work
    ? work.messages.reduce(
        (idx, m, i) => (m.role === "user" ? i : idx),
        -1,
      )
    : -1;

  const lastDeliverablesIndex = work
    ? work.messages.reduce(
        (idx, m, i) => (m.results?.length ? i : idx),
        -1,
      )
    : -1;

  const showEngineStoppedBanner = online && !state.engine.available;
  const showProblemBanner =
    !showEngineStoppedBanner && (!!problem || !!work?.problem);
  const hasErrorBanner =
    !gallery && (showEngineStoppedBanner || showProblemBanner);

  const isPausedProgress = work?.progress === "Trabajo pausado.";
  const isDoneProgress = work?.progress === "Listo.";

  const inProgressBlock = work?.busy && (
    <div
      className="grid grid-cols-[48px_20px_minmax(0,1fr)] gap-y-[7px] items-center text-[14px] text-muted"
      role="status"
    >
      <time className="text-[13px] tabular-nums text-accent-ink font-bold">
        ahora
      </time>
      <PenLine
        size={18}
        strokeWidth={1.75}
        className="text-accent-ink"
        aria-hidden="true"
      />
      <span className="text-accent-ink font-bold">
        {work.progress || "Preparando la respuesta…"}
      </span>
    </div>
  );

  const pausedProgressBlock = work &&
    !work.busy &&
    work.progress &&
    !isDoneProgress &&
    (isPausedProgress
      ? !(showEngineStoppedBanner || !!work.problem)
      : !hasErrorBanner) && (
      <div
        className="grid grid-cols-[48px_20px_minmax(0,1fr)] gap-y-[7px] items-center text-[14px] text-muted"
        role="status"
      >
        <time className="text-[13px] tabular-nums">
          {formatTime(work.updatedAt)}
        </time>
        <AlertCircle
          size={18}
          strokeWidth={1.75}
          className={isPausedProgress ? "text-muted" : "text-danger"}
          aria-hidden="true"
        />
        <span className={!isPausedProgress ? "text-danger" : undefined}>
          {work.progress}
        </span>
      </div>
    );

  const closingBlock = work && !work.busy && isDoneProgress && (
    <div
      className="w-full border-t border-line pt-2 flex items-center justify-between text-[13px] text-muted"
      role="status"
    >
      <time className="tabular-nums">{formatTime(work.updatedAt)}</time>
      <span>Listo.</span>
    </div>
  );

  const canSend =
    online &&
    state.engine.available &&
    state.engine.safety.allowed &&
    state.account.connected;

  const notConnected =
    online &&
    state.engine.available &&
    state.engine.safety.allowed &&
    !state.account.connected;

  const showCenterNotConnected = !gallery && !work && notConnected;

  const showSidebarNotConnected =
    online &&
    state.engine.available &&
    !state.account.connected &&
    !showCenterNotConnected;

  function closeNavDrawer(restoreFocus = false) {
    setNavOpen(false);
    if (restoreFocus) navToggleRef.current?.focus();
  }

  function closeDeliverablesDrawer(restoreFocus = false) {
    setDeliverablesOpen(false);
    setFocusedMessageId(undefined);
    if (restoreFocus) deliverablesToggleRef.current?.focus();
  }

  return (
    <div
      className={`grid h-dvh grid-cols-1 bg-paper text-ink overflow-hidden ${
        gallery
          ? "min-[960px]:grid-cols-[220px_minmax(0,1fr)]"
          : "min-[960px]:grid-cols-[220px_minmax(0,1fr)_300px]"
      }`}
    >
      {(navOpen || deliverablesOpen) && (
        <div
          className="fixed inset-0 z-30 bg-ink/40 min-[960px]:hidden"
          onClick={() => {
            if (navOpen) closeNavDrawer(true);
            if (deliverablesOpen) closeDeliverablesDrawer(true);
          }}
        />
      )}

      {/* Left sidebar: brand, new work, works list, account */}
      <aside
        className={`${
          navOpen
            ? "fixed inset-y-0 left-0 z-40 w-[240px] flex"
            : "hidden min-[960px]:flex"
        } flex-col gap-0.5 bg-paper border-r border-line pt-5 px-3 pb-[14px] min-h-0`}
      >
        <div className="flex items-center justify-between px-[10px] pb-4">
          <div className="font-display text-[25px] leading-none text-ink">
            Bitácora
            <em className="not-italic text-accent" aria-hidden="true">
              .
            </em>
          </div>
          <button
            ref={navCloseRef}
            type="button"
            onClick={() => closeNavDrawer(true)}
            className={`${iconButton} min-[960px]:hidden`}
            aria-label="Cerrar menú"
            title="Cerrar"
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <button
          type="button"
          className={`flex items-center gap-2 px-[10px] py-[9px] rounded-[6px] border border-line bg-surface font-bold text-[15px] text-ink hover:bg-soft cursor-pointer mb-1.5 transition-colors duration-150 ${focusRing}`}
          onClick={() => {
            setGallery(false);
            setRenaming(false);
            setNavOpen(false);
            setFocusedMessageId(undefined);
            draftGeneration.current++;
            setAttachments([]);
            setSelected(undefined);
            setText("");
            setProblem(undefined);
          }}
        >
          <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
          Nuevo trabajo
        </button>

        <button
          type="button"
          aria-pressed={gallery}
          className={`flex items-center gap-2 px-[10px] py-[8px] text-[14px] cursor-pointer mb-3 border-l-2 transition-colors duration-150 ${focusRing} ${
            gallery
              ? "bg-surface text-ink font-bold border-accent rounded-r-[6px] rounded-l-none"
              : "border-transparent rounded-[6px] text-muted hover:bg-soft hover:text-ink"
          }`}
          onClick={() => {
            setGallery(true);
            setRenaming(false);
            setNavOpen(false);
            setFocusedMessageId(undefined);
          }}
        >
          <LayoutGrid size={18} strokeWidth={1.75} aria-hidden="true" />
          Galería
        </button>

        <nav
          className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-[2px]"
          aria-label="Trabajos anteriores"
        >
          <h2 className="sr-only">Tus trabajos</h2>
          <ul className="flex flex-col gap-[2px]">
            {state.works.map((w) => {
              const active = !gallery && selected === w.id;
              return (
                <li key={w.id}>
                  <button
                    type="button"
                    className={`flex flex-col items-start gap-0.5 px-[10px] py-[9px] text-left w-full border-l-2 cursor-pointer transition-colors duration-150 ${focusRing} ${
                      active
                        ? "bg-surface text-ink font-bold border-accent rounded-r-[6px] rounded-l-none"
                        : "border-transparent rounded-[6px] text-muted hover:bg-soft hover:text-ink"
                    }`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => {
                      setGallery(false);
                      setRenaming(false);
                      setNavOpen(false);
                      setFocusedMessageId(undefined);
                      setSelected(w.id);
                      setProblem(undefined);
                    }}
                  >
                    <span className="w-full truncate text-[15px]">{w.title}</span>
                    <span className="flex items-center gap-1.5 text-[13px] font-normal tabular-nums text-muted">
                      {w.busy && (
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-accent shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      {formatWorkDate(w.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!state.works.length && (
            <p className="px-[10px] py-2 text-[13px] text-muted leading-relaxed">
              Acá van a aparecer tus trabajos.
            </p>
          )}
        </nav>

        {(!online || state.account.connected || showSidebarNotConnected) && (
          <section
            className="mt-auto border-t border-line pt-3 px-[10px] flex flex-col gap-2 text-[13px] text-muted"
            aria-label="Cuenta de ChatGPT"
          >
            {!online ? (
              <div className="flex items-center gap-2">
                <WifiOff size={18} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                <span>Reconectando…</span>
              </div>
            ) : state.account.connected ? (
              <div
                className="flex items-center gap-2 min-w-0"
                title={state.account.email || "Cuenta conectada"}
              >
                <Mail size={18} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {state.account.email || "Cuenta conectada"}
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p>Para trabajar, conectá tu cuenta de ChatGPT.</p>
                <button
                  type="button"
                  className={`${buttonBordered} self-start`}
                  onClick={startConnect}
                >
                  <LogIn size={18} strokeWidth={1.75} aria-hidden="true" />
                  Conectar cuenta
                </button>
              </div>
            )}

            {login && showSidebarNotConnected && (
              <p className="text-[13px]">
                <a
                  className={`text-ink font-bold underline decoration-accent decoration-2 underline-offset-4 ${focusRing}`}
                  href={login}
                  target="_blank"
                  rel="noreferrer"
                >
                  Continuar en el navegador
                </a>
                <span className="block mt-1">
                  Cuando termines, volvé a esta ventana.
                </span>
              </p>
            )}
          </section>
        )}
      </aside>

      {/* Center column: header, notices, conversation/gallery, composer */}
      <main tabIndex={-1} className="flex flex-col min-w-0 min-h-0 bg-paper outline-none">
        <header className="px-5 min-[960px]:px-7 py-[18px] border-b border-line flex items-center justify-between gap-4">
          {renaming && work ? (
            <form
              className="flex flex-1 min-w-0 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                // Same cleanup as the server, so the saved name can be recognised.
                const title = name.trim().replace(/\s+/g, " ");
                // While reconnecting nothing is sent: the form stays open so
                // the typed name is not lost.
                if (!title || title.length > MAX_TITLE || !online || savingName)
                  return;
                send({ type: "rename", workId: work.id, title });
                // Saving the name as it is keeps it from being replaced by the
                // automatic title. The snapshot cannot show that change, so the
                // form closes now: the server accepts any name of this length.
                if (title === work.title) setRenaming(false);
                else setSavingName(title);
              }}
            >
              <label className="sr-only" htmlFor="work-name">
                Nombre del trabajo
              </label>
              <input
                id="work-name"
                autoFocus
                value={name}
                readOnly={!!savingName}
                maxLength={MAX_TITLE}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRenaming(false);
                }}
                className={`min-w-0 flex-1 rounded-[6px] border border-line bg-surface px-3 py-2 text-[15px] text-ink ${focusRing}`}
              />
              <button
                className={buttonBordered}
                type="submit"
                disabled={
                  !name.trim() ||
                  name.trim().replace(/\s+/g, " ").length > MAX_TITLE ||
                  !online ||
                  !!savingName
                }
              >
                {savingName ? "Guardando…" : "Guardar"}
              </button>
              <button
                className={buttonQuiet}
                type="button"
                onClick={() => setRenaming(false)}
              >
                Cancelar
              </button>
            </form>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  ref={navToggleRef}
                  type="button"
                  aria-expanded={navOpen}
                  onClick={() => setNavOpen(true)}
                  className={`${iconButton} min-[960px]:hidden shrink-0`}
                  title="Trabajos"
                  aria-label="Abrir trabajos"
                >
                  <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <h1 className="m-0 font-display font-normal text-[25px] leading-tight text-ink truncate max-[720px]:text-[20px]">
                  {gallery ? "Galería" : work?.title || "Nuevo trabajo"}
                </h1>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {!online ? (
                  <button
                    type="button"
                    onClick={() => reconnectRef.current()}
                    className={`${iconButton} min-[960px]:hidden`}
                    title="Sin conexión. Reintentar conexión"
                    aria-label="Sin conexión. Reintentar conexión"
                  >
                    <WifiOff size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                ) : !state.engine.available && gallery ? (
                  <span
                    className="w-[36px] h-[36px] max-[959px]:w-[40px] max-[959px]:h-[40px] inline-grid place-items-center text-danger"
                    role="img"
                    title="Bitácora se detuvo"
                    aria-label="Bitácora se detuvo"
                  >
                    <AlertCircle size={18} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                ) : !state.account.connected && !showCenterNotConnected && state.engine.available ? (
                  <button
                    type="button"
                    onClick={startConnect}
                    className={`${iconButton} min-[960px]:hidden text-accent-ink`}
                    title="Conectar cuenta"
                    aria-label="Conectar cuenta"
                  >
                    <LogIn size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                ) : null}
                {!gallery && work && (
                  <button
                    type="button"
                    className={iconButton}
                    title="Cambiar el nombre"
                    aria-label="Cambiar el nombre"
                    onClick={() => {
                      setName(work.title);
                      setSavingName(undefined);
                      setRenaming(true);
                    }}
                  >
                    <Pencil size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
                {!gallery && (
                  <button
                    ref={deliverablesToggleRef}
                    type="button"
                    aria-expanded={deliverablesOpen}
                    onClick={() => {
                      setFocusedMessageId(undefined);
                      setDeliverablesOpen(true);
                    }}
                    className={`min-[960px]:hidden inline-flex items-center justify-center gap-1.5 px-2.5 min-w-[40px] h-[40px] rounded-[6px] border border-line bg-surface text-ink text-[13px] font-bold hover:bg-soft cursor-pointer ${focusRing}`}
                    title="Entregables"
                    aria-label="Abrir entregables"
                  >
                    <Package size={18} strokeWidth={1.75} aria-hidden="true" />
                    {workResultCount > 0 && (
                      <span className="tabular-nums text-accent-ink">
                        {workResultCount}
                      </span>
                    )}
                  </button>
                )}
              </div>
            </>
          )}
        </header>

        {((state.undo && !busy) || state.notice) && (
          <section
            aria-label="Deshacer el último pedido"
            className="shrink-0 px-5 min-[960px]:px-7 py-2 border-b border-line bg-surface text-[13px] flex flex-col gap-2"
          >
            {state.undo && !busy && (
              <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <p className="flex flex-1 items-center gap-2 text-ink min-w-[140px] max-w-full">
                  <RotateCcw
                    size={16}
                    strokeWidth={1.75}
                    className="text-muted shrink-0"
                    aria-hidden="true"
                  />
                  <span
                    className="truncate"
                    title={`Último pedido con cambios: ${state.undo.title} · «${state.undo.request}»`}
                  >
                    {undoSummary(state.undo, state.works) ||
                      `${state.undo.title} · «${state.undo.request}»`}
                  </span>
                </p>
                {confirmUndo !== state.undo.id && (
                  <div className="flex flex-wrap items-center gap-2 max-w-full ml-auto">
                    {state.undo.retry && (
                      <button
                        type="button"
                        className={`inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-[6px] border border-line bg-surface text-ink text-[13px] hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`}
                        disabled={!online}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Voy a dejar la carpeta como está ahora y descartar el Deshacer pendiente. Después podés seguir trabajando.",
                            )
                          )
                            send({ type: "discardUndo", id: state.undo!.id });
                        }}
                      >
                        Dejar la carpeta como está
                      </button>
                    )}
                    <button
                      type="button"
                      className={`inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-[6px] border border-line bg-surface text-ink text-[13px] hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`}
                      disabled={!online}
                      onClick={() => setConfirmUndo(state.undo!.id)}
                    >
                      {state.undo.retry ? "Reintentar deshacer" : "Deshacer"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {state.undo && !busy && confirmUndo === state.undo.id && (
              <div
                role="group"
                aria-label="Confirmar Deshacer"
                className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-line"
              >
                <p className="text-muted">
                  Voy a deshacer los cambios de este pedido, aunque estés en otro
                  trabajo. Lo que agregaste o cambiaste a mano después no se toca.
                </p>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    className={buttonBordered}
                    disabled={!online}
                    onClick={() => {
                      send({ type: "undo", id: state.undo!.id });
                      setConfirmUndo(undefined);
                    }}
                  >
                    Sí, deshacer
                  </button>
                  <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() => setConfirmUndo(undefined)}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {state.notice && (
              <p role="status" className="text-ink">
                {state.notice}
              </p>
            )}
          </section>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-5 min-[960px]:px-7 py-6">
            <div
              className={`mx-auto w-full flex flex-col gap-[18px] ${
                gallery ? "max-w-[880px]" : "max-w-[720px]"
              }`}
            >
              {gallery && (
                <section aria-label="Resultados por trabajo" className="flex flex-col gap-6">
                  <h2 className="font-display text-[25px] font-normal text-ink">
                    Todo lo que creamos
                  </h2>
                  {!hasGalleryResults && (
                    <div className="rounded-[6px] border border-line bg-surface p-6 flex flex-col items-start gap-3">
                      <p className="text-[15px] text-muted">
                        Cuando preparemos imágenes o PDFs, los vas a encontrar acá.
                      </p>
                      <button
                        type="button"
                        className={buttonBordered}
                        onClick={() => setGallery(false)}
                      >
                        Volver al trabajo
                      </button>
                    </div>
                  )}
                  {[...state.works]
                    .sort((a, b) => latestResult(b).localeCompare(latestResult(a)))
                    .map((w) => {
                      const results = w.messages
                        .flatMap((m) => m.results || [])
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                      return results.length ? (
                        <section key={w.id} className="flex flex-col gap-3">
                          <div className="flex items-center justify-between gap-3 border-b border-line pb-2">
                            <h3 className="font-display text-[20px] font-normal text-ink truncate">
                              {w.title}
                            </h3>
                            <button
                              type="button"
                              className={buttonQuiet}
                              onClick={() => {
                                setSelected(w.id);
                                setGallery(false);
                                setRenaming(false);
                              }}
                            >
                              Ir al trabajo
                            </button>
                          </div>
                          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {results.map((f) => (
                              <FileCard
                                key={`${f.id}-${state.fileRevision}`}
                                file={f}
                                token={state.fileToken}
                                fileRevision={state.fileRevision}
                                result
                                onPreview={(file) =>
                                  setPreview({
                                    file,
                                    list: results.filter((x) =>
                                      x.mime.startsWith("image/"),
                                    ),
                                  })
                                }
                              />
                            ))}
                          </div>
                        </section>
                      ) : null;
                    })}
                </section>
              )}

              {/* Offline state */}
              {!gallery && !online && !work && (
                <section className="my-12 max-w-[420px] w-full flex flex-col items-start gap-3">
                  <h2 className="font-display text-[25px] font-normal leading-tight text-ink flex items-center gap-2.5">
                    <WifiOff size={20} strokeWidth={1.75} className="text-muted shrink-0" aria-hidden="true" />
                    <span>Sin conexión</span>
                  </h2>
                  <p className="text-[15px] text-muted">
                    Se perdió la conexión con Bitácora. Estoy intentando reconectar.
                  </p>
                  <button
                    type="button"
                    className={buttonBordered}
                    onClick={() => reconnectRef.current()}
                  >
                    Reintentar
                  </button>
                </section>
              )}

              {/* Not connected empty state */}
              {showCenterNotConnected && (
                <section className="my-12 max-w-[460px] w-full flex flex-col items-start gap-3">
                  <h2 className="font-display text-[25px] font-normal leading-tight text-ink flex items-center gap-2.5">
                    <LogIn size={20} strokeWidth={1.75} className="text-muted shrink-0" aria-hidden="true" />
                    <span>Conectá tu cuenta</span>
                  </h2>
                  <p className="text-[15px] leading-relaxed text-muted">
                    Para trabajar, conectá tu cuenta de ChatGPT.
                  </p>
                  <button
                    type="button"
                    className={buttonBordered}
                    onClick={startConnect}
                  >
                    <LogIn size={18} strokeWidth={1.75} aria-hidden="true" />
                    Conectar cuenta
                  </button>
                  {login && (
                    <p className="text-[13px] text-muted">
                      <a
                        className={`text-ink font-bold underline decoration-accent decoration-2 underline-offset-4 ${focusRing}`}
                        href={login}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Continuar en el navegador
                      </a>{" "}
                      Cuando termines, volvé a esta ventana.
                    </p>
                  )}
                </section>
              )}

              {/* Ready empty state */}
              {!gallery && !work && canSend && (
                <section className="my-12 max-w-[460px] w-full flex flex-col items-start gap-4">
                  <div className="flex flex-col gap-1.5">
                    <h2 className="font-display text-[25px] font-normal leading-tight text-ink">
                      ¿En qué trabajamos hoy?
                    </h2>
                    <p className="text-[15px] text-muted">
                      Contame qué necesitás para tu agencia o pegá un link para
                      empezar.
                    </p>
                  </div>
                  {state.works.length === 0 && state.hasBrand === false && (
                    <button
                      type="button"
                      className={buttonBordered}
                      disabled={!canSend || pending || readingFiles || busy}
                      onClick={() =>
                        submitRequest(
                          "Ayudame a armar mi marca y mis plantillas para empezar.",
                        )
                      }
                    >
                      <PenLine size={18} strokeWidth={1.75} aria-hidden="true" />
                      Armar mi agencia
                    </button>
                  )}
                  <div className="w-full flex flex-col gap-1">
                    <h3 className="text-[13px] text-muted">Rumbos sugeridos</h3>
                    <div className="w-full divide-y divide-line border-t border-b border-line">
                      {SUGGESTED_ROUTES.map((route) => (
                        <button
                          key={route}
                          type="button"
                          onClick={() => {
                            setText((current) =>
                              current.trim() ? current : route,
                            );
                            composerInput.current?.focus();
                          }}
                          className={`w-full py-2.5 flex items-center justify-between gap-3 text-left text-[15px] text-ink hover:text-accent-ink cursor-pointer transition-colors duration-150 ${focusRing}`}
                        >
                          <span>{route}</span>
                          <ArrowRight
                            size={16}
                            strokeWidth={1.75}
                            className="text-muted shrink-0"
                            aria-hidden="true"
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              {/* Conversation messages + timed progress log */}
              {!gallery &&
                work?.messages.map((m, i) => (
                  <React.Fragment key={m.id}>
                    <article
                      className={
                        m.role === "user"
                          ? "self-end max-w-[76%] bg-surface border border-line rounded-[6px] px-3.5 py-2.5 text-[15px] leading-[1.55] flex flex-col gap-2"
                          : "max-w-[88%] flex items-start gap-2.5 text-[15px] leading-[1.6] text-ink"
                      }
                    >
                      <h2 className="sr-only">
                        {m.role === "user" ? "Vos" : "Bitácora"}
                      </h2>
                      {m.role === "assistant" && (
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-accent shrink-0 mt-[10px]"
                          aria-hidden="true"
                        />
                      )}
                      <div className={m.role === "assistant" ? "min-w-0 flex-1 flex flex-col gap-2" : "flex flex-col gap-2"}>
                        {m.role === "user" ? (
                          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                            {m.text.split(/(https?:\/\/[^\s]+)/g).map((part, idx) =>
                              /^https?:\/\//.test(part) ? (
                                <a
                                  key={idx}
                                  className="underline decoration-accent decoration-2 underline-offset-4 text-ink"
                                  href={part}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {part}
                                </a>
                              ) : (
                                part
                              ),
                            )}
                          </div>
                        ) : (
                          <div className="markdown [overflow-wrap:anywhere]">
                            <ReactMarkdown
                              skipHtml
                              components={{
                                a: ({ node: _, ...props }) =>
                                  /^https?:\/\//i.test(props.href || "") ? (
                                    <a
                                      {...props}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    />
                                  ) : (
                                    <span>{props.children}</span>
                                  ),
                              }}
                            >
                              {m.text}
                            </ReactMarkdown>
                          </div>
                        )}
                        {!!m.attachments?.length && (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {m.attachments.map((f) => (
                              <FileCard
                                key={`${f.id}-${state.fileRevision}`}
                                file={f}
                                token={state.fileToken}
                                fileRevision={state.fileRevision}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </article>
                    {i === lastDeliverablesIndex && !!m.results?.length && (
                      <button
                        type="button"
                        onClick={() => {
                          setFocusedMessageId(m.id);
                          setDeliverablesOpen(true);
                        }}
                        className={`min-[960px]:hidden inline-flex items-center gap-1.5 text-[13px] font-bold text-ink underline decoration-accent decoration-2 underline-offset-4 cursor-pointer ${focusRing} ${
                          m.role === "user" ? "self-end -mt-2" : "self-start pl-4 -mt-2"
                        }`}
                      >
                        <Package size={18} strokeWidth={1.75} className="text-accent" aria-hidden="true" />
                        Ver {m.results.length}{" "}
                        {m.results.length === 1 ? "entregable" : "entregables"}
                      </button>
                    )}
                    {i === lastUserIndex && (inProgressBlock || pausedProgressBlock)}
                  </React.Fragment>
                ))}

              {!gallery && work && lastUserIndex === -1 && (inProgressBlock || pausedProgressBlock)}

              {/* Details toggle inside conversation log when not shown in an active error banner */}
              {!gallery && !showProblemBanner && work?.details && (
                <DetailsToggle text={work.details} className="pl-4 -mt-2" />
              )}

              {!gallery && closingBlock}

              <div ref={bottom} />
            </div>
          </div>

        {/* Status & error banners pinned above composer */}
        {!gallery &&
          ((!online && !!work) ||
            showEngineStoppedBanner ||
            (online && state.engine.available && !state.engine.safety.allowed) ||
            (online &&
              state.engine.available &&
              state.engine.safety.allowed &&
              !!protectionWarning(state.engine.safety)) ||
            showProblemBanner) && (
            <div className="shrink-0 max-h-[40dvh] overflow-y-auto px-5 min-[960px]:px-7 pt-2 pb-3">
              <div className="mx-auto w-full max-w-[720px] flex flex-col gap-2.5">
                {!online && work && (
                  <section
                    role="status"
                    className="rounded-[6px] border border-line bg-surface px-4 py-3 text-[14px] text-ink flex flex-wrap items-center justify-between gap-2.5"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <WifiOff
                        size={18}
                        strokeWidth={1.75}
                        className="text-muted shrink-0"
                        aria-hidden="true"
                      />
                      <span>
                        Se perdió la conexión con Bitácora. Estoy intentando reconectar.
                      </span>
                    </div>
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => reconnectRef.current()}
                    >
                      Reintentar
                    </button>
                  </section>
                )}

                {/* Engine stopped / error state */}
                {showEngineStoppedBanner && (
                  <section className="rounded-[6px] border border-danger bg-surface px-4 py-3">
                    <DetailsToggle
                      text={state.engine.safety.detail}
                      prefix={
                        <>
                          <AlertCircle
                            size={18}
                            strokeWidth={1.75}
                            className="text-danger shrink-0"
                            aria-hidden="true"
                          />
                          <p role="status" className="text-[14px] text-ink">
                            {state.engine.exhausted
                              ? "Bitácora se detuvo y no pudo volver a iniciarse."
                              : "Bitácora se detuvo. Estoy intentando volver a iniciarla."}
                          </p>
                        </>
                      }
                      trailing={
                        state.engine.exhausted && (
                          <button
                            type="button"
                            className={buttonBordered}
                            onClick={() => send({ type: "retry" })}
                          >
                            Reintentar
                          </button>
                        )
                      }
                    />
                  </section>
                )}

                {/* Protection setup / failed state */}
                {online &&
                  state.engine.available &&
                  !state.engine.safety.allowed && (
                    state.engine.safety.status !== "failed" &&
                    !state.engine.safety.needsPermission ? (
                      <div
                        role="status"
                        className="rounded-[6px] border border-line bg-surface px-4 py-3 flex items-center gap-3 text-[14px] text-ink"
                      >
                        <Shield
                          size={18}
                          strokeWidth={1.75}
                          className="text-muted shrink-0"
                          aria-hidden="true"
                        />
                        <span>Preparando la protección de tu carpeta…</span>
                      </div>
                    ) : (
                      <section
                        aria-labelledby="protection-title"
                        className="rounded-[6px] border border-line bg-surface p-4 flex flex-col items-start gap-2.5"
                      >
                        <div className="flex items-center gap-2.5">
                          <ShieldAlert
                            size={18}
                            strokeWidth={1.75}
                            className="text-accent-ink shrink-0"
                            aria-hidden="true"
                          />
                          <h2
                            id="protection-title"
                            className="font-display text-[18px] font-normal text-ink"
                          >
                            {state.engine.safety.status === "failed"
                              ? "No pude dejar todo listo"
                              : "Antes de empezar"}
                          </h2>
                        </div>
                        {state.engine.safety.needsPermission && (
                          <p className="text-[14px] text-muted">
                            Para trabajar en tu carpeta sin cambiar tus otros
                            archivos, Bitácora necesita preparar la protección de tu
                            compu. Windows va a mostrar un cartel para permitir
                            cambios. Tocá «Sí» si querés continuar.
                          </p>
                        )}
                        <p role="status" className="text-[14px] text-ink">
                          {protectionText(state.engine.safety)}
                        </p>
                        <div className="flex items-center gap-2 w-full justify-between">
                          <button
                            type="button"
                            className={buttonBordered}
                            disabled={state.engine.safety.status === "preparing"}
                            onClick={() => send({ type: "prepareProtection" })}
                          >
                            {state.engine.safety.status === "preparing"
                              ? "Preparando…"
                              : state.engine.safety.status === "failed"
                                ? "Reintentar"
                                : "Preparar la protección"}
                          </button>
                        </div>
                        {state.engine.safety.detail && (
                          <DetailsToggle
                            text={state.engine.safety.detail}
                            className="w-full"
                          />
                        )}
                      </section>
                    )
                  )}

                {/* Elevated-mode read-block warning */}
                {online &&
                  state.engine.available &&
                  state.engine.safety.allowed &&
                  protectionWarning(state.engine.safety) && (
                    <p
                      role="status"
                      className="rounded-[6px] border border-line bg-surface px-4 py-3 text-[13px] text-muted flex items-start gap-2.5"
                    >
                      <ShieldAlert
                        size={18}
                        strokeWidth={1.75}
                        className="text-accent-ink shrink-0 mt-0.5"
                        aria-hidden="true"
                      />
                      <span>{protectionWarning(state.engine.safety)}</span>
                    </p>
                  )}

                {/* Error state on active work / request / attachments */}
                {showProblemBanner && (
                  <div
                    role="alert"
                    className="rounded-[6px] border border-danger bg-surface px-4 py-3 text-[14px] text-ink"
                  >
                    <DetailsToggle
                      text={
                        problem?.detail || work?.details
                          ? [problem?.detail, work?.details].filter(Boolean).join("\n")
                          : undefined
                      }
                      prefix={
                        <>
                          <AlertCircle
                            size={18}
                            strokeWidth={1.75}
                            className="text-danger shrink-0"
                            aria-hidden="true"
                          />
                          <span className="flex-1">{problem?.text || work?.problem}</span>
                        </>
                      }
                      trailing={
                        state.engine.exhausted && (
                          <button
                            type="button"
                            className={buttonQuiet}
                            onClick={() => send({ type: "retry" })}
                          >
                            Reintentar
                          </button>
                        )
                      }
                    />
                  </div>
                )}
              </div>
            </div>
          )}

        {/* Composer */}
        {!gallery && (
          <div className="shrink-0 px-5 min-[960px]:px-7 pb-5">
            <form
              className="mx-auto w-full max-w-[720px] bg-surface border border-line focus-within:border-ink has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-accent has-[textarea:focus-visible]:outline-offset-2 rounded-[6px] px-3 py-2.5 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submitRequest();
              }}
            >
              <input
                ref={fileInput}
                id="attachments"
                aria-label="Elegir archivos"
                type="file"
                multiple
                accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.json"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => {
                  void addFiles(Array.from(e.target.files || []));
                  e.target.value = "";
                }}
              />

              {(attachments.length > 0 || readingFiles) && (
                <div className="flex flex-wrap items-center gap-2 pb-1 border-b border-line">
                  {attachments.map((f, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-[6px] border border-line bg-paper pl-2.5 pr-1 py-0.5 text-[13px] text-ink max-w-full"
                    >
                      <span className="truncate max-w-[200px]">{f.name}</span>
                      <button
                        type="button"
                        className={`w-[36px] h-[36px] max-[959px]:w-[40px] max-[959px]:h-[40px] shrink-0 -my-1 inline-grid place-items-center rounded-[6px] text-muted hover:text-ink hover:bg-soft cursor-pointer transition-colors duration-150 ${focusRing}`}
                        aria-label={`Quitar ${f.name}`}
                        title={`Quitar ${f.name}`}
                        onClick={() =>
                          setAttachments((a) => a.filter((_, n) => n !== i))
                        }
                      >
                        <X size={16} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                  {readingFiles && (
                    <span role="status" className="text-[13px] text-muted">
                      Leyendo archivos…
                    </span>
                  )}
                </div>
              )}

              <div className="flex items-end gap-2.5">
                <button
                  type="button"
                  className={iconButton}
                  disabled={pending || readingFiles || notConnected}
                  title="Adjuntar archivos"
                  aria-label="Adjuntar archivos"
                  onClick={() => fileInput.current?.click()}
                >
                  <Paperclip size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>

                <label className="sr-only" htmlFor="request">
                  Tu pedido
                </label>
                <textarea
                  ref={composerInput}
                  id="request"
                  rows={1}
                  disabled={notConnected}
                  value={text}
                  maxLength={MAX_REQUEST_TEXT}
                  placeholder={
                    notConnected
                      ? "Conectá tu cuenta para escribir un pedido…"
                      : "Escribí qué necesitás…"
                  }
                  onChange={(e) => setText(e.target.value)}
                  className="flex-1 min-w-0 resize-none min-h-[44px] max-h-48 border-0 bg-transparent py-2.5 text-[15px] leading-[1.45] text-ink placeholder:text-muted focus:outline-none disabled:cursor-default disabled:opacity-70"
                />

                {busy ? (
                  <button
                    key="pause"
                    type="button"
                    className={buttonQuiet}
                    title="Pausar pedido"
                    aria-label="Pausar pedido"
                    onClick={() => {
                      const active = state.works.find((w) => w.busy);
                      if (active) send({ type: "interrupt", workId: active.id });
                    }}
                  >
                    <Square size={18} strokeWidth={1.75} aria-hidden="true" />
                    Pausar
                  </button>
                ) : (
                  <button
                    key="send"
                    type="submit"
                    disabled={
                      !canSend ||
                      pending ||
                      readingFiles ||
                      (!text.trim() && !attachments.length)
                    }
                    title="Enviar pedido"
                    aria-label="Enviar pedido"
                    className={`w-[36px] h-[36px] max-[959px]:w-[40px] max-[959px]:h-[40px] shrink-0 rounded-[6px] bg-ink text-surface grid place-items-center cursor-pointer enabled:hover:opacity-90 disabled:bg-ink/40 disabled:cursor-default transition-colors duration-150 ${focusRing}`}
                  >
                    <ArrowUp size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
              </div>
            </form>
          </div>
        )}
      </main>

      {/* Right sidebar: Deliverables */}
      {!gallery && (
        <aside
          className={`${
            deliverablesOpen
              ? "fixed inset-y-0 right-0 z-40 w-[min(320px,90vw)] flex"
              : "hidden min-[960px]:flex"
          } flex-col border-l border-line bg-surface px-3 py-5 min-h-0`}
        >
          <DeliverablesPanel
            work={work}
            focusedMessageId={focusedMessageId}
            token={state.fileToken}
            fileRevision={state.fileRevision}
            hasGalleryResults={hasGalleryResults}
            onOpenGallery={() => {
              setGallery(true);
              setDeliverablesOpen(false);
              setFocusedMessageId(undefined);
            }}
            onPreview={(file, list) => setPreview({ file, list })}
            onCloseMobile={() => closeDeliverablesDrawer(true)}
            closeMobileRef={deliverablesCloseRef}
          />
        </aside>
      )}

      {preview && (
        <ImagePreviewModal
          file={preview.file}
          list={preview.list}
          token={state.fileToken}
          fileRevision={state.fileRevision}
          onSelect={(file) => setPreview((prev) => (prev ? { ...prev, file } : prev))}
          onClose={() => setPreview(undefined)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
