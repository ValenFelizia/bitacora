// Deterministic app-server peer. No Codex, credentials, tools, or inference.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method, params) => send({ method, params });
const setupFile = process.env.CODEX_HOME + "/fake-protection";
let configuredMode = existsSync(setupFile) ? readFileSync(setupFile, "utf8") : null;
const threadId = "thread-1";
let interrupts = 0;
let crashScheduled = false;
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
        reply({ status: configuredMode ? "ready" : process.env.BITACORA_FAKE_SAFETY || "ready" });
        break;
      case "config/read":
        reply({ config: { windows: { sandbox: configuredMode || (process.env.BITACORA_FAKE_SAFETY ? null : "elevated") } } });
        break;
      case "config/value/write":
        configuredMode = m.params.value;
        writeFileSync(setupFile, configuredMode);
        reply({});
        break;
      case "windowsSandbox/setupStart":
        reply({ started: true });
        setTimeout(() => {
          const success = !process.env.BITACORA_FAKE_SETUP_FAIL;
          if (success) writeFileSync(setupFile, "elevated");
          if (process.env.BITACORA_FAKE_SETUP_CRASH) process.exit(3);
          notify("windowsSandbox/setupCompleted", { mode: m.params.mode, success, error: success ? null : "UAC cancelled" });
        }, Number(process.env.BITACORA_FAKE_SETUP_DELAY || 100));
        break;
      case "account/read":
        if (process.env.BITACORA_FAKE_IDLE_CRASH && !crashScheduled) {
          crashScheduled = true;
          setTimeout(() => process.exit(3), 2000);
        }
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
        if (++interrupts > 1) send({ id: m.id, error: { message: "already interrupted" } });
        else { reply({}); setTimeout(() => notify("turn/completed", { threadId, turn: turn("interrupted") }), 140); }
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
        if (scenario === "pause-started") notify("turn/started", { threadId, turn: turn() });
        if (scenario === "pause" || scenario === "pause-started") setTimeout(() => reply({ turn: turn() }), 80);
        else reply({ turn: turn() });
        break;
      }
    }
  })
  .on("close", () => process.exit());
