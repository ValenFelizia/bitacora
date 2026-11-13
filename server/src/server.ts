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
) {
  const http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 100000 });
  const send = (ws: WebSocket, message: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const app = new App(engine, data, (message) => {
    for (const ws of sockets.clients) send(ws, message);
  });
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
            !["connect", "send", "interrupt"].includes(command.type)
          )
            throw new Error("Invalid message");
          await app.command(command, (message) => send(ws, message));
        } catch (error) {
          send(ws, {
            type: "problem",
            text: problemText(
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
    port: (http.address() as { port: number }).port,
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await app.close();
    },
  };
}
