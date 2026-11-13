import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Snapshot,
  ClientCommand,
  ServerMessage,
} from "../../server/src/contracts";
import "./style.css";

function App() {
  const [state, setState] = useState<Snapshot>({
    account: { connected: false },
    works: [],
  });
  const [selected, setSelected] = useState<string>();
  const [text, setText] = useState("");
  const [online, setOnline] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{ text: string; detail?: string }>();
  const [login, setLogin] = useState<string>();
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
        if (message.type === "selected") {
          setSelected(message.workId);
          setText("");
          setPending(false);
        }
        if (message.type === "problem") {
          setProblem(message);
          setPending(false);
        }
        if (message.type === "login") {
          setLogin(message.url);
          window.open(message.url, "_blank", "noopener,noreferrer");
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
  return (
    <div className="shell">
      <aside className="sidebar">
        <header>
          <p className="eyebrow">TU AGENCIA, EN MARCHA</p>
          <h1>
            Bitácora<span aria-hidden="true">.</span>
          </h1>
        </header>
        <button
          className="primary new"
          onClick={() => {
            setSelected(undefined);
            setText("");
            setProblem(undefined);
          }}
        >
          + Nuevo trabajo
        </button>
        <nav aria-label="Trabajos anteriores">
          <h2>Tus trabajos</h2>
          <ul>
            {state.works.map((w) => (
              <li key={w.id}>
                <button
                  className={`work ${selected === w.id ? "active" : ""}`}
                  aria-current={selected === w.id ? "page" : undefined}
                  onClick={() => {
                    setSelected(w.id);
                    setProblem(undefined);
                  }}
                >
                  <span>{w.title}</span>
                  <small>
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
            <p className="muted">Acá vas a encontrar lo que hagamos juntas.</p>
          )}
        </nav>
        <section className="account" aria-label="Cuenta de ChatGPT">
          <p>
            <span
              className={`dot ${state.account.connected ? "connected" : ""}`}
              aria-hidden="true"
            />
            {state.account.connected
              ? "ChatGPT conectado"
              : "ChatGPT sin conectar"}
          </p>
          {state.account.email && <small>{state.account.email}</small>}
          {!state.account.connected && (
            <button
              disabled={!online}
              onClick={() => send({ type: "connect" })}
            >
              Conectar ChatGPT
            </button>
          )}
          {login && (
            <p>
              <a href={login} target="_blank" rel="noreferrer">
                Continuar en el navegador
              </a>
              <small>Cuando termines, volvé a esta ventana.</small>
            </p>
          )}
        </section>
      </aside>
      <main>
        <header className="topbar">
          <p>{work?.title || "Un lugar para tus próximos pasos"}</p>
          <span>{online ? "Tu espacio de trabajo" : "Reconectando…"}</span>
        </header>
        <div className="conversation">
          {!work && (
            <section className="welcome">
              <p className="eyebrow">EMPECEMOS POR UNA IDEA</p>
              <h2>¿En qué trabajamos hoy?</h2>
              <p>
                Contame qué necesitás para tu agencia.
                <br />
                Podés volver a cada trabajo cuando quieras.
              </p>
            </section>
          )}
          {work?.messages.map((m) => (
            <article key={m.id} className={`message ${m.role}`}>
              <h2>{m.role === "user" ? "Vos" : "Bitácora"}</h2>
              <div>{m.text}</div>
            </article>
          ))}
          <div ref={bottom} />
        </div>
        <div className="compose-area">
          <p className="progress" role="status">
            {work?.busy
              ? work.progress
              : work?.progress ||
                (state.account.connected
                  ? "Todo listo para empezar."
                  : "Conectá tu cuenta de ChatGPT para empezar.")}
          </p>
          {(problem || work?.problem) && (
            <p className="problem" role="alert">
              {problem?.text || work?.problem}
            </p>
          )}
          {(work?.details || problem?.detail) && (
            <details>
              <summary>Ver detalle</summary>
              <pre>
                {problem?.detail}
                {work?.details}
              </pre>
            </details>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (
                !text.trim() ||
                busy ||
                pending ||
                !online ||
                !state.account.connected
              )
                return;
              setPending(true);
              send({ type: "send", workId: selected, text });
            }}
          >
            <label htmlFor="request">Tu pedido</label>
            <textarea
              id="request"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={20000}
              placeholder="Por ejemplo: ayudame a organizar una propuesta de viaje…"
              rows={3}
            />
            <footer>
              <span>
                {!online
                  ? "Esperando la conexión con Bitácora."
                  : busy
                    ? "Podés pausar el pedido en curso."
                    : "Escribí con tus palabras."}
              </span>
              {busy ? (
                <button
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
                  className="primary"
                  disabled={
                    !online ||
                    !state.account.connected ||
                    pending ||
                    !text.trim()
                  }
                  type="submit"
                >
                  {pending ? "Enviando…" : "Enviar pedido"}
                </button>
              )}
            </footer>
          </form>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
