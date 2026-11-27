import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  Info,
  LayoutGrid,
  LogIn,
  Mail,
  Menu,
  Mic,
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
  CodexImportMessage,
  FileRef,
  ServerMessage,
  Snapshot,
  Upload,
  Work,
} from "../../server/src/contracts";
import { PANEL_WIDTH } from "../../server/src/contracts";
import { MAX_TITLE } from "../../server/src/titles";
import "./style.css";
import { DeliverablesPanel, FileCard, FilePreviewModal } from "./files";
import { ModelPicker } from "./model-picker";
import { useDictation } from "./dictation";
import { SCREEN_PROTOCOL } from "../../server/src/screen-session";
import { screenSecret } from "./screen-session";
import { clampPanel, DESKTOP_MIN, panelBounds, panelKey } from "./panel";
import { QuestionCard } from "./question";
import {
  formatTime,
  formatWorkDate,
  messageDeliverableCount,
  undoSummary,
} from "./format";
import { protectionText, protectionWarning } from "./protection-text";
import { Welcome, type WelcomeAnswer } from "./welcome";
import { CodexImport, CodexImportOffer, CodexImportTrigger } from "./codex-import";
import { WorkspaceControl } from "./workspace-control";
import { FolderPickerProblem, pickWorkspace } from "./workspace-picker";
import { suggestedRoutes } from "../../server/src/welcome";
import {
  appendReadFiles,
  clearSentAttachments,
  clearSentText,
  isCurrentDraft,
  keepSelectedWork,
  sendsOnEnter,
  type SentDraft,
} from "./draft";

// Matches the server limit for a request (server/src/app.ts).
const MAX_REQUEST_TEXT = 20000;

function isDesktop() {
  return (window as Window & { __BITACORA_DESKTOP__?: boolean }).__BITACORA_DESKTOP__ === true;
}

const latestResult = (work: Work) =>
  work.messages
    .flatMap((m) => m.results || [])
    .reduce((latest, f) => (f.createdAt > latest ? f.createdAt : latest), "");

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2";
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

/** Copies an answer as written (Markdown included) and says so for a moment. */
function CopyMessageButton({ text }: { text: string }) {
  const [status, setStatus] = useState<"" | "copied" | "failed">("");
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <div className="flex items-center gap-1.5 -ml-2.5 -mt-1">
      <button
        type="button"
        className={iconButton}
        title="Copiar mensaje"
        aria-label="Copiar mensaje"
        onClick={async () => {
          // `navigator.clipboard` is missing outside a secure page: that is a failure too.
          try {
            await navigator.clipboard.writeText(text);
            setStatus("copied");
          } catch {
            setStatus("failed");
          }
        }}
      >
        {status === "copied" ? (
          <Check size={18} strokeWidth={1.75} className="text-ink" aria-hidden="true" />
        ) : (
          <Copy size={18} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
      <span role="status" className="text-[13px] text-muted">
        {status === "copied" ? "Copiado" : status === "failed" ? "No pude copiar." : ""}
      </span>
    </div>
  );
}

type UpdateNotice = "idle" | "available" | "busy" | "failed" | "working";

const OFFLINE_READY = "Sin conexión. Probá de nuevo en un momento";
const BUSY_READY = "Esperá a que termine el pedido de este chat";

/** A control inside a closed drawer has no box, so focusing it lands on the page. */
function isOnScreen(element: HTMLElement | null): element is HTMLElement {
  return !!element && element.getClientRects().length > 0;
}

/**
 * One chat in the sidebar. The mark-as-ready action stays out of the way until
 * the pointer or the keyboard reaches the row, and «Listos» brings it back
 * (issue #88). A blocked action stays in the tab order and says why.
 */
function WorkRow({
  work,
  active,
  ready,
  online,
  sending,
  actionRef,
  onOpen,
  onToggleReady,
}: {
  work: Work;
  active: boolean;
  ready: boolean;
  online: boolean;
  sending: boolean;
  actionRef?: React.Ref<HTMLButtonElement>;
  onOpen: () => void;
  onToggleReady: () => void;
}) {
  const action = ready ? "Volver a la lista" : "Marcar como listo";
  const reason = !online ? OFFLINE_READY : !ready && (work.busy || sending) ? BUSY_READY : undefined;
  const blocked = reason !== undefined;
  const reasonId = `ready-reason-${work.id}`;
  return (
    <li className="border-b border-line py-[3px]">
      <div
        className={`group flex items-stretch border-l-2 transition-colors duration-150 ${
          active
            ? "bg-surface border-accent rounded-r-[6px] rounded-l-none"
            : "border-transparent rounded-[6px] hover:bg-soft"
        }`}
      >
        <button
          type="button"
          className={`grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_16px] items-center gap-2 px-[10px] py-[7px] text-left text-ink cursor-pointer ${focusRing} ${
            active ? "font-bold" : ""
          }`}
          aria-current={active ? "page" : undefined}
          onClick={onOpen}
        >
          <span className="min-w-0 flex flex-col items-start gap-0.5">
            <span className="w-full truncate text-[15px]">{work.title}</span>
            <span className="flex items-center gap-1.5 text-[13px] font-normal tabular-nums text-muted">
              {work.busy && (
                <PenLine
                  size={13}
                  strokeWidth={1.75}
                  className="text-accent-ink shrink-0"
                  aria-hidden="true"
                />
              )}
              {formatWorkDate(work.updatedAt)}
            </span>
          </span>
          {!active && (
            <ChevronRight
              size={16}
              strokeWidth={1.75}
              className="text-muted transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0 max-[959px]:hidden"
              aria-hidden="true"
            />
          )}
        </button>
        <span className="relative grid w-[34px] shrink-0 place-items-center">
          <button
            ref={actionRef}
            type="button"
            title={reason ?? action}
            aria-label={`${action}: ${work.title}`}
            aria-disabled={blocked || undefined}
            aria-describedby={blocked ? reasonId : undefined}
            onClick={() => {
              if (!blocked) onToggleReady();
            }}
            className={`absolute inset-0 grid place-items-center rounded-[6px] text-muted cursor-pointer transition-opacity duration-150 aria-disabled:cursor-default ${
              blocked
                ? "opacity-0 group-hover:opacity-40 group-focus-within:opacity-40 max-[959px]:opacity-40"
                : "opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 max-[959px]:opacity-100"
            } ${focusRing}`}
          >
            {ready ? (
              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Check size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
          {blocked && (
            <span id={reasonId} className="sr-only">
              {reason}
            </span>
          )}
        </span>
      </div>
    </li>
  );
}

function App() {
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice>("idle");
  const updateInProgress = useRef(false);
  useEffect(() => {
    const webview = window.chrome?.webview;
    if (!isDesktop() || !webview) return;
    const receive = ({ data }: MessageEvent<unknown>) => {
      if (typeof data !== "string" || !data.startsWith("bitacora:update:")) return;
      const notice = data.slice("bitacora:update:".length);
      if (notice === "idle" || notice === "available" || notice === "busy" ||
          notice === "failed" || notice === "working") {
        updateInProgress.current = notice === "working";
        setUpdateNotice(notice);
      }
    };
    webview.addEventListener("message", receive);
    webview.postMessage("bitacora:update:status");
    return () => webview.removeEventListener("message", receive);
  }, []);
  const [state, setState] = useState<Snapshot>({
    account: { connected: false },
    works: [],
    engine: { available: false, safety: { allowed: false, detail: "" } },
  });
  const [confirmUndo, setConfirmUndo] = useState<string>();
  const [gallery, setGallery] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [readyOpen, setReadyOpen] = useState(false);
  const [readyNotice, setReadyNotice] = useState<{ seq: number; text: string }>();
  const readyNoticeSeq = useRef(0);
  const [placeFocus, setPlaceFocus] = useState<{ id: string; ready: boolean }>();
  const placedRef = useRef<HTMLButtonElement>(null);
  const listosToggleRef = useRef<HTMLButtonElement>(null);
  const [deliverablesOpen, setDeliverablesOpen] = useState(false);
  const [focusedMessageId, setFocusedMessageId] = useState<string>();
  const [preview, setPreview] = useState<{ file: FileRef; list: FileRef[]; trackOpened?: boolean }>();
  const markOpened = (files: FileRef[]) => {
    const fileIds = files.filter((f) => !f.openedAt).map((f) => f.id);
    if (fileIds.length) sendQuietly({ type: "markOpened", fileIds });
  };
  const [attachments, setAttachments] = useState<Upload[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const sentDraft = useRef<SentDraft | undefined>(undefined);
  // Incremented when the draft is discarded, so unfinished reads are ignored.
  const draftGeneration = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
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
  const [sessionSecret, setSessionSecret] = useState<string>();
  const [pending, setPending] = useState(false);
  // The chat the send left from. It stays blocked if another chat is opened
  // before the snapshot, instead of following the selection.
  const [pendingWorkId, setPendingWorkId] = useState<string>();
  // The question whose answer was sent and not yet confirmed by a snapshot. The
  // ref stops a second click before the state updates.
  const [answering, setAnswering] = useState<string>();
  const answeringRef = useRef<string | undefined>(undefined);
  const [problem, setProblem] = useState<{ text: string; detail?: string; workId?: string }>();
  // The welcome answer was sent and no reply arrived yet. Any message from the
  // server releases it, with or without an error.
  const [codexImportMessage, setCodexImportMessage] = useState<CodexImportMessage>();
  const [codexImportOpen, setCodexImportOpen] = useState(0);
  const [welcomeSending, setWelcomeSending] = useState(false);
  const [folderAction, setFolderAction] = useState<"picking" | "changing">();
  const [folderProblem, setFolderProblem] = useState<string>();
  useEffect(() => {
    if (folderAction !== "changing") return;
    const timer = window.setTimeout(() => {
      setFolderAction(undefined);
      setFolderProblem("El cambio está tardando. Revisá la carpeta que aparece antes de seguir.");
    }, 90_000);
    return () => window.clearTimeout(timer);
  }, [folderAction]);
  const displayedWorkspace = useRef<string | undefined>(undefined);
  const [login, setLogin] = useState<string>();
  const loginWindow = useRef<Window | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  // Kept as the user left it; what is shown is clamped to the window.
  const [panelWidth, setPanelWidth] = useState<number>(PANEL_WIDTH.default);
  const [resizingPanel, setResizingPanel] = useState(false);
  const panelDrag = useRef<{ startX: number; startWidth: number; width: number } | undefined>(undefined);
  const panelSave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shownPanel = clampPanel(panelWidth, viewport);
  const panelLimits = panelBounds(viewport);
  const work = state.works.find((w) => w.id === selected);
  // «Listos» keeps its own section at the end of the sidebar, in the same
  // activity order the server sends (issue #88).
  const readyWorks = state.works.filter((w) => w.ready);
  const activeWorks = state.works.filter((w) => !w.ready);
  // Entering a ready chat opens «Listos». After that the person can fold it;
  // the click is not ignored while that chat stays open (issue #88).
  const listosOpen = readyOpen;
  // Block the chat that was sent, not whichever one is open now.
  const sendingId = pending ? pendingWorkId : undefined;
  useLayoutEffect(() => {
    if (!gallery && work?.ready) setReadyOpen(true);
  }, [gallery, selected, work?.ready]);
  useEffect(() => {
    if (!readyNotice) return;
    const timer = window.setTimeout(() => setReadyNotice(undefined), 4000);
    return () => window.clearTimeout(timer);
  }, [readyNotice]);
  useLayoutEffect(() => {
    if (!placeFocus) return;
    const target = state.works.find((item) => item.id === placeFocus.id);
    if (!target || !!target.ready !== placeFocus.ready) return;
    // The row is inside «Listos». Open that section before focusing, and
    // announce only once the snapshot shows the chat there.
    if (placeFocus.ready && !readyOpen) {
      setReadyOpen(true);
      return;
    }
    if (placeFocus.ready) {
      readyNoticeSeq.current += 1;
      setReadyNotice({ seq: readyNoticeSeq.current, text: "Pasó a Listos" });
    }
    const destination = placedRef.current ?? listosToggleRef.current;
    if (isOnScreen(destination)) destination.focus();
    else if (isOnScreen(navToggleRef.current)) navToggleRef.current.focus();
    else mainRef.current?.focus();
    setPlaceFocus(undefined);
  }, [placeFocus, state.works, readyOpen]);
  const dictationToken =
    online && state.account.connected && state.engine.available && !gallery ? sessionSecret : undefined;
  const dictation = useDictation({
    token: dictationToken,
    workId: selected,
    online,
    desktop: isDesktop(),
    focusInput: () => composerInput.current?.focus(),
    onText(transcript) {
      const input = composerInput.current;
      if (!input) return "No pude sumar el dictado. Probá de nuevo.";
      const { selectionStart, selectionEnd, value } = input;
      const before = value.slice(0, selectionStart);
      const after = value.slice(selectionEnd);
      const room = Math.max(0, MAX_REQUEST_TEXT - before.length - after.length);
      const leadingSpace = room > 1 && before && !/\s$/.test(before) && !/^[,.;:!?)]/.test(transcript) ? " " : "";
      // Do not split a surrogate pair at the text box's UTF-16 limit.
      const clipped = transcript.slice(0, room - leadingSpace.length).replace(/[\uD800-\uDBFF]$/, "");
      input.focus();
      if (!clipped) return "No entra más texto en este pedido. Acortalo un poco para seguir dictando.";
      const trailingSpace = leadingSpace.length + clipped.length < room && after && !/^[\s,.;:!?)]/.test(after) ? " " : "";
      input.setRangeText(leadingSpace + clipped + trailingSpace, selectionStart, selectionEnd, "end");
      setText(input.value);
      if (clipped !== transcript) return "Sumé lo que entraba; el pedido llegó al largo máximo.";
    },
  });
  const busy = state.works.some((w) => w.busy);
  const updating = updateNotice === "working";
  const updateReady = state.engine.updateReady === true;
  const updateBlocked = busy || pending || readingFiles || dictation.active() ||
    !!folderAction || renaming || resizingPanel;
  const hasDraft = !!text.trim() || attachments.length > 0;
  const hasGalleryResults = state.works.some((w) =>
    w.messages.some((m) => m.results?.length),
  );
  const workResultCount =
    work?.messages.reduce((sum, m) => sum + (m.results?.length || 0), 0) || 0;
  // The welcome marked what the agency needs: those come first (issue #67).
  const routes = suggestedRoutes(state.uses);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    async function connect() {
      const current = ++attempt;
      const secret = await screenSecret();
      if (disposed || current !== attempt) return;
      if (!secret) {
        timer = setTimeout(connect, 1500);
        return;
      }
      const ws = new WebSocket(`ws://${location.host}/ws`, [SCREEN_PROTOCOL, secret]);
      socket.current = ws;
      ws.onopen = () => {
        setSessionSecret(secret);
        setOnline(true);
      };
      ws.onmessage = (e) => {
        const message = JSON.parse(e.data) as ServerMessage;
        // Any answer proves the server is there: the welcome button can be
        // pressed again even when the same error comes back.
        setWelcomeSending(false);
        if (message.type === "codexChats" || message.type === "codexImported" || message.type === "codexImportProblem")
          setCodexImportMessage(message);
        if (message.type === "snapshot") {
          if (displayedWorkspace.current && displayedWorkspace.current !== message.state.workspace) {
            draftGeneration.current++;
            sentDraft.current = undefined;
            dictation.cancel();
            setReadingFiles(false);
            setText("");
            setAttachments([]);
            setSelected(undefined);
            setRenaming(false);
            setSavingName(undefined);
            setPending(false);
            setPendingWorkId(undefined);
            answeringRef.current = undefined;
            setAnswering(undefined);
            setGallery(false);
            setPreview(undefined);
            setDeliverablesOpen(false);
            setFocusedMessageId(undefined);
            setProblem(undefined);
            setFolderProblem(undefined);
            setCodexImportMessage(undefined);
            setReadyOpen(false);
            setReadyNotice(undefined);
            setPlaceFocus(undefined);
          }
          displayedWorkspace.current = message.state.workspace;
          setState(message.state);
          if (message.state.account.connected) setLogin(undefined);
        }
        if (message.type === "workspaceChoice") {
          setFolderAction(undefined);
          setFolderProblem(message.problem);
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
          setPendingWorkId(undefined);
        }
        if (message.type === "problem") {
          setProblem(message);
          setReadyNotice(undefined);
          setPlaceFocus(undefined);
          setPending(false);
          setPendingWorkId(undefined);
          answeringRef.current = undefined;
          setAnswering(undefined);
          // A rename that was refused keeps its form open with the message.
          setSavingName(undefined);
        }
        if (message.type === "login") {
          setLogin(message.url);
          if (isDesktop())
            window.location.assign(message.url);
          else if (loginWindow.current && !loginWindow.current.closed)
            loginWindow.current.location.replace(message.url);
        }
      };
      ws.onclose = () => {
        setOnline(false);
        setSessionSecret(undefined);
        setFolderAction((action) => action === "changing" ? undefined : action);
        setPending(false);
        setPendingWorkId(undefined);
        setReadyNotice(undefined);
        setPlaceFocus(undefined);
        setWelcomeSending(false);
        // An answer in flight may never arrive: the card can send it again.
        answeringRef.current = undefined;
        setAnswering(undefined);
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
      if (!disposed && socket.current?.readyState !== WebSocket.OPEN) void connect();
    };
    const reopen = () => reconnectRef.current();
    window.addEventListener("bitacora-reopen", reopen);
    void connect();
    return () => {
      window.removeEventListener("bitacora-reopen", reopen);
      disposed = true;
      clearTimeout(timer);
      socket.current?.close();
    };
  }, []);

  useEffect(() => {
    if (state.panelWidth !== undefined && !panelDrag.current) setPanelWidth(state.panelWidth);
  }, [state.panelWidth]);

  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => () => clearTimeout(panelSave.current), []);

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_MIN}px)`);
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
      if (e.key !== "Escape" || document.querySelector("dialog:modal")) return;
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
  }, [selected, work?.messages.length, work?.messages.at(-1)?.text, work?.question?.id, work?.question?.closed]);

  useEffect(() => {
    const sent = answeringRef.current;
    if (!sent || (work?.question?.id === sent && !work.question.closed)) return;
    // The answer was taken. With no other question in line the card is gone,
    // so the focus goes to the text box instead of falling to the page; a
    // next question or a closed card takes it themselves.
    answeringRef.current = undefined;
    setAnswering(undefined);
    if (!work?.question) composerInput.current?.focus();
  }, [work?.question?.id, work?.question?.closed]);

  function respond(questionId: string, command: ClientCommand) {
    if (answeringRef.current === questionId) return;
    answeringRef.current = questionId;
    setAnswering(questionId);
    send(command);
  }

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
    if (updateInProgress.current || socket.current?.readyState !== WebSocket.OPEN) return;
    setProblem(undefined);
    socket.current.send(JSON.stringify({ ...command, workspace: state.workspace }));
  }

  function placeReady(workId: string, ready: boolean) {
    // The notice and the open section wait until a snapshot shows this chat
    // as ready. A rejection must not announce a move that did not happen.
    setPlaceFocus({ id: workId, ready });
    send({ type: "setReady", workId, ready });
  }

  /** For preferences: a problem on screen stays, it is not about them. */
  function sendQuietly(command: ClientCommand) {
    if (!updateInProgress.current && socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify({ ...command, workspace: state.workspace }));
  }

  function resizePanel(width: number) {
    setPanelWidth(width);
    clearTimeout(panelSave.current);
    panelSave.current = setTimeout(() => sendQuietly({ type: "panelWidth", width }), 300);
  }

  /** Release, cancel or a capture taken away (the window lost focus): the drag ends where it is. */
  function endPanelDrag() {
    const drag = panelDrag.current;
    if (!drag) return;
    panelDrag.current = undefined;
    setResizingPanel(false);
    if (drag.width !== drag.startWidth) resizePanel(drag.width);
  }

  function startConnect() {
    if (!isDesktop()) {
      loginWindow.current = window.open("about:blank", "_blank");
      if (loginWindow.current) loginWindow.current.opener = null;
    }
    send({ type: "connect" });
  }

  // One send path: the draft and the attachments always travel together.
  function submitRequest(opening?: string) {
    if (updateInProgress.current) return;
    const typed = text.trim();
    if (
      (!typed && !attachments.length && !opening) ||
      readingFiles ||
      dictation.active() ||
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
      "Revisá lo que adjunté.";
    // The server rejects longer requests; keep the draft so nothing is lost.
    if (combined.length > MAX_REQUEST_TEXT) {
      setProblem({
        text: "El pedido es muy largo. Acortalo un poco y probá de nuevo.",
      });
      return;
    }
    setPending(true);
    setPendingWorkId(selected);
    sentDraft.current = {
      workId: selected,
      text,
      attachments,
      generation: draftGeneration.current,
    };
    send({ type: "send", workId: selected, text: combined, attachments });
  }

  async function addFiles(files: File[]) {
    if (updateInProgress.current) return;
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
        throw new Error("Entre todos no pueden pesar más de 40 MB.");
      for (const f of files) {
        if (!/\.(png|jpe?g|webp|pdf|txt|md|csv|json)$/i.test(f.name))
          throw new Error(
            "Podés adjuntar fotos, PDF o archivos de texto.",
          );
        if (!f.size || f.size > 20 * 1024 * 1024)
          throw new Error(
            "Cada archivo tiene que pesar hasta 20 MB y no estar vacío.",
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
                reject(new Error("No pude abrir ese archivo. Elegilo de nuevo."));
              reader.readAsDataURL(f);
            }),
        ),
      );
      setAttachments((previous) =>
        appendReadFiles(previous, added, generation, draftGeneration.current),
      );
      if (generation === draftGeneration.current) setProblem(undefined);
    } catch (error) {
      if (generation === draftGeneration.current) setProblem({ text: String((error as Error).message) });
    } finally {
      if (generation === draftGeneration.current) setReadingFiles(false);
    }
  }

  useEffect(() => {
    const dragover = (event: DragEvent) => {
      event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      if (!updateInProgress.current && event.dataTransfer?.files.length) {
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
  const engineStatusText = state.engine.starting
    ? "Preparando Bitácora…"
    : state.engine.exhausted
      ? "Bitácora se frenó y no pudo volver a abrirse."
      : "Bitácora se frenó. La estoy volviendo a abrir…";
  const showProblemBanner =
    !showEngineStoppedBanner && (!!problem || !!work?.problem);
  const hasErrorBanner =
    !gallery && (showEngineStoppedBanner || showProblemBanner);

  const isPausedProgress = work?.progress === "Trabajo pausado.";
  const isDoneProgress = work?.progress === "Listo.";

  // While a question card is open, the card itself says Bitácora is waiting.
  const inProgressBlock = work?.busy && !work.question && (
    <div
      className="flex items-center gap-2 text-[14px] text-accent-ink font-bold"
      role="status"
    >
      <PenLine
        size={18}
        strokeWidth={1.75}
        className="writing-pen shrink-0"
        aria-hidden="true"
      />
      <span>
        {(work.progress || "Preparando la respuesta").replace(/[.…\s]+$/, "")}
        <span className="writing-dots" aria-hidden="true">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
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

  // The send button and Enter follow the same rule; while busy the button pauses.
  const dictationStatus = dictation.status;
  const dictating = dictationStatus.kind === "recording" ||
    dictationStatus.kind === "permission" || dictationStatus.kind === "transcribing";
  const micLabel = dictationStatus.kind === "recording" ? "Terminar dictado"
    : dictating ? "Cancelar dictado" : "Dictar";
  const sendBlocked =
    busy ||
    !canSend ||
    pending ||
    readingFiles ||
    dictating ||
    (!text.trim() && !attachments.length);

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

  async function chooseWorkspace() {
    if (updateInProgress.current || !state.workspace || folderAction || socket.current?.readyState !== WebSocket.OPEN) return;
    setFolderProblem(undefined);
    setFolderAction("picking");
    try {
      const path = await pickWorkspace(state.workspace, changeWorkspace);
      if (!path) {
        setFolderAction(undefined);
        return;
      }
      if (!changeWorkspace(path)) throw new Error("Offline");
    } catch (error) {
      setFolderAction(undefined);
      setFolderProblem(error instanceof FolderPickerProblem ? error.message : "No pude elegir la carpeta. Probá de nuevo.");
    }
  }

  function changeWorkspace(path: string) {
    if (updateInProgress.current || socket.current?.readyState !== WebSocket.OPEN) return false;
    setFolderProblem(undefined);
    setFolderAction("changing");
    sendQuietly({ type: "chooseWorkspace", path });
    return true;
  }

  const workspaceControl = state.workspace && (
    <WorkspaceControl
      path={state.workspace}
      disabled={!online || !!folderAction || welcomeSending}
      changing={folderAction === "changing"}
      problem={folderProblem}
      onChoose={chooseWorkspace}
    />
  );

  function sendWelcome(command: ClientCommand) {
    // Offline the screen already says so and its buttons are off: nothing to do.
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    // A problem from before does not belong on the screen that comes next.
    setProblem(undefined);
    setWelcomeSending(true);
    send(command);
  }

  function saveWelcome(answers: WelcomeAnswer) {
    sendWelcome({ type: "welcome", answers: { ...answers } });
  }

  function skipWelcome() {
    sendWelcome({ type: "skipWelcome" });
  }

  function openCodexImport() {
    if (updateInProgress.current || !online) return;
    setNavOpen(false);
    setCodexImportOpen((n) => n + 1);
    if (state.codexImportOffer) sendQuietly({ type: "dismissCodexImportOffer" });
  }

  const codexImportOffer = state.codexImportOffer && (
    <CodexImportOffer
      online={online}
      onOpen={openCodexImport}
      onDismiss={() => sendQuietly({ type: "dismissCodexImportOffer" })}
    />
  );

  // The first-run questions come before the account: they need no engine and
  // no cupo, so the app is useful from the first screen (DEC-015). They stay
  // mounted without a connection, with the answers still there.
  return (
    <>
      {state.welcome === "pending" ? (
        <Welcome
          key={state.workspace}
          workspaceControl={workspaceControl}
          codexImportOffer={codexImportOffer}
          notice={state.notice}
          problem={problem?.text}
          sending={welcomeSending}
          choosingWorkspace={!!folderAction}
          offline={!online}
          onSave={saveWelcome}
          onSkip={skipWelcome}
          onRetry={() => reconnectRef.current()}
        />
      ) : (
        <div
          className={`grid h-dvh grid-cols-1 bg-paper text-ink overflow-hidden ${
            gallery
              ? "min-[960px]:grid-cols-[220px_minmax(0,1fr)]"
              : "min-[960px]:grid-cols-[220px_minmax(0,1fr)_var(--panel-width)]"
          } ${resizingPanel ? "select-none cursor-col-resize" : ""}`}
          style={{ "--panel-width": `${shownPanel}px` } as React.CSSProperties}
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
        inert={updating}
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
            dictation.cancel();
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
          className={`flex items-center gap-2 px-[10px] py-[8px] text-[14px] text-ink cursor-pointer mb-4 border-l-2 transition-colors duration-150 ${focusRing} ${
            gallery
              ? "bg-surface font-bold border-accent rounded-r-[6px] rounded-l-none"
              : "border-transparent rounded-[6px] hover:bg-soft"
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

        {workspaceControl && <div className="mb-3">{workspaceControl}</div>}
        <CodexImportTrigger disabled={!online} onClick={openCodexImport} />

        <nav
          className="flex-1 min-h-0 overflow-y-auto flex flex-col"
          aria-labelledby="works-heading"
        >
          <h2 id="works-heading" className="px-[10px] pb-1.5 text-[13px] text-muted">
            Trabajos
          </h2>
          <ul className={`flex flex-col ${activeWorks.length ? "border-t border-line" : ""}`}>
            {activeWorks.map((w) => {
              const active = !gallery && selected === w.id;
              return (
                <WorkRow
                  key={w.id}
                  work={w}
                  active={active}
                  ready={false}
                  online={online}
                  sending={sendingId === w.id}
                  actionRef={placeFocus?.id === w.id && !placeFocus.ready ? placedRef : undefined}
                  onOpen={() => {
                    setGallery(false);
                    setRenaming(false);
                    setNavOpen(false);
                    setFocusedMessageId(undefined);
                    setSelected(w.id);
                    setProblem(undefined);
                  }}
                  onToggleReady={() => placeReady(w.id, true)}
                />
              );
            })}
          </ul>
          {!activeWorks.length && !readyWorks.length && (
            <p className="px-[10px] py-2 text-[13px] text-muted leading-relaxed">
              Acá van a aparecer tus trabajos.
            </p>
          )}
          {!activeWorks.length && readyWorks.length > 0 && (
            <p className="px-[10px] py-2 text-[13px] text-muted leading-relaxed">
              Todos están en Listos.
            </p>
          )}
          <p
            key={readyNotice?.seq}
            role="status"
            className={readyNotice ? "px-[10px] pt-2 text-[13px] text-muted" : "sr-only"}
          >
            {readyNotice?.text ?? ""}
          </p>
          {readyWorks.length > 0 && (
            <div className="mt-3 border-t border-line">
              <button
                ref={listosToggleRef}
                type="button"
                aria-expanded={listosOpen}
                className={`flex w-full items-center gap-2 rounded-[6px] px-[10px] py-[8px] text-left text-[13px] text-muted hover:bg-soft hover:text-ink cursor-pointer transition-colors duration-150 ${focusRing}`}
                onClick={() => setReadyOpen((open) => !open)}
              >
                <ChevronRight
                  size={14}
                  strokeWidth={1.75}
                  className={`shrink-0 transition-transform duration-150 ${listosOpen ? "rotate-90" : ""}`}
                  aria-hidden="true"
                />
                <span>Listos</span>
                <span className="tabular-nums">{readyWorks.length}</span>
              </button>
              {listosOpen && (
                <ul className="flex flex-col border-t border-line">
                  {readyWorks.map((w) => {
                    const active = !gallery && selected === w.id;
                    return (
                      <WorkRow
                        key={w.id}
                        work={w}
                        active={active}
                        ready
                        online={online}
                        sending={false}
                        actionRef={placeFocus?.id === w.id && placeFocus.ready ? placedRef : undefined}
                        onOpen={() => {
                          setGallery(false);
                          setRenaming(false);
                          setNavOpen(false);
                          setFocusedMessageId(undefined);
                          setSelected(w.id);
                          setProblem(undefined);
                        }}
                        onToggleReady={() => placeReady(w.id, false)}
                      />
                    );
                  })}
                </ul>
              )}
            </div>
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
                <p>Conectá tu cuenta de ChatGPT para empezar.</p>
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
                  Seguir en el navegador
                </a>
                <span className="block mt-1">
                  Cuando termines, volvé acá.
                </span>
              </p>
            )}
          </section>
        )}
      </aside>

      {/* Center column: header, notices, conversation/gallery, composer */}
      <main ref={mainRef} tabIndex={-1} className="flex flex-col min-w-0 min-h-0 bg-paper outline-none">
        <header inert={updating} className="px-5 min-[960px]:px-7 py-[18px] border-b border-line flex items-center justify-between gap-4">
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
                className={`min-w-0 flex-1 rounded-[6px] border border-line bg-surface px-3 py-2 text-[15px] text-ink focus:outline-none focus:border-ink`}
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
                    className={`w-[36px] h-[36px] max-[959px]:w-[40px] max-[959px]:h-[40px] inline-grid place-items-center ${state.engine.starting ? "text-muted" : "text-danger"}`}
                    role="img"
                    title={engineStatusText}
                    aria-label={engineStatusText}
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
                {!gallery && work?.ready && (
                  <button
                    type="button"
                    className={`${buttonQuiet} aria-disabled:opacity-40 aria-disabled:cursor-default aria-disabled:hover:bg-surface`}
                    title={online ? "Volver a la lista" : OFFLINE_READY}
                    aria-label={`Volver a la lista: ${work.title}`}
                    aria-disabled={!online || undefined}
                    aria-describedby={online ? undefined : `return-reason-${work.id}`}
                    onClick={() => {
                      if (!online) return;
                      placeReady(work.id, false);
                    }}
                  >
                    <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className="max-[720px]:hidden">Volver a la lista</span>
                  </button>
                )}
                {!gallery && work?.ready && !online && (
                  <span id={`return-reason-${work.id}`} className="sr-only">
                    {OFFLINE_READY}
                  </span>
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
                    title="Para mandar"
                    aria-label="Ver lo que está para mandar"
                  >
                    <Package size={18} strokeWidth={1.75} aria-hidden="true" />
                    {workResultCount > 0 && (
                      <span className="tabular-nums text-ink">
                        {workResultCount}
                      </span>
                    )}
                  </button>
                )}
              </div>
            </>
          )}
        </header>

        {updateNotice !== "idle" && (
          <section aria-label="Actualización de Bitácora" className="shrink-0 px-5 min-[960px]:px-7 py-2 border-b border-line bg-surface text-[13px] flex flex-wrap items-center justify-between gap-2">
            <div role="status">
              <p className="font-bold text-ink">{updating ? "Actualizando Bitácora…" : "Hay una versión nueva de Bitácora"}</p>
              <p className="text-muted">
                {updating ? "Se va a volver a abrir cuando termine."
                  : !updateReady ? "Podés actualizar cuando Bitácora esté lista."
                  : updateBlocked ? "Terminá lo que está en curso antes de actualizar."
                  : hasDraft ? "Terminá el borrador antes de actualizar."
                  : updateNotice === "busy" ? "Había algo en curso. Probá de nuevo en un momento."
                  : updateNotice === "failed" ? "No pude actualizar ahora. Podés seguir usando Bitácora."
                  : null}
              </p>
            </div>
            {!updating && updateReady && (
              <button
                type="button"
                className={buttonBordered}
                disabled={!online || updateBlocked || hasDraft}
                onClick={() => {
                  const webview = window.chrome?.webview;
                  if (!webview || updateInProgress.current) return;
                  updateInProgress.current = true;
                  setUpdateNotice("working");
                  webview.postMessage("bitacora:update:install");
                }}
              >
                Actualizar
              </button>
            )}
          </section>
        )}

        {((state.undo && !busy) || state.notice || codexImportOffer) && (
          <section
            inert={updating}
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
                              "Voy a dejar tu carpeta como está ahora y ya no vas a poder deshacer ese cambio. Después podés seguir trabajando.",
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
                  Vuelvo atrás los cambios de ese pedido, aunque sea de otro
                  trabajo. Lo que tocaste a mano después queda intacto.
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
            {codexImportOffer}
          </section>
        )}

        <div inert={updating} className="flex-1 min-h-0 overflow-y-auto px-5 min-[960px]:px-7 py-6">
            <div
              className={`mx-auto w-full flex flex-col gap-[18px] ${
                gallery ? "max-w-[880px]" : "max-w-[720px]"
              }`}
            >
              {gallery && (
                <section aria-label="Resultados por trabajo" className="flex flex-col gap-6">
                  <h2 className="font-display text-[25px] font-normal text-ink">
                    Todo lo que armamos
                  </h2>
                  {!hasGalleryResults && (
                    <div className="rounded-[6px] border border-line bg-surface p-6 flex flex-col items-start gap-3">
                      <p className="text-[15px] text-muted">
                        Cuando armemos placas o presupuestos, los vas a encontrar acá.
                      </p>
                      <button
                        type="button"
                        className={buttonBordered}
                        onClick={() => setGallery(false)}
                      >
                        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
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
                              <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
                            </button>
                          </div>
                          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {results.map((f) => (
                              <FileCard
                                key={`${f.id}-${state.fileRevision}`}
                                file={f}
                                token={sessionSecret}
                                fileRevision={state.fileRevision}
                                onMarkOpened={markOpened}
                                result
                                onPreview={(file) =>
                                  setPreview({
                                    file,
                                    list: results.filter((x) =>
                                      x.mime.startsWith("image/"),
                                    ),
                                    trackOpened: true,
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
                    Se cortó la conexión. Estoy intentando volver…
                  </p>
                  <button
                    type="button"
                    className={buttonBordered}
                    onClick={() => reconnectRef.current()}
                  >
                    <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
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
                    Conectá tu cuenta de ChatGPT para empezar.
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
                        Seguir en el navegador
                      </a>{" "}
                      Cuando termines, volvé acá.
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
                      Contame qué necesitás o pegá un link para empezar.
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
                      {routes.map((route) => (
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
                        {m.role === "assistant" &&
                          m.text.trim() &&
                          !(work.busy && i === work.messages.length - 1) && (
                            <CopyMessageButton text={m.text} />
                          )}
                        {!!m.attachments?.length && (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {m.attachments.map((f) => (
                              <FileCard
                                key={`${f.id}-${state.fileRevision}`}
                                file={f}
                                token={sessionSecret}
                                fileRevision={state.fileRevision}
                                onPreview={(file) => setPreview({ file, list: [file] })}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </article>
                    {i === lastDeliverablesIndex && !!m.results?.length && (() => {
                      const count = messageDeliverableCount(work, m.id);
                      return (
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
                          Ver {count} para mandar
                        </button>
                      );
                    })()}
                  </React.Fragment>
                ))}

              {!gallery && work && (inProgressBlock || pausedProgressBlock)}

              {!gallery && work?.question && (
                <QuestionCard
                  key={work.question.id}
                  question={work.question}
                  disabled={!online}
                  sending={answering === work.question.id}
                  onAnswer={(answers) => {
                    const questionId = work.question!.id;
                    respond(questionId, { type: "answer", workId: work.id, questionId, answers });
                  }}
                  onSkip={() => {
                    const questionId = work.question!.id;
                    respond(questionId, { type: "skipQuestion", workId: work.id, questionId });
                  }}
                />
              )}

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
                        Se cortó la conexión. Estoy intentando volver…
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
                  <section className={`rounded-[6px] border ${state.engine.starting ? "border-line" : "border-danger"} bg-surface px-4 py-3`}>
                    <DetailsToggle
                      text={state.engine.starting ? undefined : state.engine.safety.detail}
                      prefix={
                        <>
                          <AlertCircle
                            size={18}
                            strokeWidth={1.75}
                            className={`${state.engine.starting ? "text-muted" : "text-danger"} shrink-0`}
                            aria-hidden="true"
                          />
                          <div role="status" className="text-[14px] text-ink">
                            <p>
                              {engineStatusText}
                            </p>
                            {/* Keep the work's own problem visible: this banner replaces the problem banner. */}
                            {(problem?.text || work?.problem) && (
                              <p className="text-muted">{problem?.text || work?.problem}</p>
                            )}
                          </div>
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
                            Para cuidar tus otros archivos, Windows te va a pedir
                            permiso una sola vez. Tocá «Sí» para seguir.
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
                        problem?.workId && problem.workId !== selected && state.works.some((w) => w.id === problem.workId) ? (
                          <button
                            type="button"
                            className={buttonQuiet}
                            onClick={() => {
                              setGallery(false);
                              setRenaming(false);
                              setFocusedMessageId(undefined);
                              setSelected(problem.workId);
                              setProblem(undefined);
                            }}
                          >
                            <ArrowRight size={18} strokeWidth={1.75} aria-hidden="true" />
                            Ir a la pregunta
                          </button>
                        ) : state.engine.exhausted && (
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
          <div inert={updating} className="shrink-0 px-5 min-[960px]:px-7 pb-5">
            <form
              className="relative mx-auto w-full max-w-[720px] bg-surface border border-line focus-within:border-ink rounded-[6px] px-3 py-2.5 flex flex-col gap-2"
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
                      Cargando…
                    </span>
                  )}
                </div>
              )}

              <div role="status" className={dictationStatus.kind === "idle" ? "sr-only" : "text-[13px] text-accent-ink"}>
                {dictationStatus.kind === "permission" && "Abriendo el micrófono…"}
                {dictationStatus.kind === "recording" && "Escuchando…"}
                {dictationStatus.kind === "transcribing" && "Transcribiendo…"}
                {dictationStatus.kind === "error" && <span className="text-danger">{dictationStatus.message}</span>}
                {dictationStatus.kind === "notice" && dictationStatus.message}
              </div>
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
                    ? "Conectá tu cuenta para escribir…"
                    : "Escribí tu pedido o pegá un link…"
                }
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // When the button could not send, Enter keeps its usual new line.
                  if (sendBlocked || !sendsOnEnter({ ...e, isComposing: e.nativeEvent.isComposing })) return;
                  e.preventDefault();
                  submitRequest();
                }}
                className="w-full resize-none min-h-[44px] max-h-48 border-0 bg-transparent px-1 py-2 text-[15px] leading-[1.45] text-ink placeholder:text-muted focus:outline-none disabled:cursor-default disabled:opacity-70"
              />

              <div className="flex items-center gap-1">
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
                <button
                  type="button"
                  className={`${iconButton} ${dictationStatus.kind === "recording" ? "bg-soft !text-accent-ink" : ""}`}
                  disabled={!dictationToken || pending}
                  title={micLabel}
                  aria-label={micLabel}
                  onClick={() => {
                    if (dictationStatus.kind === "recording") dictation.stop();
                    else if (dictating) {
                      dictation.cancel();
                      composerInput.current?.focus();
                    }
                    else void dictation.start();
                  }}
                >
                  {dictating ? (
                    <Square size={18} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <Mic size={18} strokeWidth={1.75} aria-hidden="true" />
                  )}
                </button>
                {state.model && (
                  <ModelPicker
                    model={state.model}
                    disabled={!online}
                    onChoose={(model) => sendQuietly({ type: "chooseModel", model })}
                    onRefresh={() => sendQuietly({ type: "refreshModels" })}
                  />
                )}
                <span className="flex-1" />

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
                    disabled={sendBlocked}
                    title="Enviar pedido"
                    aria-label="Enviar pedido"
                    className={`w-[36px] h-[36px] max-[959px]:w-[40px] max-[959px]:h-[40px] shrink-0 rounded-[6px] bg-ink text-surface grid place-items-center cursor-pointer enabled:hover:opacity-90 disabled:bg-ink/40 disabled:cursor-default transition-colors duration-150 ${focusRing}`}
                  >
                    <ArrowUp size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
              </div>
            </form>
            {state.model?.notice && (
              <p
                role="status"
                className="mx-auto w-full max-w-[720px] mt-2 flex items-start gap-2 text-[13px] text-muted"
              >
                <AlertCircle size={16} strokeWidth={1.75} className="text-accent-ink shrink-0 mt-[2px]" aria-hidden="true" />
                <span>{state.model.notice}</span>
              </p>
            )}
          </div>
        )}
      </main>

      {/* Right sidebar: Deliverables */}
      {!gallery && (
        <aside
          inert={updating}
          className={`${
            deliverablesOpen
              ? "fixed inset-y-0 right-0 z-40 w-[min(320px,90vw)] flex"
              : "hidden min-[960px]:flex relative"
          } flex-col border-l border-line bg-surface px-3 py-5 min-h-0`}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Ancho de los entregables"
            aria-valuemin={panelLimits.min}
            aria-valuemax={panelLimits.max}
            aria-valuenow={shownPanel}
            aria-valuetext={`${shownPanel} píxeles`}
            tabIndex={0}
            title="Arrastrá para cambiar el ancho"
            className="group hidden min-[960px]:block absolute inset-y-0 -left-[6px] w-[11px] z-10 cursor-col-resize touch-none outline-none"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              panelDrag.current = { startX: e.clientX, startWidth: shownPanel, width: shownPanel };
              setResizingPanel(true);
            }}
            onPointerMove={(e) => {
              const drag = panelDrag.current;
              if (!drag) return;
              drag.width = clampPanel(drag.startWidth + drag.startX - e.clientX, viewport);
              setPanelWidth(drag.width);
            }}
            onPointerUp={endPanelDrag}
            onPointerCancel={endPanelDrag}
            onLostPointerCapture={endPanelDrag}
            onKeyDown={(e) => {
              const next = panelKey(e.key, shownPanel, viewport, e.shiftKey);
              if (next === undefined) return;
              e.preventDefault();
              resizePanel(next);
            }}
          >
            <span
              aria-hidden="true"
              className={`absolute left-[5px] top-1/2 -translate-y-1/2 w-[3px] h-[40px] rounded-[6px] transition-colors duration-150 ${
                resizingPanel
                  ? "bg-accent"
                  : "bg-line group-hover:bg-muted group-focus-visible:bg-accent"
              }`}
            />
            <span
              aria-hidden="true"
              className={`absolute inset-y-0 left-[6px] w-px ${resizingPanel ? "bg-accent" : "group-focus-visible:bg-accent"}`}
            />
          </div>
          <DeliverablesPanel
            work={work}
            focusedMessageId={focusedMessageId}
            token={sessionSecret}
            fileRevision={state.fileRevision}
            onMarkOpened={markOpened}
            hasGalleryResults={hasGalleryResults}
            onOpenGallery={() => {
              setGallery(true);
              setDeliverablesOpen(false);
              setFocusedMessageId(undefined);
            }}
            onPreview={(file, list) => setPreview({ file, list, trackOpened: true })}
            onCloseMobile={() => closeDeliverablesDrawer(true)}
            closeMobileRef={deliverablesCloseRef}
          />
        </aside>
      )}

      {preview && (
        <FilePreviewModal
          file={preview.file}
          list={preview.list}
          token={sessionSecret}
          fileRevision={state.fileRevision}
          onMarkOpened={preview.trackOpened ? markOpened : undefined}
          onSelect={(file) => setPreview((prev) => (prev ? { ...prev, file } : prev))}
          onClose={() => setPreview(undefined)}
        />
      )}
        </div>
      )}
      <CodexImport
        online={online && !updating}
        workspace={state.workspace}
        openRequest={codexImportOpen}
        hideTrigger
        message={codexImportMessage}
        send={sendQuietly}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
