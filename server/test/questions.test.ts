// Questions with options (`request_user_input`, issue #52), without inference:
// the deterministic app-server peer asks, the screen is a WebSocket client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "../src/server";
import { App } from "../src/app";
import { CodexEngine, readQuestions } from "../src/codex/engine";
import type { ClientCommand, ServerMessage, Work } from "../src/contracts";
import type { EngineEvent, Question } from "../src/engine";
import { AGENCY_DEVELOPER_INSTRUCTIONS } from "../src/agency-environment";
import { agentAnswer, answerRecord, optionLabel } from "../src/questions";
import { fakeAppServerArgs } from "./fake-app-server";
import { FakeEngine } from "./fake-engine";
import { screenProtocols, screenSecret } from "./screen-fixture";

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** A screen: one WebSocket connection that keeps what the server says. */
async function screen(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, screenProtocols, { origin: "http://127.0.0.1:5173" });
  const received: ServerMessage[] = [];
  ws.on("message", (data) => received.push(JSON.parse(String(data))));
  ws.on("error", () => {});
  await new Promise<void>((resolveOpen, reject) => {
    ws.once("open", resolveOpen);
    ws.once("error", reject);
  });
  const latest = () => {
    for (let i = received.length - 1; i >= 0; i--) {
      const message = received[i];
      if (message.type === "snapshot") return message.state;
    }
    return undefined;
  };
  return {
    ws,
    received,
    latest,
    work: () => latest()?.works[0],
    send: (command: ClientCommand) => ws.send(JSON.stringify(command)),
    problems: () => received.filter((m): m is Extract<ServerMessage, { type: "problem" }> => m.type === "problem"),
    waitWork: (predicate: (work: Work) => boolean, label: string) =>
      until(() => {
        const work = latest()?.works[0];
        return work && predicate(work) ? work : undefined;
      }, label),
    close: async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((resolveClose) => ws.once("close", () => resolveClose()));
      ws.terminate();
      await closed;
    },
  };
}

/** The app with the real Codex engine class talking to the fake app-server. */
async function harness() {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/questions-"));
  const log = join(dir, "protocol.jsonl");
  const pids = join(dir, "pids.txt");
  const pauseRelease = join(dir, "pause-release");
  process.env.BITACORA_FAKE_LOG = log;
  process.env.BITACORA_FAKE_PID = pids;
  // A pause ends only when the test says Codex confirmed it.
  process.env.BITACORA_FAKE_PAUSE_RELEASE = pauseRelease;
  const engine = new CodexEngine({
    home: join(dir, "home"),
    workspace: join(dir, "workspace"),
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  const data = join(dir, "data");
  const server = await serve(engine, data, 0, undefined, undefined, undefined, screenSecret);
  const screens: Awaited<ReturnType<typeof screen>>[] = [];
  let closed = false;
  const records = async () =>
    (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return {
    dir,
    data,
    engine,
    events,
    server,
    open: async () => {
      const opened = await screen(server.port);
      screens.push(opened);
      return opened;
    },
    records,
    /** What the fake agent received for its questions, in order. */
    answers: async () => (await records()).filter((m) => String(m.id).startsWith("question-") && !m.method),
    lastPid: async () => Number((await readFile(pids, "utf8")).trim().split("\n").at(-1)),
    releasePause: () => writeFile(pauseRelease, "1"),
    closeServer: async () => {
      if (closed) return;
      closed = true;
      for (const opened of screens) await opened.close();
      await server.close();
    },
    dispose: async function () {
      try {
        await this.closeServer();
      } finally {
        delete process.env.BITACORA_FAKE_LOG;
        delete process.env.BITACORA_FAKE_PID;
        delete process.env.BITACORA_FAKE_PAUSE_RELEASE;
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
  };
}

const asked = (work: Work) => !!work.question && !work.question.closed;
const done = (work: Work) => !work.busy && work.progress === "Listo.";

test("a question reaches the screen as a card and the answer goes back to the agent", async () => {
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "question" });
    const work = await s.waitWork(asked, "the question on screen");
    assert.equal(work.busy, true);
    assert.equal(work.progress, "Esperando tu respuesta…");
    const [question] = work.question!.questions;
    assert.equal(question.text, "¿Les hablás de vos o de usted?");
    assert.equal(question.header, "Trato");
    assert.deepEqual(question.options.map((o) => o.label), ["Vos (Recommended)", "Usted"]);
    assert.equal(question.other, true);
    // The agent is waiting: nothing answered it on its own.
    assert.deepEqual(await h.answers(), []);

    s.send({ type: "answer", workId: work.id, questionId: work.question!.id, answers: { trato: "Vos (Recommended)" } });
    const finished = await s.waitWork(done, "the turn to finish");
    assert.equal(finished.question, undefined);
    assert.deepEqual(finished.messages.map((m) => [m.role, m.text]), [
      ["user", "question"],
      ["user", "Trato: Vos"],
      ["assistant", 'Recibí: {"trato":{"answers":["Vos (Recommended)"]}}'],
    ]);
    assert.deepEqual((await h.answers())[0].result, { answers: { trato: { answers: ["Vos (Recommended)"] } } });
    assert.deepEqual(s.problems(), []);
  } finally {
    await h.dispose();
  }
});

test("a written answer («Otra») reaches the agent the way Codex's own client sends it", async () => {
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "question" });
    const work = await s.waitWork(asked, "the question on screen");
    s.send({ type: "answer", workId: work.id, questionId: work.question!.id, answers: { trato: "  Depende del cliente  " } });
    const finished = await s.waitWork(done, "the turn to finish");
    assert.equal(finished.messages[1].text, "Trato: Depende del cliente");
    assert.deepEqual((await h.answers())[0].result.answers.trato.answers, ["None of the above", "user_note: Depende del cliente"]);
  } finally {
    await h.dispose();
  }
});

test("two questions asked before the first is answered are shown one at a time, in order", async () => {
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "two-questions" });
    const first = await s.waitWork(asked, "the first question");
    assert.equal(first.question!.questions[0].id, "trato");
    // Both requests are waiting in Codex: the second one is not on screen yet
    // and did not replace the first.
    await until(() => h.events.filter((e) => e.type === "question").length === 2, "both requests");
    await delay(100);
    assert.equal(s.work()!.question!.id, first.question!.id);

    s.send({ type: "answer", workId: first.id, questionId: first.question!.id, answers: { trato: "Usted" } });
    const second = await s.waitWork((w) => asked(w) && w.question!.id !== first.question!.id, "the second question");
    assert.equal(second.question!.questions[0].id, "canal");
    assert.equal(second.busy, true);
    assert.equal(second.progress, "Esperando tu respuesta…");

    s.send({ type: "answer", workId: first.id, questionId: second.question!.id, answers: { canal: "WhatsApp" } });
    const finished = await s.waitWork(done, "the turn to finish");
    assert.deepEqual(finished.messages.map((m) => m.text), [
      "two-questions",
      "Trato: Usted",
      "Canal: WhatsApp",
      'Recibí: {"trato":{"answers":["Usted"]}} y {"canal":{"answers":["WhatsApp"]}}',
    ]);
    assert.equal((await h.answers()).length, 2);
  } finally {
    await h.dispose();
  }
});

test("pausing with questions pending closes them all once Codex ends the turn, and nothing hangs", async () => {
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "two-questions" });
    const work = await s.waitWork(asked, "the question on screen");
    await until(() => h.events.filter((e) => e.type === "question").length === 2, "both requests");
    s.send({ type: "interrupt", workId: work.id });
    await until(async () => (await h.records()).some((m) => m.method === "turn/interrupt"), "the pause request");
    // Until Codex confirms, the turn is still running and the card still open.
    await delay(200);
    assert.equal(s.work()!.busy, true);
    assert.equal(s.work()!.question!.closed, undefined);

    await h.releasePause();
    const paused = await s.waitWork((w) => !w.busy && !!w.question?.closed, "the paused work");
    assert.equal(paused.progress, "Trabajo pausado.");
    // The first card stays, closed; the one behind it is dropped, not shown.
    assert.equal(paused.question!.id, work.question!.id);
    assert.match(paused.question!.closed!, /^Pausaste el trabajo y esta pregunta quedó sin responder\./);
    const closings = h.events.filter((e) => e.type === "questionClosed");
    assert.deepEqual(closings.map((e) => [e.reason, e.ids.length]), [["paused", 2]]);
    // An answer that arrives late (another window) is ignored without a notice.
    s.send({ type: "answer", workId: work.id, questionId: work.question!.id, answers: { trato: "Usted" } });
    await delay(200);
    assert.deepEqual(s.problems(), []);
    assert.deepEqual(await h.answers(), []);
    // The next request clears the card and works as usual.
    s.send({ type: "send", workId: work.id, text: "race" });
    const next = await s.waitWork((w) => w.messages.length === 2 && !w.busy, "the next request");
    assert.equal(next.question, undefined);
  } finally {
    await h.dispose();
  }
});

test("a Codex restart with questions pending closes them and the next request works", async () => {
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "two-questions" });
    const work = await s.waitWork(asked, "the question on screen");
    await until(() => h.events.filter((e) => e.type === "question").length === 2, "both requests");
    const before = await h.lastPid();
    process.kill(before);
    const stopped = await s.waitWork((w) => !w.busy && !!w.question?.closed, "the closed question");
    assert.equal(stopped.question!.id, work.question!.id);
    assert.match(stopped.question!.closed!, /^Bitácora se detuvo y esta pregunta quedó sin responder\./);
    assert.deepEqual(
      h.events.filter((e) => e.type === "questionClosed").map((e) => [e.reason, e.ids.length]),
      [["stopped", 2]],
    );
    await until(() => s.latest()?.engine.available, "engine back");
    assert.notEqual(await h.lastPid(), before);
    // The restarted app-server numbers its requests again: an old answer must
    // never reach it, and it is ignored without a notice.
    s.send({ type: "answer", workId: work.id, questionId: work.question!.id, answers: { trato: "Usted" } });
    s.send({ type: "send", workId: work.id, text: "race" });
    const next = await s.waitWork((w) => w.messages.at(-1)?.text === "race" && !w.busy, "the next request");
    assert.equal(next.question, undefined);
    assert.equal(next.progress, "Listo.");
    assert.deepEqual(s.problems(), []);
    assert.deepEqual(await h.answers(), []);
    const turns = (await h.records()).filter((m) => m.method === "turn/start").map((m) => m.params.input[0].text);
    assert.deepEqual(turns, ["two-questions", "race"]);
  } finally {
    await h.dispose();
  }
});

test("«Ahora no» answers nothing and the turn goes on", async () => {
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "question" });
    const work = await s.waitWork(asked, "the question on screen");
    s.send({ type: "skipQuestion", workId: work.id, questionId: work.question!.id });
    const finished = await s.waitWork(done, "the turn to finish");
    assert.equal(finished.question, undefined);
    assert.deepEqual(finished.messages.map((m) => m.text), ["question", "Ahora no.", "Recibí: {}"]);
    // Codex hands the model exactly this, with nothing that explains it: the
    // developer instructions say what an empty answer means.
    assert.deepEqual((await h.answers())[0].result, { answers: {} });
    assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /vuelve sin respuestas \(\{"answers":\{\}\}\), la usuaria prefirió no responderla ahora/);
    const thread = (await h.records()).find((m) => m.method === "thread/start");
    assert.equal(thread.params.developerInstructions, AGENCY_DEVELOPER_INSTRUCTIONS);
  } finally {
    await h.dispose();
  }
});

test("a secret answer never reaches the work's detail or the saved works", async () => {
  process.env.BITACORA_FAKE_QUESTIONS = JSON.stringify([{
    id: "clave", header: "Clave", question: "¿Cuál es la clave del portal?", isOther: true, isSecret: true, options: null,
  }]);
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "question" });
    const work = await s.waitWork(asked, "the question on screen");
    assert.equal(work.question!.questions[0].secret, true);
    s.send({ type: "answer", workId: work.id, questionId: work.question!.id, answers: { clave: "clave-secreta-123" } });
    const finished = await s.waitWork(done, "the turn to finish");
    // The agent got it, and the fake app-server sent it back inside a
    // `functionCallOutput` item, which the engine must not copy to the detail.
    assert.deepEqual((await h.answers())[0].result.answers.clave.answers, ["user_note: clave-secreta-123"]);
    assert.equal(finished.messages[1].text, "Clave: (respuesta privada)");
    assert.doesNotMatch(JSON.stringify(finished), /clave-secreta-123/);
    await h.closeServer();
    assert.doesNotMatch(await readFile(join(h.data, "works.json"), "utf8"), /clave-secreta-123/);
  } finally {
    delete process.env.BITACORA_FAKE_QUESTIONS;
    await h.dispose();
  }
});

test("a lost screen connection and a reloaded window show the pending question again", async () => {
  const h = await harness();
  try {
    const first = await h.open();
    await until(() => first.latest()?.engine.available, "engine ready");
    first.send({ type: "send", text: "question" });
    const work = await first.waitWork(asked, "the question on screen");
    // The connection drops without a goodbye.
    await first.close();
    const reconnected = await h.open();
    const again = await reconnected.waitWork(asked, "the question after reconnecting");
    assert.equal(again.question!.id, work.question!.id);
    assert.equal(again.busy, true);
    // The window reloads: a new page, a new connection.
    await reconnected.close();
    const reloaded = await h.open();
    const shown = await reloaded.waitWork(asked, "the question after reloading");
    assert.deepEqual(shown.question, work.question);
    reloaded.send({ type: "answer", workId: work.id, questionId: work.question!.id, answers: { trato: "Usted" } });
    const finished = await reloaded.waitWork(done, "the turn to finish");
    assert.equal(finished.messages[1].text, "Trato: Usted");
  } finally {
    await h.dispose();
  }
});

test("closing the app with a question pending keeps the work and says the question was left", async () => {
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "question" });
    await s.waitWork(asked, "the question on screen");
    await h.closeServer();
    const saved = JSON.parse(await readFile(join(h.data, "works.json"), "utf8"));
    const [work] = saved.works;
    assert.equal(work.busy, false);
    assert.equal(work.progress, "El trabajo se detuvo al cerrar la app. Podés continuarlo.");
    assert.match(work.question.closed, /^Bitácora se cerró y esta pregunta quedó sin responder\./);
    // Opening again shows the closed card, and the work can be continued.
    const engine = new FakeEngine();
    const app = new App(engine, h.data, () => {});
    try {
      await app.start();
      const reopened = app.snapshot().works[0];
      assert.equal(reopened.question?.closed, work.question.closed);
      await app.command({ type: "send", workId: reopened.id, text: "Seguimos" }, () => {});
      assert.equal(app.snapshot().works[0].question, undefined);
    } finally {
      await app.close();
    }
  } finally {
    await h.dispose();
  }
});

test("an app that stopped without closing never shows a question as still waiting", async () => {
  await mkdir(".local", { recursive: true });
  const data = await mkdtemp(resolve(".local/questions-crash-"));
  try {
    const now = new Date().toISOString();
    await writeFile(join(data, "works.json"), JSON.stringify({
      version: 1,
      works: [{
        id: "work-1", conversationId: "thread-1", title: "Trato", createdAt: now, updatedAt: now,
        messages: [{ id: "m1", role: "user", text: "Armemos la marca" }], details: "", busy: true, progress: "Esperando tu respuesta…",
        question: { id: "q1", askedAt: now, questions: [{ id: "trato", header: "Trato", text: "¿Vos o usted?", options: [{ label: "Vos", description: "" }], other: true, secret: false }] },
      }],
    }), "utf8");
    const app = new App(new FakeEngine(), data, () => {});
    try {
      await app.initialize();
      const [work] = app.snapshot().works;
      assert.equal(work.busy, false);
      assert.match(work.question!.closed!, /^Bitácora se cerró/);
    } finally {
      await app.close();
    }
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("a turn that ends without an answer closes the question", async () => {
  process.env.BITACORA_FAKE_QUESTION_ENDS = "1";
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "question" });
    const closed = await s.waitWork((w) => !w.busy && !!w.question?.closed, "the closed question");
    assert.match(closed.question!.closed!, /^El pedido terminó y esta pregunta quedó sin responder\./);
  } finally {
    delete process.env.BITACORA_FAKE_QUESTION_ENDS;
    await h.dispose();
  }
});

/** An app with the fake engine and one work waiting on a question. */
async function appAsking(questions: Question[]) {
  await mkdir(".local", { recursive: true });
  const data = await mkdtemp(resolve(".local/questions-app-"));
  const engine = new FakeEngine();
  const app = new App(engine, data, () => {});
  const replies: ServerMessage[] = [];
  const reply = (message: ServerMessage) => replies.push(message);
  await app.start();
  await app.command({ type: "send", text: "Armemos la marca" }, reply);
  engine.emit({ type: "question", conversationId: "conversation-1", id: "q1", questions });
  return {
    app,
    engine,
    replies,
    reply,
    workId: app.snapshot().works[0].id,
    problems: () => replies.filter((m) => m.type === "problem").map((m) => (m as { text: string }).text),
    dispose: async () => {
      await app.close();
      await rm(data, { recursive: true, force: true });
    },
  };
}

test("the app checks each answer before passing it on", async () => {
  const f = await appAsking([
    { id: "trato", header: "Trato", text: "¿Vos o usted?", options: [{ label: "Vos", description: "" }, { label: "Usted", description: "" }], other: false, secret: false },
    { id: "clave", header: "", text: "¿Cuál es la clave?", options: [], other: true, secret: true },
  ]);
  try {
    // Missing, unknown and too long answers are refused without reaching the agent.
    const refused: Record<string, string>[] = [{ trato: "Vos" }, { trato: "Tal vez", clave: "x" }, { trato: "Vos", clave: "   " }, { trato: "Vos", clave: "x".repeat(2001) }];
    for (const answers of refused) await f.app.command({ type: "answer", workId: f.workId, questionId: "q1", answers }, f.reply);
    // An answer for a question that is not the one on screen is ignored quietly.
    await f.app.command({ type: "answer", workId: f.workId, questionId: "otra", answers: { trato: "Vos", clave: "x" } }, f.reply);
    assert.deepEqual(f.engine.answers, []);
    assert.deepEqual(f.problems(), Array(4).fill("Respondé cada pregunta antes de seguir."));
    await f.app.command({ type: "answer", workId: f.workId, questionId: "q1", answers: { trato: "Usted", clave: "abc123" } }, f.reply);
    assert.deepEqual(f.engine.answers, [{
      conversationId: "conversation-1",
      questionId: "q1",
      answers: { trato: ["Usted"], clave: ["user_note: abc123"] },
    }]);
    // A secret answer is never written back into the conversation.
    const work = f.app.snapshot().works[0];
    assert.equal(work.messages.at(-1)!.text, "Trato: Usted\n¿Cuál es la clave?: (respuesta privada)");
    assert.doesNotMatch(JSON.stringify(work), /abc123/);
    // The same answer sent again (a second window, a double click) is ignored
    // without a notice and never reaches the agent twice.
    await f.app.command({ type: "answer", workId: f.workId, questionId: "q1", answers: { trato: "Vos", clave: "x" } }, f.reply);
    assert.equal(f.engine.answers.length, 1);
    assert.equal(f.problems().length, 4);
  } finally {
    await f.dispose();
  }
});

test("a busy work waiting on a question says so and points to it", async () => {
  const f = await appAsking([
    { id: "trato", header: "Trato", text: "¿Vos o usted?", options: [{ label: "Vos", description: "" }], other: true, secret: false },
  ]);
  try {
    const title = f.app.snapshot().works[0].title;
    await f.app.command({ type: "send", text: "Otra cosa" }, f.reply);
    const problem = f.replies.find((m) => m.type === "problem") as Extract<ServerMessage, { type: "problem" }>;
    assert.equal(problem.text, `Te hice una pregunta en «${title}»: respondela para seguir.`);
    assert.equal(problem.workId, f.workId);
    // Once it is answered, the work is just busy.
    await f.app.command({ type: "answer", workId: f.workId, questionId: "q1", answers: { trato: "Vos" } }, f.reply);
    f.replies.length = 0;
    await f.app.command({ type: "send", text: "Otra cosa" }, f.reply);
    assert.deepEqual(f.problems(), ["Esperá a que termine el pedido actual o pausalo."]);
  } finally {
    await f.dispose();
  }
});

test("a question for a work the app does not know is answered empty instead of waiting", async () => {
  await mkdir(".local", { recursive: true });
  const data = await mkdtemp(resolve(".local/questions-unknown-"));
  const engine = new FakeEngine();
  const app = new App(engine, data, () => {});
  try {
    await app.start();
    engine.emit({ type: "question", conversationId: "nobody", id: "q1", questions: [] });
    await until(() => engine.answers.length, "the empty answer");
    assert.deepEqual(engine.answers, [{ conversationId: "nobody", questionId: "q1", answers: {} }]);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("question requests that cannot be shown are recognised; labels and records read well", () => {
  const valid = {
    threadId: "t",
    questions: [{ id: "a", header: "H", question: "¿Sí?", isOther: true, isSecret: false, options: [{ label: "Sí", description: "d" }, { label: "Sí", description: "otra" }] }],
  };
  const read = readQuestions(valid);
  assert.deepEqual(read?.questions[0].options, [{ label: "Sí", description: "d" }]);
  for (const params of [
    {},
    null,
    { threadId: "t", questions: [] },
    { threadId: "t", questions: [{ id: "", question: "¿?", options: [{ label: "a", description: "" }] }] },
    { threadId: "t", questions: [{ id: "a", question: "   ", options: [{ label: "a", description: "" }] }] },
    { threadId: "t", questions: [{ id: "a", question: "¿?", options: null, isOther: false }] },
    { threadId: "t", questions: [{ id: "a", question: "¿?", options: [{ label: "", description: "" }] }] },
    { threadId: "t", questions: [{ id: "a", question: "¿?", options: [{ label: "x" }] }, { id: "a", question: "¿?", options: [{ label: "y" }] }] },
  ])
    assert.equal(readQuestions(params), undefined, JSON.stringify(params));
  assert.deepEqual(readQuestions({ threadId: "t", questions: [{ id: "a", question: "¿Nombre?", options: null, isOther: true }] })?.questions[0], {
    id: "a", header: "", text: "¿Nombre?", options: [], other: true, secret: false,
  });

  assert.deepEqual(optionLabel("La 1 (Recommended)"), { text: "La 1", recommended: true });
  assert.deepEqual(optionLabel("Usted (recomendado)"), { text: "Usted", recommended: true });
  assert.deepEqual(optionLabel("(Recommended)"), { text: "(Recommended)", recommended: false });
  assert.deepEqual(optionLabel("WhatsApp"), { text: "WhatsApp", recommended: false });

  const question = { id: "canal", header: "", text: "¿Dónde lo mandás más?", options: [{ label: "WhatsApp (Recommended)", description: "" }], other: false, secret: false };
  assert.deepEqual(agentAnswer(question, "WhatsApp (Recommended)"), ["WhatsApp (Recommended)"]);
  assert.equal(agentAnswer(question, "Instagram"), undefined);
  assert.equal(agentAnswer(question, 3), undefined);
  assert.deepEqual(agentAnswer({ ...question, other: true }, " PDF "), ["None of the above", "user_note: PDF"]);
  assert.deepEqual(agentAnswer({ ...question, options: [], other: true }, "PDF"), ["user_note: PDF"]);
  assert.equal(answerRecord({ id: "q", askedAt: "", questions: [question] }, { canal: "WhatsApp (Recommended)" }), "WhatsApp");
});
