import { pipeline } from "node:stream/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WorkspaceFiles, FileProblem, MAX_REQUEST } from "./workspace-files";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Engine } from "./engine";
import { problemText, EngineFailure } from "./engine";
import type { ClientCommand, ServerMessage } from "./contracts";
import { App } from "./app";
import { desktopAssets } from "./desktop-assets";
import { DICTATION_PATH } from "./dictation";
import { handleDictation } from "./dictation-http";
import { WorkspaceProblem, type WorkspaceChoice, type WorkspaceSelection } from "./workspace-selection";
import { DEV_SESSION_PATH, isScreenSecret, SCREEN_PROTOCOL } from "./screen-session";

export async function serve(
  engine: Engine,
  data: string,
  port = 4317,
  webOrigin = "http://127.0.0.1:5173",
  workspace?: string,
  desktop?: { webRoot: string; kitSource: string },
  screenSecret = randomBytes(32).toString("hex"),
  folders?: {
    selection: WorkspaceSelection;
    initial: WorkspaceChoice;
    notice?: string;
    engineFor: (choice: WorkspaceChoice) => Engine;
  },
) {
  if (!isScreenSecret(screenSecret)) throw new Error("Invalid screen session");
  const expectedSecret = Buffer.from(screenSecret, "hex");
  const authenticates = (supplied: string | undefined) =>
    isScreenSecret(supplied) && timingSafeEqual(Buffer.from(supplied, "hex"), expectedSecret);
  const sendAsset = desktop && await desktopAssets(desktop.webRoot);
  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (!localHost(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) {
        res.writeHead(403); res.end(); return;
      }
      if (sendAsset && sendAsset(url.pathname, req.method, res, boundPort())) return;
      if (sendAsset && url.pathname !== "/files" && url.pathname !== DICTATION_PATH) {
        res.writeHead(404); res.end(); return;
      }
      // Vite proxies this development-only bootstrap through its existing /ws route.
      if (!desktop && url.pathname === DEV_SESSION_PATH && req.method === "POST" &&
          origins.has(req.headers.origin || "")) {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(screenSecret);
        return;
      }
      if (!authenticates(req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1])) {
        res.writeHead(403); res.end(); return;
      }
      if (url.pathname === DICTATION_PATH && req.method === "POST") {
        await handleDictation(req, res, active.engine);
        return;
      }
      const { app, files } = active;
      if (url.pathname !== "/files" || !["GET", "HEAD"].includes(req.method || "") || !files) { res.writeHead(404); res.end(); return; }
      const ref = app.file(url.searchParams.get("id") || "");
      if (!ref || ref.reverted) { res.writeHead(404); res.end(); return; }
      const { handle, size } = await files.openResult(ref);
      try {
        res.writeHead(200, {
          "Content-Type": ref.mime,
          "Content-Length": size,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Security-Policy": `default-src 'none'${ref.mime === "application/pdf" ? "" : "; sandbox"}`,
          "Content-Disposition": `${url.searchParams.has("download") || ref.mime === "text/plain" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(ref.name).replace(/'/g, "%27")}`,
        });
        if (req.method === 'HEAD' || !size) res.end();
        else await pipeline(handle.createReadStream({ start: 0, end: size - 1, autoClose: false }), res);
      } finally { await handle.close(); }
    })().catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(error instanceof FileProblem ? 413 : 404); res.end();
    });
  });
  const boundPort = () => (http.address() as { port: number }).port;
  const localHost = (host?: string) => host === `127.0.0.1:${boundPort()}` ||
    (!desktop && host === `localhost:${boundPort()}`);
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: Math.ceil(MAX_REQUEST / 3) * 4 + 100000,
    handleProtocols: () => SCREEN_PROTOCOL,
  });
  const send = (ws: WebSocket, message: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const broadcast = (message: ServerMessage) => {
    for (const ws of sockets.clients) send(ws, message);
  };
  function runtime(engine: Engine, workspace?: string, choice?: WorkspaceChoice, notice?: string) {
    const files = workspace ? new WorkspaceFiles(workspace) : undefined;
    const app: App = new App(engine, choice?.data ?? data, (message) => {
      if (active.app === app) broadcast(message);
    }, undefined, files, desktop?.kitSource, choice && folders && {
      preferenceData: folders.selection.data,
      key: choice.key,
      notice,
    });
    return { app, engine, files, choice };
  }

  let active = runtime(engine, workspace, folders?.initial, folders?.notice);
  let commands = 0;
  let switching: Promise<void> | undefined;
  let closing = false;

  async function chooseWorkspace(path: unknown, reply: (message: ServerMessage) => void) {
    if (!folders || !active.choice) throw new Error("Workspace choice unavailable");
    if (closing || switching || commands || active.app.workspaceBusy)
      throw new WorkspaceProblem("Esperá a que termine el pedido actual o pausalo para cambiar de carpeta.");

    const previous = active;
    const previousChoice = active.choice;
    switching = (async () => {
      const choice = await folders.selection.validate(path);
      if (choice.root === previousChoice.root) return;

      const next = runtime(folders.engineFor(choice), choice.root, choice);
      try {
        await previous.app.flushWorks();
        await next.app.initialize(true);
      } catch (error) {
        throw new WorkspaceProblem("No pude preparar esa carpeta. Probá de nuevo o elegí otra.", { cause: error });
      }

      if (previous.app.workspaceBusy)
        throw new WorkspaceProblem("Esperá a que termine el pedido actual o pausalo para cambiar de carpeta.");
      await previous.app.close(true);
      try {
        await folders.selection.save(choice);
      } catch (error) {
        if (!closing) {
          active = { ...previous, engine: folders.engineFor(previousChoice) };
          void active.app.restartEngine(active.engine);
        }
        throw new WorkspaceProblem("No pude guardar el cambio de carpeta. Probá de nuevo.", { cause: error });
      }

      active = next;
      broadcast({ type: "snapshot", state: next.app.snapshot() });
      if (!closing) void next.app.startEngine(true);
    })();
    try {
      await switching;
      reply({ type: "workspaceChoice" });
    } finally {
      switching = undefined;
    }
  }
  const origins = new Set(desktop ? [] : [webOrigin]);
  const configured = new URL(webOrigin);
  if (!desktop && ["127.0.0.1", "localhost"].includes(configured.hostname)) {
    const alias = new URL(webOrigin);
    alias.hostname =
      configured.hostname === "localhost" ? "127.0.0.1" : "localhost";
    origins.add(alias.origin);
  }
  http.on("upgrade", (req, socket, head) => {
    const protocols = req.headers["sec-websocket-protocol"]?.split(",").map((part) => part.trim());
    if (
      !origins.has(req.headers.origin || "") ||
      !localHost(req.headers.host) ||
      req.url !== "/ws" ||
      protocols?.length !== 2 ||
      protocols[0] !== SCREEN_PROTOCOL ||
      !authenticates(protocols[1])
    ) {
      socket.on("error", () => {});
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) =>
      sockets.emit("connection", ws, req),
    );
  });
  sockets.on("connection", (ws) => {
    ws.on("error", () => ws.terminate());
    send(ws, { type: "snapshot", state: active.app.snapshot() });
    ws.on("message", (data) => {
      void (async () => {
        try {
          const command = JSON.parse(String(data)) as ClientCommand & { workspace?: string };
          if (
            !command ||
            !["chooseWorkspace", "discardUndo", "undo", "connect", "retry", "prepareProtection", "send", "rename", "interrupt", "answer", "skipQuestion", "chooseModel", "refreshModels", "panelWidth", "welcome", "skipWelcome", "markOpened"].includes(command.type)
          )
            throw new Error("Invalid message");
          const stale = folders && command.workspace !== active.choice?.root;
          if (command.type === "chooseWorkspace") {
            try {
              if (stale) throw new WorkspaceProblem("La carpeta de trabajo cambió. Probá de nuevo.");
              await chooseWorkspace(command.path, (message) => send(ws, message));
            }
            catch (error) {
              send(ws, {
                type: "workspaceChoice",
                problem: error instanceof WorkspaceProblem
                  ? error.message
                  : "No pude cambiar de carpeta. Volvé a abrir Bitácora y probá de nuevo.",
              });
              send(ws, { type: "snapshot", state: active.app.snapshot() });
            }
            return;
          }
          if (closing || switching || stale) {
            send(ws, { type: "problem", text: "La carpeta de trabajo está cambiando. Probá de nuevo en un momento." });
            return;
          }
          commands++;
          try { await active.app.command(command, (message) => send(ws, message)); }
          finally { commands--; }
        } catch (error) {
          send(ws, {
            type: "problem",
            text: error instanceof FileProblem ? error.message : problemText(
              error instanceof EngineFailure ? error.kind : "other",
            ),
            detail: String(error),
          });
        }
      })();
    });
  });
  try {
    if (desktop) await active.app.initialize();
    else await active.app.start();
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "127.0.0.1", () => {
        if (desktop) origins.add(`http://127.0.0.1:${boundPort()}`);
        resolve();
      });
    });
  } catch (error) {
    await active.app.close();
    throw error;
  }
  return {
    // Local lifecycle handle; never serialized or exposed over HTTP/WebSocket.
    get app() { return active.app; },
    async startEngine() {
      const initial = active;
      try { await initial.app.startEngine(); }
      catch (error) {
        if (switching) await switching.catch(() => {});
        if (initial === active && !closing) throw error;
      }
    },
    port: boundPort(),
    async close() {
      closing = true;
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await switching?.catch(() => {});
      await active.app.close();
    },
  };
}
