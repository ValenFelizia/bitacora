// Deterministic app-server peer. No Codex, credentials, tools, or inference.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method, params) => send({ method, params });
const setupFile = process.env.CODEX_HOME + "/fake-protection";
let configuredMode = existsSync(setupFile) ? readFileSync(setupFile, "utf8") : null;
const threadId = "thread-1";
let interrupts = 0;
let interruptHangs = false;
let interruptRejects = false;
let crashScheduled = false;
if (process.env.BITACORA_FAKE_PID)
  appendFileSync(process.env.BITACORA_FAKE_PID, `${process.pid}\n`);
// The arguments this process was started with: the engine picks them from the
// sandbox mode, so a test can tell which mode each process was spawned for.
if (process.env.BITACORA_FAKE_SPAWN)
  appendFileSync(
    process.env.BITACORA_FAKE_SPAWN,
    JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\n",
  );
const turn = (status = "inProgress") => ({ id: "turn-1", status, error: null });
// The profile a thread reports back. `BITACORA_FAKE_THREAD_PROFILE=none` is an
// engine that ignored the request and would run with the default profile;
// `other` is an engine that reports a different profile. A real app-server
// reports the profile the request asked for, and none when the thread runs
// with a plain sandbox policy.
const activeProfile = (params) => {
  const reported = process.env.BITACORA_FAKE_THREAD_PROFILE;
  if (reported === "none") return null;
  if (reported === "other") return { id: ":workspace", extends: null };
  return params && params.permissions
    ? { id: params.permissions, extends: ":workspace" }
    : null;
};
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
        // `BITACORA_FAKE_READ_FAIL_ONCE` fails only for the first process that
        // asks, so a test can make the startup check fail and the retry work.
        if (process.env.BITACORA_FAKE_READ_FAIL_ONCE && !existsSync(setupFile + ".read-failed")) {
          writeFileSync(setupFile + ".read-failed", "1");
          send({ id: m.id, error: { message: "read failed" } });
          break;
        }
        if (process.env.BITACORA_FAKE_READ_FAIL) { send({ id: m.id, error: { message: "read failed" } }); break; }
        reply({ status: configuredMode ? "ready" : process.env.BITACORA_FAKE_SAFETY || "ready" });
        break;
      case "permissionProfile/list": {
        // The read-restricting profile the app sends on every turn. A fake that
        // refuses it must never be trusted to run work.
        const refusal = process.env.BITACORA_FAKE_PROFILE;
        if (refusal === "error") { send({ id: m.id, error: { code: -32601, message: "method not found" } }); break; }
        const data = [{ id: ":workspace", description: null, allowed: true }];
        if (refusal !== "missing") data.push({ id: "agencia", description: null, allowed: refusal !== "denied" });
        reply({ data, nextCursor: null });
        break;
      }
      case "command/exec":
        // The app runs one harmless command under the profile to know whether
        // this machine can really use it.
        if (process.env.BITACORA_FAKE_PROFILE_EXEC === "refuse")
          send({ id: m.id, error: { code: -32603, message: "exec failed: windows sandbox: elevated Windows sandbox requires effective `:root` read access" } });
        else reply({ exitCode: 0, stdout: "BITACORA_PROFILE_OK\r\n", stderr: "" });
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
        reply({ thread: { id: threadId }, activePermissionProfile: activeProfile(m.params) });
        break;
      case "thread/resume":
        reply({ thread: { id: threadId }, activePermissionProfile: activeProfile(m.params) });
        break;
      case "thread/sample": {
        // The cheap title request. `BITACORA_FAKE_SAMPLE` picks the answer:
        // `none` is a sample that only produced a tool call, `error` a failed
        // request and `idle` a source that was still closing (the app retries).
        const mode = process.env.BITACORA_FAKE_SAMPLE;
        if (mode === "error") { send({ id: m.id, error: { message: "sample failed" } }); break; }
        if (mode === "idle" && !existsSync(setupFile + ".idle-once")) {
          writeFileSync(setupFile + ".idle-once", "1");
          send({ id: m.id, error: { code: -32600, message: "sample source must be idle" } });
          break;
        }
        reply({
          sourceTurnId: m.params.expectedTurnId,
          responseId: "sample-1",
          text: mode === "none" ? null : !mode || mode === "idle" ? "Porto de Galinhas, febrero" : mode,
          inputTokens: 1200,
          cachedInputTokens: 1000,
          outputTokens: 12,
        });
        break;
      }
      case "thread/name/set":
        reply({});
        notify("thread/name/updated", { threadId: m.params.threadId, threadName: m.params.name });
        break;
      case "turn/interrupt":
        if (interruptRejects) send({ id: m.id, error: { message: "interrupt refused" } });
        else if (++interrupts > 1) send({ id: m.id, error: { message: "already interrupted" } });
        else {
          reply({});
          if (!interruptHangs) setTimeout(() => notify("turn/completed", { threadId, turn: turn("interrupted") }), 140);
        }
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
        if (scenario === "slow-start-pause") {
          // The turn starts and its reply never arrives; only a pause ends it.
          notify("turn/started", { threadId, turn: turn() });
          break;
        }
        if (scenario === "complete-before-reply") {
          // The turn ends before its reply: nothing is running any more.
          notify("turn/completed", { threadId, turn: turn("completed") });
          setTimeout(() => reply({ turn: turn("completed") }), Number(process.env.BITACORA_FAKE_TURN_DELAY || 80));
          break;
        }
        if (scenario === "silent-start") {
          // No reply and no turn/started: nothing proves the turn is running.
          break;
        }
        if (scenario === "error-after-timeout") {
          // The reply arrives after the turn/start deadline, as an error.
          setTimeout(() => send({ id: m.id, error: { message: "late failure" } }), Number(process.env.BITACORA_FAKE_TURN_DELAY || 400));
          break;
        }
        if (scenario === "pause-hang") {
          // The turn starts and the pause is accepted, but it never ends.
          interruptHangs = true;
          notify("turn/started", { threadId, turn: turn() });
          reply({ turn: turn() });
          break;
        }
        if (scenario === "pause-refused") {
          // The reply comes late, with the turn running, and the pause fails.
          interruptRejects = true;
          setTimeout(() => reply({ turn: turn() }), 80);
          break;
        }
        if (scenario === "spawn-child") {
          // The turn runs a command that outlives the app-server unless the
          // whole tree is killed. It ends on its own after a while so a failed
          // test cannot leave it running forever.
          const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1e9)"], { stdio: "ignore", windowsHide: true });
          if (process.env.BITACORA_FAKE_CHILD_PID)
            writeFileSync(process.env.BITACORA_FAKE_CHILD_PID, String(child.pid));
          break;
        }
        if (scenario === "pause" || scenario === "pause-started") setTimeout(() => reply({ turn: turn() }), 80);
        else reply({ turn: turn() });
        break;
      }
    }
  })
  .on("close", () => process.exit());
