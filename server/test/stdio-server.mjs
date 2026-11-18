// Deterministic app-server peer. No Codex, credentials, tools, or inference.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync, readFileSync, renameSync } from "node:fs";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method, params) => send({ method, params });
const setupFile = process.env.CODEX_HOME + "/fake-protection";
let configuredMode = existsSync(setupFile) ? readFileSync(setupFile, "utf8") : null;
const threadId = "thread-1";
let interrupts = 0;
/**
 * Ids of the `request_user_input` requests waiting for the client, in order.
 * Like 0.168.0, the turn waits on every one of them.
 */
let waiting = [];
/** What the client answered in this turn, in order. */
let answered = [];
const questions = process.env.BITACORA_FAKE_QUESTIONS
  ? JSON.parse(process.env.BITACORA_FAKE_QUESTIONS)
  : [{
      id: "trato",
      header: "Trato",
      question: "¿Les hablás de vos o de usted?",
      isOther: true,
      isSecret: false,
      options: [
        { label: "Vos (Recommended)", description: "Más cercano, como en una charla." },
        { label: "Usted", description: "Más formal." },
      ],
    }];
const secondQuestions = [{
  id: "canal",
  header: "Canal",
  question: "¿Dónde lo mandás más?",
  isOther: true,
  isSecret: false,
  options: [
    { label: "WhatsApp", description: "Chats y estados." },
    { label: "Historias", description: "Instagram." },
  ],
}];
const ask = (id, asked) => {
  waiting.push(id);
  send({
    id,
    method: "item/tool/requestUserInput",
    params: { threadId, turnId: "turn-1", itemId: `call-${id}`, questions: asked, isBlocking: false, autoResolutionMs: null },
  });
};
/**
 * Ends the turn with questions still waiting, in the order 0.168.0 uses on a
 * pause: the turn ends first and then each request is resolved.
 */
const endWaiting = (status) => {
  const left = waiting;
  waiting = [];
  answered = [];
  notify("turn/completed", { threadId, turn: turn(status) });
  for (const requestId of left) notify("serverRequest/resolved", { threadId, requestId });
};
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
const fakeSkillsFile = process.env.BITACORA_FAKE_SKILLS_FILE;
let fakeSkills = process.env.BITACORA_FAKE_SKILLS
  ? JSON.parse(process.env.BITACORA_FAKE_SKILLS)
  : [];
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readTempFile = `${fakeSkillsFile || ""}.tmp-${process.pid}`;
// The test may be rewriting the file while the app-server reads it (a new skill
// that appears mid-session). Writes in the test are atomic, but Windows can
// still keep a handle for a moment: an empty or half-written file is read again
// after a wait, and if it stays unreadable the list answers with an error
// instead of the previous skills, which would hide the real state.
const readFakeSkills = async () => {
  if (!fakeSkillsFile || !existsSync(fakeSkillsFile)) return fakeSkills;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(readFileSync(fakeSkillsFile, "utf8"));
    } catch {
      // Try again: the writer is between renaming and closing the file.
      if (attempt < 2) await waitMs(20);
    }
  }
  throw new Error(`fake skills file is unreadable: ${fakeSkillsFile}`);
};
const writeFakeSkills = async (skills) => {
  fakeSkills = skills;
  if (!fakeSkillsFile) return;
  // Atomic on purpose: a reader must never see a half-written list. Windows can
  // keep the target open for a moment (the test reads it, or the indexer does),
  // so the replace is retried instead of failing the request.
  const body = JSON.stringify(skills);
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(readTempFile, body);
      renameSync(readTempFile, fakeSkillsFile);
      return;
    } catch (error) {
      lastError = error;
      await waitMs(10);
    }
  }
  throw lastError;
};
/** Lists asked in this process: the second one is the engine's verification. */
let skillLists = 0;
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
/** Queues messages so they are answered in arrival order. */
let queue = Promise.resolve();
createInterface({ input: process.stdin })
  .on("line", (line) => {
    // Messages are answered in arrival order even when one needs to wait for a
    // file to become readable: the queue keeps the protocol deterministic.
    queue = queue
      .then(() => handle(line))
      .catch((error) => process.stderr.write(`fake app-server: ${String(error)}\n`));
  })
  .on("close", () => process.exit());

async function handle(line) {
    const m = JSON.parse(line);
    if (process.env.BITACORA_FAKE_LOG)
      appendFileSync(process.env.BITACORA_FAKE_LOG, JSON.stringify(m) + "\n");
    if (!m.method) {
      if (waiting.includes(m.id)) {
        // The answer reaches the agent and the turn goes on, as in 0.168.0:
        // the request is resolved first, then the turn ends once nothing is
        // left waiting.
        waiting = waiting.filter((id) => id !== m.id);
        answered.push(m.result?.answers ?? null);
        notify("serverRequest/resolved", { threadId, requestId: m.id });
        // The tool's output as a `functionCallOutput` thread item (the shape in
        // `ThreadItem`): it carries the answers, secret ones included.
        notify("item/completed", {
          threadId,
          item: { type: "functionCallOutput", id: `output-${m.id}`, name: "request_user_input", namespace: null, output: JSON.stringify(m.result ?? null) },
        });
        if (!waiting.length) {
          // An agent that keeps a secret: it does not repeat it in its reply.
          const text = questions.some((q) => q.isSecret)
            ? "Recibí la respuesta."
            : `Recibí: ${answered.map((answers) => JSON.stringify(answers)).join(" y ")}`;
          answered = [];
          notify("item/completed", { threadId, item: { type: "agentMessage", id: `after-${m.id}`, text } });
          notify("turn/completed", { threadId, turn: turn("completed") });
        }
        return;
      }
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
      case "skills/list": {
        if (process.env.BITACORA_FAKE_SKILLS_HANG) break;
        // Hangs on the nth list of this process, so a test can make one pass run
        // out of time without hanging the next one.
        const listNumber = ++skillLists;
        if (process.env.BITACORA_FAKE_SKILLS_HANG_AT === String(listNumber)) break;
        if (process.env.BITACORA_FAKE_SKILLS_LIST_FAIL) {
          send({ id: m.id, error: { code: -32603, message: "skills list failed" } });
          break;
        }
        // The check the engine makes after writing: the second list of the
        // process can fail, never answer or come back without its skills. A test
        // can choose other lists with `BITACORA_FAKE_SKILLS_VERIFY_AT`.
        const verify = process.env.BITACORA_FAKE_SKILLS_VERIFY;
        const verifyAt = (process.env.BITACORA_FAKE_SKILLS_VERIFY_AT || "")
          .split(",")
          .filter(Boolean)
          .map(Number);
        const isVerify = verify && (verifyAt.length ? verifyAt.includes(listNumber) : listNumber === 2);
        if (isVerify) {
          if (verify === "fail") {
            send({ id: m.id, error: { code: -32603, message: "verify list failed" } });
            break;
          }
          if (verify === "hang") break;
          if (verify === "shape") {
            reply({ data: [{ cwd: m.params?.cwds?.[0] || "", errors: [] }] });
            break;
          }
        }
        // A list whose shape is not the one the engine expects: it must still
        // start and say so instead of failing the app. `BITACORA_FAKE_SKILLS_SHAPE_AT`
        // makes only the lists it names incomplete, so a test can mix a complete
        // list with one the engine cannot read.
        const shapeAt = (process.env.BITACORA_FAKE_SKILLS_SHAPE_AT || "")
          .split(",")
          .filter(Boolean)
          .map(Number);
        const shape = shapeAt.length
          ? (shapeAt.includes(listNumber) ? "skills" : "")
          : process.env.BITACORA_FAKE_SKILLS_SHAPE;
        if (shape === "missing") {
          reply({});
          break;
        }
        if (shape === "skills") {
          reply({ data: [{ cwd: m.params?.cwds?.[0] || "", errors: [] }] });
          break;
        }
        // A skill file the app-server could not read, reported with the list.
        const errors = process.env.BITACORA_FAKE_SKILL_ERRORS
          ? [{ path: process.env.BITACORA_FAKE_SKILL_ERRORS, message: "invalid front matter" }]
          : [];
        // A slow list: the engine must not take work for a list it has not
        // answered yet, nor refuse work that the protection already allows.
        let skills;
        try {
          skills = await readFakeSkills();
        } catch (error) {
          send({ id: m.id, error: { code: -32603, message: String(error) } });
          break;
        }
        // The same file, spelled with forward slashes: Windows reports it
        // either way, so the engine has to compare normalized paths.
        if (process.env.BITACORA_FAKE_SKILLS_RESPell && listNumber >= 2)
          skills = skills.map((skill) => ({ ...skill, path: skill.path.replace(/\\/g, "/") }));
        // A skill that is only in the verification list: it was never a target,
        // and it must still be named instead of counting as verified.
        const appeared = process.env.BITACORA_FAKE_SKILLS_ADD_ON_VERIFY;
        if (appeared && listNumber >= 2 && !skills.some((skill) => skill.name === appeared))
          skills = [
            ...skills,
            {
              name: appeared,
              description: "Apareció al verificar",
              path: `${process.env.CODEX_HOME}/skills/${appeared}/SKILL.md`.replaceAll("\\", "/"),
              scope: "user",
              enabled: true,
            },
          ];
        const answer = () =>
          reply({ data: [{ cwd: m.params?.cwds?.[0] || "", skills, errors }] });
        const delayMs = Number(process.env.BITACORA_FAKE_SKILLS_DELAY || 0);
        if (delayMs > 0) setTimeout(answer, delayMs);
        else answer();
        break;
      }
      case "skills/config/write": {
        // A slow answer: lets a test make one write eat most of the cycle's
        // deadline, so the retry has to fit in what is left.
        const delayMs = Number(process.env.BITACORA_FAKE_SKILL_WRITE_DELAY || 0);
        const later = (fn) => (delayMs > 0 ? setTimeout(fn, delayMs) : fn());
        // Fails only the first attempt for that path: a transient Windows lock
        // on `config.toml`, which the engine must retry once and not report.
        const failOncePath = process.env.BITACORA_FAKE_SKILL_WRITE_FAIL_ONCE;
        if (
          failOncePath &&
          (failOncePath === "*" || m.params?.path === failOncePath) &&
          !existsSync(setupFile + ".write-failed-once")
        ) {
          writeFileSync(setupFile + ".write-failed-once", "1");
          later(() => send({ id: m.id, error: { code: -32603, message: "failed to persist config" } }));
          break;
        }
        const failPath = process.env.BITACORA_FAKE_SKILL_WRITE_FAIL;
        if (failPath && (failPath === "*" || m.params?.path === failPath)) {
          later(() => send({ id: m.id, error: { code: -32603, message: "skills write failed" } }));
          break;
        }
        const keepEnabled = process.env.BITACORA_FAKE_SKILL_KEEP_ENABLED;
        if (keepEnabled && (keepEnabled === "*" || m.params?.path === keepEnabled)) {
          later(() => reply({ effectiveEnabled: true }));
          break;
        }
        let current;
        try {
          current = await readFakeSkills();
        } catch (error) {
          send({ id: m.id, error: { code: -32603, message: String(error) } });
          break;
        }
        for (const skill of current) {
          if ((m.params?.path && skill.path === m.params.path) || (m.params?.name && skill.name === m.params.name)) {
            skill.enabled = Boolean(m.params.enabled);
          }
        }
        try {
          await writeFakeSkills(current);
        } catch (error) {
          send({ id: m.id, error: { code: -32603, message: String(error) } });
          break;
        }
        reply({ effectiveEnabled: Boolean(m.params?.enabled) });
        break;
      }
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
        // A request that fails before the work exists: its skill notices must
        // not show up under the next work.
        if (process.env.BITACORA_FAKE_THREAD_START_FAIL_ONCE && !existsSync(setupFile + ".thread-failed")) {
          writeFileSync(setupFile + ".thread-failed", "1");
          send({ id: m.id, error: { code: -32603, message: "thread start failed" } });
          break;
        }
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
          // `BITACORA_FAKE_PAUSE_RELEASE` names a file: the pause only ends
          // when the test writes it, so the test decides when Codex confirms.
          const release = process.env.BITACORA_FAKE_PAUSE_RELEASE;
          if (release) {
            const timer = setInterval(() => {
              if (!existsSync(release)) return;
              clearInterval(timer);
              endWaiting("interrupted");
            }, 20);
          } else if (!interruptHangs) setTimeout(() => endWaiting("interrupted"), 140);
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
        if (scenario === "question" || scenario === "two-questions") {
          // The agent calls `request_user_input` and waits for the answer; in
          // `two-questions` it asks again before the first one is answered.
          reply({ turn: turn() });
          notify("turn/started", { threadId, turn: turn() });
          const stamp = Date.now();
          ask(`question-${stamp}-1`, questions);
          if (scenario === "two-questions") ask(`question-${stamp}-2`, secondQuestions);
          // The turn ends on its own while the question is still waiting.
          if (process.env.BITACORA_FAKE_QUESTION_ENDS) setTimeout(() => endWaiting("completed"), 100);
          break;
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
        if (scenario === "skills-changed") {
          // A skill appears while the turn runs, the way a folder dropped into
          // the workspace does: it is written and the app-server notifies.
          const added = {
            name: "added-mid-turn-skill",
            description: "Added while the turn runs",
            path: `${process.env.CODEX_HOME}/skills/added-mid-turn-skill/SKILL.md`.replaceAll("\\", "/"),
            scope: "user",
            enabled: true,
          };
          const current = await readFakeSkills();
          if (!current.some((skill) => skill.path === added.path)) await writeFakeSkills([...current, added]);
          notify("skills/changed", {});
          notify("turn/completed", { threadId, turn: turn("completed") });
        }
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
}
