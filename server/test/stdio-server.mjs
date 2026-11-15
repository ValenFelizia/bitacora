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
    if (!m.method) {
      if (String(m.id).startsWith('interactive-')) {
        if (!m.result && !m.error) process.exit(5);
        if (m.id === 'interactive-9') notify('turn/completed', { threadId, turn: turn('completed') });
      }
      return;
    }
    const reply = (result) => send({ id: m.id, result });
    switch (m.method) {
      case "initialize":
        reply({ userAgent: "fake" });
        break;
      case "windowsSandbox/readiness":
        if (process.env.BITACORA_FAKE_READ_FAIL) { send({ id: m.id, error: { message: "read failed" } }); break; }
        reply({ status: configuredMode ? "ready" : process.env.BITACORA_FAKE_SAFETY || "ready" });
        break;
      case "config/read":
        reply({ config: { windows: { sandbox: configuredMode || (process.env.BITACORA_FAKE_MODE || (process.env.BITACORA_FAKE_SAFETY ? null : "elevated")) } } });
        break;
      case "config/value/write":
        configuredMode = m.params.value;
        writeFileSync(setupFile, configuredMode);
        setTimeout(() => reply({}), Number(process.env.BITACORA_FAKE_CONFIG_DELAY || 0));
        break;
      case "windowsSandbox/setupStart":
        if (process.env.BITACORA_FAKE_SETUP_TIMEOUT) break;
        if (process.env.BITACORA_FAKE_SETUP_INTERRUPTED && !existsSync(setupFile + ".interrupted")) { writeFileSync(setupFile + ".interrupted", "1"); reply({ started: true }); setTimeout(() => process.exit(3), 40); break; }
        reply({ started: true });
        setTimeout(() => {
          const success = !process.env.BITACORA_FAKE_SETUP_FAIL;
          if (success) writeFileSync(setupFile, "elevated");
          if (process.env.BITACORA_FAKE_SETUP_CRASH) process.exit(3);
          notify("windowsSandbox/setupCompleted", { mode: m.params.mode, success, error: success ? null : "UAC cancelled" });
        }, Number(process.env.BITACORA_FAKE_SETUP_DELAY || 100));
        break;
      case "account/read":
        if (existsSync(setupFile + ".hang")) break;
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
      case "account/login/cancel":
        setTimeout(() => reply({}), Number(process.env.BITACORA_FAKE_LOGIN_CANCEL_DELAY || 0));
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
        if (scenario === "interactive") {
          ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/tool/call', 'execCommandApproval', 'applyPatchApproval', 'account/chatgptAuthTokens/refresh', 'unknown/request'].forEach((method, i) => send({ id: `interactive-${i}`, method, params: {} }));
        }
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
        if (scenario === "markdown") {
          notify("item/completed", { threadId, item: { type: "agentMessage", id: "markdown", text: "Creé **hola.txt**.\n\n- Una *prueba*\n- Código: `hola`\n\n```txt\nHola, mundo\n```\n\n[Enlace](https://example.test)\n\n<script>alert('raw')</script>" } });
          notify("turn/completed", { threadId, turn: turn("completed") });
        }
        if (scenario === "race")
          notify("turn/completed", { threadId, turn: turn("completed") });
        if (scenario === "pause-started") notify("turn/started", { threadId, turn: turn() });
        if (scenario === "slow-start") {
          // The turn starts, its reply is late, and it ends on its own.
          notify("turn/started", { threadId, turn: turn() });
          setTimeout(() => {
            reply({ turn: turn() });
            notify("turn/completed", { threadId, turn: turn("completed") });
          }, Number(process.env.BITACORA_FAKE_TURN_DELAY || 80));
          break;
        }
        if (scenario === "pause" || scenario === "pause-started") setTimeout(() => reply({ turn: turn() }), 80);
        else reply({ turn: turn() });
        break;
      }
    }
  })
  .on("close", () => process.exit());
