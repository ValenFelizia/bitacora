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

export async function serve(
  engine: Engine,
  data: string,
  port = 4317,
  webOrigin = "http://127.0.0.1:5173",
  workspace?: string,
  desktop?: { webRoot: string; kitSource: string },
) {
  const sendAsset = desktop && await desktopAssets(desktop.webRoot);
  const files = workspace ? new WorkspaceFiles(workspace) : undefined;
  const token = randomBytes(32).toString("hex");
  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (!localHost(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) {
        res.writeHead(403); res.end(); return;
      }
      if (sendAsset && sendAsset(url.pathname, req.method, res, boundPort())) return;
      const supplied = url.searchParams.get("token") || "";
      const validToken = Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
      if (!validToken) {
        res.writeHead(403); res.end(); return;
      }
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
  const sockets = new WebSocketServer({ noServer: true, maxPayload: Math.ceil(MAX_REQUEST / 3) * 4 + 100000 });
  const send = (ws: WebSocket, message: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message.type === "snapshot" ? { ...message, state: { ...message.state, fileToken: token } } : message));
  };
  const app = new App(engine, data, (message) => {
    for (const ws of sockets.clients) send(ws, message);
  }, undefined, files, desktop?.kitSource);
  const origins = new Set(desktop ? [] : [webOrigin]);
  const configured = new URL(webOrigin);
  if (!desktop && ["127.0.0.1", "localhost"].includes(configured.hostname)) {
    const alias = new URL(webOrigin);
    alias.hostname =
      configured.hostname === "localhost" ? "127.0.0.1" : "localhost";
    origins.add(alias.origin);
  }
  http.on("upgrade", (req, socket, head) => {
    // A public site must not be able to operate a local agent through the browser.
    if (
      !origins.has(req.headers.origin || "") ||
      !localHost(req.headers.host) ||
      req.url !== "/ws"
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
    send(ws, { type: "snapshot", state: app.snapshot() });
    ws.on("message", (data) => {
      void (async () => {
        try {
          const command = JSON.parse(String(data)) as ClientCommand;
          if (
            !command ||
            !["discardUndo", "undo", "connect", "retry", "prepareProtection", "send", "rename", "interrupt"].includes(command.type)
          )
            throw new Error("Invalid message");
          await app.command(command, (message) => send(ws, message));
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
    await app.start();
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "127.0.0.1", () => {
        if (desktop) origins.add(`http://127.0.0.1:${boundPort()}`);
        resolve();
      });
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    // Local lifecycle handle; never serialized or exposed over HTTP/WebSocket.
    app,
    port: boundPort(),
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await app.close();
    },
  };
}
