// Deterministic app-server peer. No Codex, credentials, tools, or inference.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method, params) => send({ method, params });
const threadId = "thread-1";
const turn = (status = "inProgress") => ({ id: "turn-1", status, error: null });
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const m = JSON.parse(line);
    if (process.env.BITACORA_FAKE_LOG)
      appendFileSync(process.env.BITACORA_FAKE_LOG, JSON.stringify(m) + "\n");
    if (!m.method) return;
    const reply = (result) => send({ id: m.id, result });
    switch (m.method) {
      case "initialize":
        reply({ userAgent: "fake" });
        break;
      case "windowsSandbox/readiness":
        reply({ status: process.env.BITACORA_FAKE_SAFETY || "ready" });
        break;
      case "config/read":
        reply({ config: { windows: { sandbox: "unelevated" } } });
        break;
      case "account/read":
      reply({ account: process.env.BITACORA_FAKE_DISCONNECTED ? null : { type: "chatgpt", email: "fake@example.test" } });
        break;
      case "account/login/start":
        reply({
          type: "chatgpt",
          loginId: "login",
          authUrl: "https://example.test/login",
        });
        break;
      case "thread/start":
        reply({ thread: { id: threadId } });
        break;
      case "thread/resume":
        reply({ thread: { id: threadId } });
        break;
      case "turn/interrupt":
        reply({});
        notify("turn/completed", { threadId, turn: turn("interrupted") });
        break;
      case "turn/start": {
        const scenario = m.params.input[0].text;
        if (scenario === "crash") {
          process.exit(3);
        }
        if (scenario === "environment")
          notify("item/commandExecution/outputDelta", {
            threadId,
            delta: JSON.stringify(process.env),
          });
        if (scenario === "events") {
          for (const item of [
            { type: "commandExecution", commandActions: [{ type: "read" }] },
            { type: "commandExecution", commandActions: [{ type: "unknown" }] },
            { type: "fileChange" },
            { type: "mcpToolCall" },
          ])
            notify("item/started", { threadId, item: { id: "item", ...item } });
          send({
            id: "server-request",
            method: "item/tool/requestUserInput",
            params: {},
          });
          notify("error", {
            threadId,
            willRetry: true,
            error: { message: "transient" },
          });
          notify("error", {
            threadId,
            willRetry: false,
            error: { message: "final" },
          });
          notify("turn/completed", {
            threadId,
            turn: { ...turn("failed"), error: { message: "final" } },
          });
        }
        if (scenario === "race")
          notify("turn/completed", { threadId, turn: turn("completed") });
        if (scenario === "pause") setTimeout(() => reply({ turn: turn() }), 80);
        else reply({ turn: turn() });
        break;
      }
    }
  })
  .on("close", () => process.exit());
