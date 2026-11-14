import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Snapshot,
  ClientCommand,
  ServerMessage,
} from "../../server/src/contracts";
import "./style.css";
import { FileCard } from "./files";
import type { Work } from "../../server/src/contracts";
const latestResult = (work: Work) => work.messages.flatMap(m => m.results || []).reduce((latest, f) => f.createdAt > latest ? f.createdAt : latest, "");
import type { Upload } from "../../server/src/contracts";
import ReactMarkdown from "react-markdown";
import { protectionText } from "./protection-text";

const buttonBase = "touch-manipulation cursor-pointer rounded-lg border px-[15px] py-[10px] text-center disabled:opacity-50 disabled:cursor-default focus-visible:outline-3 focus-visible:outline-[#94733c] focus-visible:outline-offset-3 max-[460px]:text-xs max-[460px]:p-[9px]";
const buttonSecondary = `${buttonBase} border-[#c6d0c9] hover:bg-[#e4ebe5]`;
const buttonPrimary = `${buttonBase} text-white bg-[#31594d] border-[#31594d] hover:bg-[#22483e]`;

function App() {
  const [state, setState] = useState<Snapshot>({
    account: { connected: false },
    works: [],
    engine: { available: false, safety: { allowed: false, detail: "" } },
  });
  const [gallery, setGallery] = useState(false);
  const [attachments, setAttachments] = useState<Upload[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string>();
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
          setSelected(message.workId);
          setText("");
          setAttachments([]);
          setPending(false);
        }
        if (message.type === "problem") {
          setProblem(message);
          setPending(false);
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
        if (!disposed) timer = setTimeout(connect, 1500);
      };
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket.current?.close();
    };
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [selected, work?.messages.length, work?.messages.at(-1)?.text]);
  function send(command: ClientCommand) {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    setProblem(undefined);
    socket.current.send(JSON.stringify(command));
  }
  async function addFiles(files: File[]) {
    if (readingFiles || pending) return;
    setReadingFiles(true);
    try {
      if (attachments.length + files.length > 10) throw new Error("Podés adjuntar hasta 10 archivos.");
      const total = attachments.reduce((n, f) => n + f.data.length * 3 / 4, 0) + files.reduce((n, f) => n + f.size, 0);
      if (total > 40 * 1024 * 1024) throw new Error("Los adjuntos pueden pesar hasta 40 MB en total.");
      for (const f of files) {
        if (!/\.(png|jpe?g|webp|pdf|txt|md|csv|json)$/i.test(f.name)) throw new Error("Elegí una imagen, un PDF o texto (txt, md, csv o json).");
        if (!f.size || f.size > 20 * 1024 * 1024) throw new Error("Cada archivo debe tener contenido y pesar hasta 20 MB.");
      }
      const added = await Promise.all(files.map(f => new Promise<Upload>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: f.name, data: String(reader.result).split(",")[1] });
        reader.onerror = () => reject(new Error("No pude leer el archivo. Elegilo de nuevo."));
        reader.readAsDataURL(f);
      })));
      setAttachments(previous => [...previous, ...added]);
      setProblem(undefined);
    } catch (error) { setProblem({ text: String((error as Error).message) }); }
    finally { setReadingFiles(false); }
  }
  useEffect(() => {
    const dragover = (event: DragEvent) => { event.preventDefault(); };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer?.files.length) {
        setGallery(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }
    };
    window.addEventListener('dragover', dragover);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', dragover); window.removeEventListener('drop', drop); };
  });
  useEffect(() => {
    document.title = gallery ? "Galería · Bitácora" : "Bitácora";
    document.querySelector<HTMLElement>("main")?.focus();
  }, [gallery]);
  return (
    <div className="grid grid-cols-[280px_1fr] h-dvh max-[720px]:grid-cols-[190px_1fr] max-[460px]:grid-cols-[135px_1fr] font-sans text-[#283c3a] bg-[#faf9f5] [font-synthesis:none]">
      <aside className="bg-[#edf0e9] border-r border-[#dbe0d6] pt-[30px] px-[22px] pb-[22px] flex flex-col gap-7 overflow-y-auto max-[720px]:px-3 max-[720px]:py-5 max-[720px]:gap-5">
        <header>
          <p className="text-[10px] tracking-[1.7px] font-[650] text-[#5e7067] max-[460px]:text-[8px]">
            TU AGENCIA, EN MARCHA
          </p>
          <h1 className="font-[Georgia,serif] text-[38px] mt-[6px] tracking-[-1.5px] [&>span]:text-[#96754b] max-[720px]:text-[30px] max-[460px]:text-[25px]">
            Bitácora<span aria-hidden="true">.</span>
          </h1>
        </header>
        <button
          className={`${buttonPrimary} w-full`}
          onClick={() => {
            setGallery(false);
            setAttachments([]);
            setSelected(undefined);
            setText("");
            setProblem(undefined);
          }}
        >
          + Nuevo trabajo
        </button>
        <button className={buttonSecondary} onClick={() => setGallery(true)} aria-pressed={gallery}>Galería</button>
        <nav
          className="flex-1 [&>h2]:uppercase [&>h2]:tracking-[1.5px] [&>h2]:text-[11px] [&>h2]:mb-4 [&>h2]:text-[#58675e]"
          aria-label="Trabajos anteriores"
        >
          <h2>Tus trabajos</h2>
          <ul>
            {state.works.map((w) => (
              <li key={w.id}>
                <button
                  className={`${buttonBase} hover:bg-[#e4ebe5] block w-full text-left mb-2 p-3 [&>span]:block [&>span]:[overflow-wrap:anywhere] [&>span]:text-sm [&>span]:font-[550] ${selected === w.id ? "bg-[#fffefa] border-[#d9ddd2]" : "border-transparent"}`}
                  aria-current={selected === w.id ? "page" : undefined}
                  onClick={() => {
                    setGallery(false);
                    setSelected(w.id);
                    setProblem(undefined);
                  }}
                >
                  <span>{w.title}</span>
                  <small className="block text-[#59665d] text-xs mt-[5px]">
                    {w.busy
                      ? "En curso"
                      : new Date(w.updatedAt).toLocaleDateString("es-AR", {
                          day: "numeric",
                          month: "short",
                        })}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {!state.works.length && (
            <p className="text-[#616e65] text-[13px] leading-[1.7]">
              Acá vas a encontrar lo que hagamos juntas.
            </p>
          )}
        </nav>
        <section
          className="border-t border-[#d3dbcf] pt-[18px] text-[13px] [&>p]:mb-2 [&>button]:w-full [&>button]:mt-3 [&_small]:[overflow-wrap:anywhere]"
          aria-label="Cuenta de ChatGPT"
        >
          <p>
            <span
              className={`inline-block size-[7px] bg-[#8a9087] rounded-full mr-2 ${state.account.connected ? "bg-[#36775a]" : ""}`}
              aria-hidden="true"
            />
            {online && state.engine.available && state.account.connected
              ? "ChatGPT conectado"
              : !online
                ? "Reconectando…"
                : !state.engine.available
                  ? "El motor está detenido"
                  : "ChatGPT sin conectar"}
          </p>
          {state.account.email && (
            <small className="block text-[#59665d] text-xs mt-[5px]">
              {state.account.email}
            </small>
          )}
          {!state.account.connected && (
            <button
              className={buttonSecondary}
              disabled={!online || !state.engine.available}
              onClick={() => {
                loginWindow.current = window.open("about:blank", "_blank");
                if (loginWindow.current) loginWindow.current.opener = null;
                send({ type: "connect" });
              }}
            >
              Conectar ChatGPT
            </button>
          )}
          {login && (
            <p>
              <a
                className="touch-manipulation text-[#245a4d] underline focus-visible:outline-3 focus-visible:outline-[#94733c] focus-visible:outline-offset-3"
                href={login}
                target="_blank"
                rel="noreferrer"
              >
                Continuar en el navegador
              </a>
              <small className="block text-[#59665d] text-xs mt-[5px]">
                Cuando termines, volvé a esta ventana.
              </small>
            </p>
          )}
        </section>
      </aside>
      <main tabIndex={-1} className="flex flex-col min-w-0 min-h-0">
        <header className="py-5 px-9 border-b border-[#e6e7de] flex items-center justify-between gap-5 [&>p]:m-0 [&>p]:text-sm [&>p]:font-semibold [&>p]:truncate [&>span]:text-[#69756d] [&>span]:text-xs [&>span]:shrink-0 max-[720px]:p-4 max-[720px]:[&>span]:hidden">
          <p>{gallery ? "Galería" : work?.title || "Un lugar para tus próximos pasos"}</p>
          <span>{online ? "Tu espacio de trabajo" : "Reconectando…"}</span>
        </header>
        <div className="overflow-y-auto flex-1 py-8 px-[max(30px,calc((100%_-_760px)/2))] max-[720px]:p-5">
          {gallery && <section aria-label="Resultados por trabajo">
            <h2 className="font-[Georgia,serif] text-3xl mb-6">Todo lo que creamos</h2>
            {!state.works.some(w => w.messages.some(m => m.results?.length)) && <p>Cuando preparemos imágenes o PDFs, los vas a encontrar acá.</p>}
            {[...state.works].sort((a, b) => latestResult(b).localeCompare(latestResult(a))).map(w => {
              const results = w.messages.flatMap(m => m.results || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
              return results.length ? <section key={w.id} className="mb-8">
                <h3 className="font-semibold">{w.title}</h3>
                <button className={buttonSecondary} onClick={() => { setSelected(w.id); setGallery(false); }}>Ir al trabajo</button>
                <div className="grid gap-4 sm:grid-cols-2">{results.map(f => <FileCard key={f.id} file={f} token={state.fileToken} result />)}</div>
              </section> : null;
            })}
          </section>}
          {!gallery && !work && (
            <section className="mt-[10vh] mx-auto mb-[30px] [&>h2]:font-[Georgia,serif] [&>h2]:text-4xl [&>h2]:leading-[1.2] [&>h2]:tracking-[-0.7px] [&>h2]:my-[18px] [&>p:last-child]:text-[#657168] [&>p:last-child]:leading-[1.8] [&>p:last-child]:text-base max-[720px]:[&>h2]:text-[28px] max-[460px]:[&>h2]:text-2xl">
              <p className="text-[10px] tracking-[1.7px] font-[650] text-[#5e7067] max-[460px]:text-[8px]">
                EMPECEMOS POR UNA IDEA
              </p>
              <h2>¿En qué trabajamos hoy?</h2>
              <p>
                Contame qué necesitás para tu agencia.
                <br />
                Podés volver a cada trabajo cuando quieras.
              </p>
            </section>
          )}
          {!gallery && work?.messages.map((m) => (
            <article
              key={m.id}
              className={`mb-[26px] text-[15px] leading-[1.75] [&>h2]:text-[11px] [&>h2]:uppercase [&>h2]:tracking-[1px] [&>h2]:text-[#67746b] [&>h2]:mb-[7px] [&>div]:[overflow-wrap:anywhere] ${m.role === "user" ? "bg-[#eef0e8] py-[18px] px-[22px] rounded-xl" : ""}`}
            >
              <h2>{m.role === "user" ? "Vos" : "Bitácora"}</h2>
              {m.role === "user" ? <div className="whitespace-pre-wrap">{m.text.split(/(https?:\/\/[^\s]+)/g).map((part, i) => /^https?:\/\//.test(part) ? <a key={i} className="underline text-[#245a4d]" href={part} target="_blank" rel="noreferrer">{part}</a> : part)}</div> : <div className="markdown"><ReactMarkdown skipHtml components={{ a: ({node, ...props}) => /^https?:\/\//i.test(props.href || '') ? <a {...props} target="_blank" rel="noopener noreferrer" /> : <span>{props.children}</span> }}>{m.text}</ReactMarkdown></div>}
              <div className="grid gap-3 sm:grid-cols-2">{m.attachments?.map(f => <FileCard key={f.id} file={f} token={state.fileToken} />)}</div>
              {!!m.results?.length && <section aria-label="Resultados del pedido"><h3 className="mt-5 font-semibold">Resultados</h3><div className="grid gap-3 sm:grid-cols-2">{m.results.map(f => <FileCard key={f.id} file={f} token={state.fileToken} result />)}</div></section>}
            </article>
          ))}
          <div ref={bottom} />
        </div>
        {!gallery && <div className="w-full max-w-[820px] mx-auto pt-[10px] px-[30px] pb-[26px] max-[720px]:px-4 max-[720px]:pb-[18px]">
          {state.notice && (
            <p role="alert" className="text-sm text-[#913d2c]">
              {state.notice}
            </p>
          )}
          {online && !state.engine.available && (
            <p role="status" className="text-sm text-[#913d2c]">
              {state.engine.exhausted ? "No pude volver a conectar el motor. Tocá Reintentar para volver a arrancarlo." : "El motor se detuvo. Estoy intentando volver a conectarlo."}
              {state.engine.exhausted && <button className={buttonSecondary} onClick={() => send({ type: "retry" })}>Reintentar</button>}
            </p>
          )}
          {online && state.engine.available && !state.engine.safety.allowed && (
            state.engine.safety.status !== "failed" && !state.engine.safety.needsPermission ?
              <p role="status" className="mb-3 text-sm">Preparando todo…</p> :
            <section aria-labelledby="protection-title" className="mb-4 rounded-xl border border-[#cdd4c8] bg-[#fffefa] p-5">
              <h2 id="protection-title" className="font-semibold">{state.engine.safety.status === "failed" ? "No pude dejar todo listo" : "Antes de empezar"}</h2>
              {state.engine.safety.needsPermission && <p className="my-2 text-sm">Para trabajar en tu carpeta sin cambiar tus otros archivos, Bitácora necesita preparar la protección de tu compu. Windows va a mostrar un cartel para permitir cambios. Tocá «Sí» si querés continuar.</p>}
              <p role="status" className="my-2 text-sm">{protectionText(state.engine.safety)}</p>
              <button className={buttonPrimary} disabled={state.engine.safety.status === "preparing"}
                onClick={() => send({ type: "prepareProtection" })}>
                {state.engine.safety.status === "preparing" ? "Preparando…" : state.engine.safety.status === "failed" ? "Reintentar" : "Preparar la protección"}
              </button>
            </section>
          )}
          {online && (!state.engine.available || (!state.engine.safety.allowed && (state.engine.safety.needsPermission || state.engine.safety.status === "failed"))) && <details className="mb-3 text-xs text-[#596b5e]">
            <summary className="cursor-pointer focus-visible:outline-3 focus-visible:outline-[#94733c] focus-visible:outline-offset-3">
              Detalle del motor
            </summary>
            <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] max-h-[220px] overflow-auto p-3 bg-[#efefe7]">
              {state.engine.safety.detail}
            </pre>
          </details>}
          <p
            className="text-[13px] min-h-5 text-[#4b6556] mb-[10px]"
            role="status"
          >
            {work?.busy
              ? work.progress
              : work?.progress ||
                (!state.engine.safety.allowed
                  ? ""
                  : state.account.connected
                  ? "Todo listo para empezar."
                  : "Conectá tu cuenta de ChatGPT para empezar.")}
          </p>
          {(problem || work?.problem) && (
            <p className="text-sm text-[#913d2c]" role="alert">
              {problem?.text || work?.problem}
            </p>
          )}
          {(work?.details || problem?.detail) && (
            <details className="mb-3 text-xs text-[#596b5e]">
              <summary className="cursor-pointer focus-visible:outline-3 focus-visible:outline-[#94733c] focus-visible:outline-offset-3">
                Ver detalle
              </summary>
              <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] max-h-[220px] overflow-auto p-3 bg-[#efefe7]">
                {problem?.detail}
                {work?.details}
              </pre>
            </details>
          )}
          {state.works.length === 0 && state.hasBrand === false && <button className={`${buttonPrimary} mb-4`}
            disabled={!online || !state.engine.available || !state.engine.safety.allowed || !state.account.connected || pending || readingFiles || busy}
            onClick={() => { setPending(true); send({ type: "send", text: "Ayudame a armar mi marca y mis plantillas para empezar." }); }}>
            Armar mi agencia
          </button>}
          <form
            className="bg-[#fffefa] border border-[#cdd4c8] rounded-xl py-[14px] px-[18px]"
            onSubmit={(e) => {
              e.preventDefault();
              if (
                (!text.trim() && !attachments.length) ||
                readingFiles ||
                busy ||
                pending ||
                !online ||
                !state.engine.available ||
                !state.engine.safety.allowed ||
                !state.account.connected
              )
                return;
              setPending(true);
              send({ type: "send", workId: selected, text: text.trim() || "Revisá los archivos adjuntos.", attachments });
            }}
          >
            <label className="text-xs font-semibold" htmlFor="request">
              Tu pedido
            </label>
            <textarea
              className="resize-y min-h-20 max-h-60 border-none bg-transparent block py-[10px] w-full text-inherit text-[15px] placeholder:text-[#748075] focus-visible:outline-3 focus-visible:outline-[#94733c] focus-visible:outline-offset-3"
              id="request"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={20000}
              placeholder="Por ejemplo: ayudame a organizar una propuesta de viaje…"
              rows={3}
            />
            <div className="mb-3">
              <input ref={fileInput} id="attachments" aria-label="Elegir archivos" type="file" multiple accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.json" className="sr-only" tabIndex={-1} onChange={e => { void addFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
              <button type="button" className={buttonSecondary} disabled={pending || readingFiles} onClick={() => fileInput.current?.click()}>Adjuntar archivos</button>
              <p className="mt-2 text-xs text-[#69746a]">También podés arrastrarlos acá. Hasta 20 MB por archivo y 40 MB por pedido.</p>
              <p role="status" className="text-xs">{readingFiles ? "Leyendo archivos…" : ""}</p>
              <ul>{attachments.map((f, i) => <li key={i} className="flex items-center gap-3 my-2 break-words text-sm"><span>{f.name}</span><button className={buttonSecondary} type="button" aria-label={`Quitar ${f.name}`} onClick={() => setAttachments(a => a.filter((_, n) => n !== i))}>Quitar</button></li>)}</ul>
            </div>
            <footer className="flex items-center justify-between gap-4 [&>span]:text-[11px] [&>span]:text-[#69746a] [&>button]:text-[13px] max-[720px]:[&>span]:hidden">
              <span>
                {!online
                  ? "Esperando la conexión con Bitácora."
                  : busy
                    ? "Podés pausar el pedido en curso."
                    : "Escribí con tus palabras."}
              </span>
              {busy ? (
                <button
                  className={buttonSecondary}
                  type="button"
                  onClick={() => {
                    const active = state.works.find((w) => w.busy);
                    if (active) send({ type: "interrupt", workId: active.id });
                  }}
                >
                  Pausar pedido
                </button>
              ) : (
                <button
                  className={buttonPrimary}
                  disabled={
                    !online ||
                    !state.engine.available ||
                    !state.engine.safety.allowed ||
                    !state.account.connected ||
                    pending ||
                    readingFiles ||
                    (!text.trim() && !attachments.length)
                  }
                  type="submit"
                >
                  {pending ? "Enviando…" : "Enviar pedido"}
                </button>
              )}
            </footer>
          </form>
        </div>}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
