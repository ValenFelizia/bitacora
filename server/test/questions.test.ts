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
import type { EngineEvent } from "../src/engine";
import { agentAnswer, answerRecord, optionLabel } from "../src/questions";
import { fakeAppServerArgs } from "./fake-app-server";
import { FakeEngine } from "./fake-engine";

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
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://127.0.0.1:5173" });
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
  process.env.BITACORA_FAKE_LOG = log;
  process.env.BITACORA_FAKE_PID = pids;
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
  const server = await serve(engine, data, 0);
  const screens: Awaited<ReturnType<typeof screen>>[] = [];
  let closed = false;
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
    records: async () =>
      (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
    lastPid: async () => Number((await readFile(pids, "utf8")).trim().split("\n").at(-1)),
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
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
  };
}

const asked = (work: Work) => !!work.question && !work.question.closed;

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
    const before = await h.records();
    assert.equal(before.some((m) => String(m.id).startsWith("question-") && !m.method), false);

    s.send({ type: "answer", workId: work.id, questionId: work.question!.id, answers: { trato: "Vos (Recommended)" } });
    const done = await s.waitWork((w) => !w.busy && w.progress === "Listo.", "the turn to finish");
    assert.equal(done.question, undefined);
    assert.deepEqual(done.messages.map((m) => [m.role, m.text]), [
      ["user", "question"],
      ["user", "Trato: Vos"],
      ["assistant", 'Recibí: {"trato":{"answers":["Vos (Recommended)"]}}'],
    ]);
    const reply = (await h.records()).find((m) => String(m.id).startsWith("question-") && !m.method);
    assert.deepEqual(reply.result, { answers: { trato: { answers: ["Vos (Recommended)"] } } });
    assert.deepEqual(s.problems(), []);
  } finally {
    await h.dispose();
  }
});

test("a written answer («Otra») reaches the agent marked as the user's own words", async () => {
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "question" });
    const work = await s.waitWork(asked, "the question on screen");
    s.send({ type: "answer", workId: work.id, questionId: work.question!.id, answers: { trato: "  Depende del cliente  " } });
    const done = await s.waitWork((w) => !w.busy && w.progress === "Listo.", "the turn to finish");
    assert.equal(done.messages[1].text, "Trato: Depende del cliente");
    const reply = (await h.records()).find((m) => String(m.id).startsWith("question-") && !m.method);
    assert.deepEqual(reply.result.answers.trato.answers, ["user_note: Depende del cliente"]);
  } finally {
    await h.dispose();
  }
});

test("pausing with a question pending cancels it with a clear notice and nothing hangs", async () => {
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "question" });
    const work = await s.waitWork(asked, "the question on screen");
    s.send({ type: "interrupt", workId: work.id });
    const paused = await s.waitWork((w) => !w.busy && !!w.question?.closed, "the paused work");
    assert.equal(paused.progress, "Trabajo pausado.");
    assert.match(paused.question!.closed!, /^Pausaste el trabajo y esta pregunta quedó sin responder\./);
    // The card stays, closed: an answer now is refused with a plain message.
    s.send({ type: "answer", workId: work.id, questionId: work.question!.id, answers: { trato: "Usted" } });
    await until(() => s.problems().length, "the refusal");
    assert.equal(s.problems()[0].text, "Esa pregunta ya no está esperando respuesta.");
    assert.equal((await h.records()).some((m) => String(m.id).startsWith("question-") && !m.method), false);
    // The next request clears the card and works as usual.
    s.send({ type: "send", workId: work.id, text: "race" });
    const next = await s.waitWork((w) => w.messages.length === 2 && !w.busy, "the next request");
    assert.equal(next.question, undefined);
  } finally {
    await h.dispose();
  }
});

test("a Codex restart with a question pending cancels it and the work can go on", async () => {
  const h = await harness();
  try {
    const s = await h.open();
    await until(() => s.latest()?.engine.available, "engine ready");
    s.send({ type: "send", text: "question" });
    const work = await s.waitWork(asked, "the question on screen");
    process.kill(await h.lastPid());
    const stopped = await s.waitWork((w) => !w.busy && !!w.question?.closed, "the cancelled question");
    assert.match(stopped.question!.closed!, /^Bitácora se reinició y esta pregunta quedó sin responder\./);
    assert.equal(
      h.events.filter((e) => e.type === "questionClosed" && e.reason === "stopped").length,
      1,
    );
    await until(() => s.latest()?.engine.available, "engine back");
    // The restarted app-server numbers its requests again: an old answer must
    // never reach it.
    s.send({ type: "answer", workId: work.id, questionId: work.question!.id, answers: { trato: "Usted" } });
    await until(() => s.problems().some((p) => p.text === "Esa pregunta ya no está esperando respuesta."), "the refusal");
    assert.equal((await h.records()).some((m) => String(m.id).startsWith("question-") && !m.method), false);
  } finally {
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
    const done = await reloaded.waitWork((w) => !w.busy && w.progress === "Listo.", "the turn to finish");
    assert.equal(done.messages[1].text, "Trato: Usted");
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
    const done = await s.waitWork((w) => !w.busy && !!w.question?.closed, "the closed question");
    assert.match(done.question!.closed!, /^El pedido terminó y esta pregunta quedó sin responder\./);
  } finally {
    delete process.env.BITACORA_FAKE_QUESTION_ENDS;
    await h.dispose();
  }
});

test("the app checks each answer before passing it on", async () => {
  await mkdir(".local", { recursive: true });
  const data = await mkdtemp(resolve(".local/questions-app-"));
  const engine = new FakeEngine();
  const app = new App(engine, data, () => {});
  const replies: ServerMessage[] = [];
  const reply = (message: ServerMessage) => replies.push(message);
  try {
    await app.start();
    await app.command({ type: "send", text: "Armemos la marca" }, reply);
    const conversationId = "conversation-1";
    engine.emit({
      type: "question",
      conversationId,
      id: "q1",
      questions: [
        { id: "trato", header: "Trato", text: "¿Vos o usted?", options: [{ label: "Vos", description: "" }, { label: "Usted", description: "" }], other: false, secret: false },
        { id: "clave", header: "", text: "¿Cuál es la clave?", options: [], other: true, secret: true },
      ],
    });
    const workId = app.snapshot().works[0].id;
    // Missing, unknown and too long answers are refused without reaching the agent.
    const refused: Record<string, string>[] = [{ trato: "Vos" }, { trato: "Tal vez", clave: "x" }, { trato: "Vos", clave: "   " }, { trato: "Vos", clave: "x".repeat(2001) }];
    for (const answers of refused) {
      await app.command({ type: "answer", workId, questionId: "q1", answers }, reply);
    }
    await app.command({ type: "answer", workId, questionId: "otra", answers: { trato: "Vos", clave: "x" } }, reply);
    assert.deepEqual(engine.answers, []);
    assert.deepEqual(replies.filter((m) => m.type === "problem").map((m) => (m as { text: string }).text), [
      ...Array(4).fill("Respondé cada pregunta antes de seguir."),
      "Esa pregunta ya no está esperando respuesta.",
    ]);
    await app.command({ type: "answer", workId, questionId: "q1", answers: { trato: "Usted", clave: "abc123" } }, reply);
    assert.deepEqual(engine.answers, [{
      conversationId,
      questionId: "q1",
      answers: { trato: ["Usted"], clave: ["user_note: abc123"] },
    }]);
    // A secret answer is never written back into the conversation.
    const work = app.snapshot().works[0];
    assert.equal(work.messages.at(-1)!.text, "Trato: Usted\n¿Cuál es la clave?: (respuesta privada)");
    assert.doesNotMatch(JSON.stringify(work), /abc123/);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
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
  assert.equal(answerRecord({ id: "q", askedAt: "", questions: [question] }, { canal: "WhatsApp (Recommended)" }), "WhatsApp");
});
