import { pipeline } from "node:stream/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WorkspaceFiles, FileProblem, MAX_REQUEST } from "./workspace-files";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Engine } from "./engine";
import { problemText, EngineFailure } from "./engine";
import { TEMPLATES_PATH, type ClientCommand, type ServerMessage } from "./contracts";
import { Templates } from "./templates";
import { AgencyFiles } from "./tools/paths";
import { handleTemplates, templateReply } from "./templates-http";
import { App } from "./app";
import type { CodexHistory } from "./codex/history";
import { HistoryProblem } from "./codex/history-snapshot";
import { desktopAssets } from "./desktop-assets";
import { DICTATION_PATH } from "./dictation";
import { handleDictation } from "./dictation-http";
import { SAVED_FOLDER_UNAVAILABLE, WorkspaceProblem, type WorkspaceChoice, type WorkspaceSelection } from "./workspace-selection";
import { DEV_SESSION_PATH, isScreenSecret, SCREEN_PROTOCOL } from "./screen-session";

const SHUTDOWN_PROBLEM =
  "No pude cambiar de carpeta porque algo de lo que estaba haciendo acá sigue abierto. Lo sigo intentando cerrar. Cuando termine, elegí la carpeta de nuevo.";

const UPDATING_PROBLEM = "Bitácora se está actualizando. Esperá a que termine para hacer cambios.";

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
    /** Wait between background checks for an engine that did not stop. */
    recoveryDelayMs?: number;
  },
  codexHistory?: CodexHistory,
  templatesFor?: (files: AgencyFiles) => Templates,
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
      if (sendAsset && url.pathname !== "/files" && url.pathname !== DICTATION_PATH && url.pathname !== TEMPLATES_PATH) {
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
        if (closing || updating) {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(updating ? UPDATING_PROBLEM : undefined);
          return;
        }
        commands++;
        try { await handleDictation(req, res, active.engine); }
        finally { commands--; }
        return;
      }
      if (url.pathname === TEMPLATES_PATH) {
        const { app, files, templates } = active;
        if (closing || switching || !templates || files?.root !== url.searchParams.get("workspace")) {
          templateReply(res, 409, { error: "La carpeta de trabajo cambió. Probá de nuevo." });
          return;
        }
        const writing = req.method === "POST";
        // A preview launches Edge against this folder. Count it so a folder
        // change cannot start while that read is still open.
        const previewing = req.method === "GET" && url.searchParams.has("preview") && url.searchParams.get("file") !== null;
        if (writing && (updating || commands || app.workspaceBusy || app.undoPending)) {
          templateReply(res, 409, { error: "Esperá a que termine lo que está en curso para cambiar las plantillas." });
          return;
        }
        if (writing) templateWriting = true;
        if (writing || previewing) commands++;
        try { await handleTemplates(req, res, url, templates, () => app.filesChanged()); }
        finally {
          if (writing) templateWriting = false;
          if (writing || previewing) commands--;
        }
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
    }, codexHistory);
    return {
      app, engine, files, choice,
      templates: workspace ? (templatesFor ?? (agencyFiles => new Templates(agencyFiles)))(new AgencyFiles(workspace)) : undefined,
    };
  }

  let active = runtime(engine, workspace, folders?.initial, folders?.notice);
  let commands = 0;
  let templateWriting = false;
  let switching: Promise<void> | undefined;
  let closing = false;
  let updating = false;
  // Set while something the current engine started could not be confirmed
  // stopped: no other engine may start until it is gone.
  let shutdownPending = false;
  let pendingDefaultFallback = false;
  let recovery: Promise<void> | undefined;
  let recoveryTimer: NodeJS.Timeout | undefined;

  function reopenCurrent() {
    if (closing || !folders || !active.choice) return;
    active = { ...active, engine: folders.engineFor(active.choice) };
    void active.app.restartEngine(active.engine);
  }

  /**
   * Stops the current engine and everything it started, with bounded waits.
   * When something survives, the app stays on this folder without an engine,
   * says so, and keeps checking in the background until it is gone.
   */
  async function stopCurrent() {
    try {
      await active.app.close(true);
      shutdownPending = false;
    } catch (error) {
      shutdownPending = true;
      active.app.showShutdownProblem();
      scheduleRecovery();
      throw new WorkspaceProblem(SHUTDOWN_PROBLEM, { cause: error });
    }
  }

  function scheduleRecovery() {
    clearTimeout(recoveryTimer);
    if (closing || !folders) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      if (closing || !shutdownPending) return;
      if (switching || recovery) { scheduleRecovery(); return; }
      // A failed attempt schedules the next one from stopCurrent().
      void recoverShutdown().catch(() => {});
    }, folders.recoveryDelayMs ?? 3000);
    recoveryTimer.unref?.();
  }

  /**
   * Confirms that what the last engine left running is gone, then gives the
   * app a fresh engine: in the same folder, or in the default folder when the
   * saved one could not start. One attempt at a time.
   */
  function recoverShutdown() {
    recovery ??= (async () => {
      await stopCurrent();
      if (closing) return;
      if (pendingDefaultFallback) {
        await fallbackToDefault();
        pendingDefaultFallback = false;
        void active.app.startEngine(true);
      } else reopenCurrent();
    })().finally(() => { recovery = undefined; });
    return recovery;
  }

  /**
   * Opens the default folder when the saved one cannot start. The saved choice
   * is kept: a failure that goes away (a busy disk, a slow start) must not
   * make the person choose the folder again, and the next start that fails
   * lands here again instead of closing the app.
   */
  async function fallbackToDefault() {
    if (!folders) return;
    const choice = folders.selection.defaultChoice;
    const fallback = runtime(folders.engineFor(choice), choice.root, choice, SAVED_FOLDER_UNAVAILABLE);
    await fallback.app.initialize();
    active = fallback;
    broadcast({ type: "snapshot", state: active.app.snapshot() });
  }

  async function startEngine() {
    const initial = active;
    try { await initial.app.startEngine(); }
    catch (error) {
      if (switching) await switching.catch(() => {});
      if (initial !== active || closing) return;
      if (!initial.choice?.key) throw error;
      pendingDefaultFallback = true;
      switching = (async () => {
        try { await stopCurrent(); } catch { return; }
        if (closing) return;
        await fallbackToDefault();
        pendingDefaultFallback = false;
        if (!closing) await active.app.startEngine(true);
      })();
      try { await switching; } finally { switching = undefined; }
    }
  }

  async function chooseWorkspace(path: unknown, reply: (message: ServerMessage) => void) {
    if (!folders || !active.choice) throw new Error("Workspace choice unavailable");
    if (recovery)
      throw new WorkspaceProblem("Estoy terminando de cerrar lo que quedó abierto. Esperá un momento y probá de nuevo.");
    if (closing || switching || commands || active.app.workspaceBusy)
      throw new WorkspaceProblem("Esperá a que termine el pedido actual o pausalo para cambiar de carpeta.");

    const previous = active;
    const previousChoice = active.choice;
    switching = (async () => {
      const choice = await folders.selection.validate(path);
      if (choice.root === previousChoice.root) {
        if (shutdownPending) {
          // The person chose this folder again: stay here, not in the default.
          pendingDefaultFallback = false;
          await recoverShutdown();
        }
        // After a startup fallback the saved choice still names the folder
        // that failed; choosing the open one replaces it.
        try { await folders.selection.save(choice); }
        catch (error) {
          throw new WorkspaceProblem("No pude guardar el cambio de carpeta. Probá de nuevo.", { cause: error });
        }
        if (!closing) void active.app.checkCodexImportOffer();
        return;
      }

      const next = runtime(folders.engineFor(choice), choice.root, choice);
      try {
        await previous.app.flushWorks();
        await next.app.initialize(true);
      } catch (error) {
        throw new WorkspaceProblem("No pude preparar esa carpeta. Probá de nuevo o elegí otra.", { cause: error });
      }

      if (previous.app.workspaceBusy)
        throw new WorkspaceProblem("Esperá a que termine el pedido actual o pausalo para cambiar de carpeta.");
      // A delayed exit may settle during a second bounded drain. Keep ownership
      // of the old engine when it cannot yet be confirmed.
      await stopCurrent().catch(() => stopCurrent());
      try {
        await folders.selection.save(choice);
      } catch (error) {
        reopenCurrent();
        throw new WorkspaceProblem("No pude guardar el cambio de carpeta. Probá de nuevo.", { cause: error });
      }

      pendingDefaultFallback = false;
      active = next;
      broadcast({ type: "snapshot", state: next.app.snapshot() });
      if (!closing) {
        void next.app.startEngine(true);
        void next.app.checkCodexImportOffer();
      }
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
    let historyListing: AbortController | undefined;
    ws.on("close", () => historyListing?.abort());
    ws.on("error", () => ws.terminate());
    send(ws, { type: "snapshot", state: active.app.snapshot() });
    ws.on("message", (data) => {
      void (async () => {
        try {
          const command = JSON.parse(String(data)) as ClientCommand & { workspace?: string };
          if (
            !command ||
            ![
              "chooseWorkspace", "discardUndo", "undo", "connect", "retry",
              "prepareProtection", "send", "rename", "interrupt", "answer",
              "skipQuestion", "chooseModel", "refreshModels", "panelWidth",
              "welcome", "skipWelcome", "markOpened",
              "listCodexChats", "cancelCodexChatList", "importCodexChats", "dismissCodexImportOffer",
            ].includes(command.type)
          )
            throw new Error("Invalid message");
          const stale = folders && command.workspace !== active.choice?.root;
          if (command.type === "chooseWorkspace") {
            try {
              if (updating) throw new WorkspaceProblem(UPDATING_PROBLEM);
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
          if (command.type === "cancelCodexChatList") {
            historyListing?.abort();
            return;
          }
          if (updating || closing || switching || stale) {
            const text = updating ? UPDATING_PROBLEM : "La carpeta de trabajo está cambiando. Probá de nuevo en un momento.";
            if (command.type === "listCodexChats" || command.type === "importCodexChats")
              send(ws, { type: "codexImportProblem", text });
            else
              send(ws, { type: "problem", text });
            return;
          }
          if (templateWriting && ["send", "undo", "discardUndo"].includes(command.type)) {
            send(ws, { type: "problem", text: "Esperá a que termine el cambio de plantilla y probá de nuevo." });
            return;
          }
          if (command.type === "listCodexChats") {
            historyListing?.abort();
            historyListing = new AbortController();
          }
          commands++;
          try {
            if (command.type === "retry" && shutdownPending) {
              await recoverShutdown();
              return;
            }
            await active.app.command(
              command,
              (message) => send(ws, message),
              command.type === "listCodexChats" ? historyListing?.signal : undefined,
            );
          } finally { commands--; }
        } catch (error) {
          send(ws, {
            type: "problem",
            text: error instanceof FileProblem || error instanceof WorkspaceProblem || error instanceof HistoryProblem ? error.message : problemText(
              error instanceof EngineFailure ? error.kind : "other",
            ),
            detail: String(error),
          });
        }
      })();
    });
  });
  try {
    try { await active.app.initialize(!!active.choice?.key); }
    catch (error) {
      if (!active.choice?.key) throw error;
      await fallbackToDefault();
    }
    if (!desktop) await startEngine();
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
  async function close(requireStop = false) {
    closing = true;
    clearTimeout(recoveryTimer);
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    http.closeAllConnections?.();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await switching?.catch(() => {});
    await recovery?.catch(() => {});
    await active.app.close(requireStop);
  }
  return {
    // Local lifecycle handle; never serialized or exposed over HTTP/WebSocket.
    get app() { return active.app; },
    startEngine,
    port: boundPort(),
    close,
    beginUpdate() {
      // Reserve the server before downloading, in the same turn as the busy check.
      if (closing || updating || switching || recovery || commands ||
          active.app.workspaceBusy || !active.app.updateReady) return false;
      updating = true;
      return true;
    },
    cancelUpdate() { updating = false; },
    closeForUpdate() {
      if (!updating || closing) return undefined;
      return close(true);
    },
  };
}
