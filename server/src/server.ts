import { pipeline } from "node:stream/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WorkspaceFiles, FileProblem, MAX_REQUEST } from "./workspace-files";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Engine } from "./engine";
import { problemText, EngineFailure } from "./engine";
import type { ClientCommand, ServerMessage } from "./contracts";
import { App } from "./app";

export async function serve(
  engine: Engine,
  data: string,
  port = 4317,
  webOrigin = "http://127.0.0.1:5173",
  workspace?: string,
) {
  const files = workspace ? new WorkspaceFiles(workspace) : undefined;
  const token = randomBytes(32).toString("hex");
  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const supplied = url.searchParams.get("token") || "";
      const validToken = Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
      if (!validToken || !localHost(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) {
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
  const localHost = (host?: string) => [`127.0.0.1:${(http.address() as { port: number }).port}`, `localhost:${(http.address() as { port: number }).port}`].includes(host || "");
  const sockets = new WebSocketServer({ noServer: true, maxPayload: Math.ceil(MAX_REQUEST / 3) * 4 + 100000 });
  const send = (ws: WebSocket, message: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message.type === "snapshot" ? { ...message, state: { ...message.state, fileToken: token } } : message));
  };
  const app = new App(engine, data, (message) => {
    for (const ws of sockets.clients) send(ws, message);
  }, undefined, files);
  const origins = new Set([webOrigin]);
  const configured = new URL(webOrigin);
  if (["127.0.0.1", "localhost"].includes(configured.hostname)) {
    const alias = new URL(webOrigin);
    alias.hostname =
      configured.hostname === "localhost" ? "127.0.0.1" : "localhost";
    origins.add(alias.origin);
  }
  http.on("upgrade", (req, socket, head) => {
    // A public site must not be able to operate a local agent through the browser.
    if (
      !origins.has(req.headers.origin || "") ||
      ![
        `127.0.0.1:${(http.address() as { port: number }).port}`,
        `localhost:${(http.address() as { port: number }).port}`,
      ].includes(req.headers.host || "") ||
      req.url !== "/ws"
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) =>
      sockets.emit("connection", ws, req),
    );
  });
  sockets.on("connection", (ws) => {
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
      http.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    // Local lifecycle handle; never serialized or exposed over HTTP/WebSocket.
    app,
    port: (http.address() as { port: number }).port,
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await app.close();
    },
  };
}
