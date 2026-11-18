import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { App } from "../src/app";
import { CodexEngine } from "../src/codex/engine";
import { PANEL_WIDTH, type ServerMessage } from "../src/contracts";
import { DEFAULT_MODEL, TITLE_EFFORT, WORK_EFFORT, modelName, resolveModel, type EngineModel } from "../src/models";
import { FAKE_CATALOGUE, FakeEngine } from "./fake-engine";
import { fakeAppServerArgs } from "./fake-app-server";
import { clampPanel, panelBounds, panelKey } from "../../web/src/panel";

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail("condition timed out");
}

test("the default is GPT-6.2 Sol with high reasoning", () => {
  assert.equal(DEFAULT_MODEL, "gpt-6.2-sol");
  assert.equal(WORK_EFFORT, "high");
  const { selection, state } = resolveModel(FAKE_CATALOGUE);
  assert.deepEqual(selection, { model: "gpt-6.2-sol", effort: "high" });
  assert.equal(state.current.name, "GPT-6.2 Sol");
  assert.equal(state.current.recommended, true);
  assert.equal(state.effortText, "razonamiento alto");
  assert.equal(state.notice, undefined);
});

test("the list comes from the catalogue without any Astra model", () => {
  const { state } = resolveModel(FAKE_CATALOGUE);
  assert.deepEqual(state.choices.map((choice) => choice.id), ["gpt-6.2-sol", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-luna"]);
  assert.ok(state.choices.every((choice) => !/astra/i.test(choice.id + choice.name)));
  assert.ok(state.choices.every((choice) => choice.description && !/\bcoding\b|token|modelo de lenguaje/i.test(choice.description)));
  // Not even when it is what the user had saved.
  const saved = resolveModel(FAKE_CATALOGUE, "gpt-6.2-astra");
  assert.equal(saved.selection.model, "gpt-6.2-sol");
  assert.match(saved.state.notice ?? "", /GPT-6.2 Astra no está disponible en tu cuenta\. Uso GPT-6.2 Sol\./);
});

test("without the default in the account the best one available is used, and said", () => {
  const without = FAKE_CATALOGUE.filter((model) => model.id !== "gpt-6.2-sol");
  const engineDefault = without.map((model) => ({ ...model, isDefault: model.id === "gpt-6.1-sol" }));
  const picked = resolveModel(engineDefault);
  assert.equal(picked.selection.model, "gpt-6.1-sol");
  assert.equal(picked.state.notice, "GPT-6.2 Sol no está disponible en tu cuenta. Uso GPT-6.1 Sol.");
  // With no default of its own, the first allowed one in the engine's order.
  const first = resolveModel(without.map((model) => ({ ...model, isDefault: false })));
  assert.equal(first.selection.model, "gpt-6.1-terra");
  assert.match(first.state.notice ?? "", /Uso GPT-6.1 Terra/);
});

test("a saved choice wins, and falls back to the default when it leaves the account", () => {
  assert.equal(resolveModel(FAKE_CATALOGUE, "gpt-6-luna").selection.model, "gpt-6-luna");
  const gone = resolveModel(FAKE_CATALOGUE, "gpt-5.6-luna");
  assert.equal(gone.selection.model, "gpt-6.2-sol");
  assert.equal(gone.state.notice, "GPT-5.6 Luna no está disponible en tu cuenta. Uso GPT-6.2 Sol.");
});

test("before the catalogue arrives the chosen model is still the one asked for", () => {
  const { selection, state } = resolveModel(undefined, "gpt-6-luna");
  assert.deepEqual(selection, { model: "gpt-6-luna", effort: "high" });
  assert.deepEqual(state.choices, []);
  assert.equal(state.notice, undefined);
  assert.equal(resolveModel(undefined).selection.model, "gpt-6.2-sol");
});

test("a model without high reasoning keeps its own default", () => {
  const plain: EngineModel = { id: "gpt-6-luna", displayName: "GPT-6-Luna", efforts: ["low", "medium"], defaultEffort: "medium", isDefault: false };
  const { selection, state } = resolveModel([plain], "gpt-6-luna");
  assert.deepEqual(selection, { model: "gpt-6-luna", effort: "medium" });
  assert.equal(state.effortText, "razonamiento medio");
});

test("model names read as words", () => {
  assert.equal(modelName("gpt-6.2-sol", "GPT-6.2-Sol"), "GPT-6.2 Sol");
  assert.equal(modelName("gpt-6.1-terra", "GPT-6.1 Terra"), "GPT-6.1 Terra");
  assert.equal(modelName("gpt-5.6-luna"), "GPT-5.6 Luna");
});

async function engineFixture() {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/models-engine-"));
  const log = join(dir, "protocol.jsonl");
  process.env.BITACORA_FAKE_LOG = log;
  const engine = new CodexEngine({
    home: join(dir, "home"),
    workspace: join(dir, "workspace"),
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  await engine.start();
  const records = async () =>
    (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return {
    engine,
    records,
    close: async () => {
      try {
        await engine.close();
      } finally {
        delete process.env.BITACORA_FAKE_LOG;
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  };
}

test("the engine reads every page of model/list and leaves hidden models out", async () => {
  const f = await engineFixture();
  try {
    const models = await f.engine.models();
    assert.deepEqual(models.map((model) => model.id), ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6-luna"]);
    assert.deepEqual(models[0], { id: "gpt-6.2-sol", displayName: "GPT-6.2-Sol", efforts: ["low", "medium", "high"], defaultEffort: "low", isDefault: true });
    const lists = (await f.records()).filter((m) => m.method === "model/list");
    assert.deepEqual(lists.map((m) => m.params.cursor), [null, "page-2"]);
  } finally {
    await f.close();
  }
});

test("the model travels in thread/start, thread/resume and turn/start", async () => {
  const f = await engineFixture();
  try {
    const model = { model: "gpt-6.2-sol", effort: "high" };
    const { conversationId } = await f.engine.createWork(model);
    await f.engine.resumeWork(conversationId, model);
    await f.engine.send(conversationId, "race", [], { model });
    const records = await f.records();
    const start = records.find((m) => m.method === "thread/start");
    assert.equal(start.params.model, "gpt-6.2-sol");
    // `thread/start` has no effort field in 0.168.0: it is a config override.
    assert.deepEqual(start.params.config, { model_reasoning_effort: "high" });
    const resume = records.find((m) => m.method === "thread/resume");
    assert.equal(resume.params.model, "gpt-6.2-sol");
    assert.deepEqual(resume.params.config, { model_reasoning_effort: "high" });
    const turn = records.find((m) => m.method === "turn/start");
    assert.equal(turn.params.model, "gpt-6.2-sol");
    assert.equal(turn.params.effort, "high");
  } finally {
    await f.close();
  }
});

test("the title sample asks for the lowest effort, whatever the work's model", async () => {
  process.env.BITACORA_FAKE_SAMPLE = "Porto de Galinhas, febrero";
  const f = await engineFixture();
  try {
    const { conversationId } = await f.engine.createWork({ model: "gpt-6-luna", effort: "high" });
    await f.engine.send(conversationId, "race", [], { model: { model: "gpt-6-luna", effort: "high" } });
    await until(async () => (await f.records()).some((m) => m.method === "turn/start"));
    await until(async () => {
      try { return !!(await f.engine.suggestTitle(conversationId)); } catch { return false; }
    });
    const sample = (await f.records()).find((m) => m.method === "thread/sample");
    assert.equal(TITLE_EFFORT, "low");
    assert.equal(sample.params.effort, "low");
    assert.equal(sample.params.model, undefined);
  } finally {
    delete process.env.BITACORA_FAKE_SAMPLE;
    await f.close();
  }
});

async function appFixture(dir?: string) {
  await mkdir(".local", { recursive: true });
  const data = dir ?? (await mkdtemp(resolve(".local/models-app-")));
  const engine = new FakeEngine();
  const messages: ServerMessage[] = [];
  const app = new App(engine, data, (m) => messages.push(m));
  await app.start();
  await until(() => !!app.snapshot().model?.choices.length);
  return { dir: data, engine, app, messages, reply: (m: ServerMessage) => messages.push(m) };
}

test("each request carries the model, and the screen shows it", async () => {
  const f = await appFixture();
  try {
    assert.equal(f.app.snapshot().model?.current.id, "gpt-6.2-sol");
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    const workId = f.app.snapshot().works[0].id;
    f.engine.emit({ type: "finished", conversationId: "conversation-1", status: "completed" });
    await f.app.command({ type: "send", workId, text: "Otra más" }, f.reply);
    const high = { model: "gpt-6.2-sol", effort: "high" };
    assert.deepEqual(f.engine.modelRequests, [
      { call: "create", model: high },
      { call: "send", model: high },
      { call: "send", model: high },
    ]);
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("the choice is the same for every work and is remembered between sessions", async () => {
  const f = await appFixture();
  try {
    await f.app.command({ type: "chooseModel", model: "gpt-6-luna" }, f.reply);
    assert.equal(f.app.snapshot().model?.current.id, "gpt-6-luna");
    const saved = JSON.parse(await readFile(join(f.dir, "settings.json"), "utf8"));
    assert.deepEqual(saved, { version: 1, model: "gpt-6-luna" });
    await f.app.command({ type: "send", text: "Armame una propuesta" }, f.reply);
    assert.deepEqual(f.engine.modelRequests.at(-1), { call: "send", model: { model: "gpt-6-luna", effort: "high" } });
  } finally {
    await f.app.close();
  }
  // A new session reads it back and a work created before is resumed with it.
  const again = await appFixture(f.dir);
  try {
    assert.equal(again.app.snapshot().model?.current.id, "gpt-6-luna");
    const workId = again.app.snapshot().works[0].id;
    await again.app.command({ type: "send", workId, text: "Seguimos" }, again.reply);
    const luna = { model: "gpt-6-luna", effort: "high" };
    assert.deepEqual(again.engine.modelRequests, [
      { call: "resume", model: luna },
      { call: "send", model: luna },
    ]);
  } finally {
    await again.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a model outside the list, Astra included, is refused", async () => {
  const f = await appFixture();
  try {
    for (const model of ["gpt-6.2-astra", "gpt-9-imaginario"]) {
      await f.app.command({ type: "chooseModel", model }, f.reply);
      const problem = f.messages.at(-1);
      assert.equal(problem?.type, "problem");
      assert.match(problem?.type === "problem" ? problem.text : "", /no está disponible en tu cuenta/);
    }
    assert.equal(f.app.snapshot().model?.current.id, "gpt-6.2-sol");
    await assert.rejects(readFile(join(f.dir, "settings.json"), "utf8"));
  } finally {
    await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("without the default in the account the app warns and asks for the best one", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/models-app-"));
  const engine = new FakeEngine();
  engine.catalogue = FAKE_CATALOGUE.filter((model) => model.id !== "gpt-6.2-sol");
  const app = new App(engine, dir, () => {});
  try {
    await app.start();
    await until(() => !!app.snapshot().model?.choices.length);
    assert.equal(app.snapshot().model?.notice, "GPT-6.2 Sol no está disponible en tu cuenta. Uso GPT-6.1 Terra.");
    await app.command({ type: "send", text: "Armame una propuesta" }, () => {});
    assert.deepEqual(engine.modelRequests[0], { call: "create", model: { model: "gpt-6.1-terra", effort: "high" } });
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed list keeps asking for the chosen model, and a new account lists again", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/models-app-"));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ version: 1, model: "gpt-6-luna" }));
  const engine = new FakeEngine();
  engine.catalogue = "fail";
  const app = new App(engine, dir, () => {});
  try {
    await app.start();
    await delay(30);
    assert.deepEqual(app.snapshot().model?.choices, []);
    assert.equal(app.snapshot().model?.current.id, "gpt-6-luna");
    engine.catalogue = FAKE_CATALOGUE;
    engine.emit({ type: "account", account: { connected: true, email: "otra@example.test" } });
    await until(() => !!app.snapshot().model?.choices.length);
    assert.equal(app.snapshot().model?.current.id, "gpt-6-luna");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the panel width is kept within its limits and remembered", async () => {
  const f = await appFixture();
  try {
    await f.app.command({ type: "panelWidth", width: 9000 }, f.reply);
    assert.equal(f.app.snapshot().panelWidth, PANEL_WIDTH.max);
    await f.app.command({ type: "panelWidth", width: 420.4 }, f.reply);
    await assert.rejects(f.app.command({ type: "panelWidth", width: Number.NaN }, f.reply));
  } finally {
    await f.app.close();
  }
  const again = await appFixture(f.dir);
  try {
    assert.equal(again.app.snapshot().panelWidth, 420);
  } finally {
    await again.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("the divider moves with the arrows and never squeezes the conversation", () => {
  assert.deepEqual(panelBounds(1280), { min: 280, max: 640 });
  // At the narrowest desktop width the conversation keeps its room.
  assert.deepEqual(panelBounds(960), { min: 280, max: 320 });
  assert.equal(clampPanel(500, 960), 320);
  assert.equal(panelKey("ArrowLeft", 300, 1280), 316);
  assert.equal(panelKey("ArrowRight", 300, 1280), 284);
  assert.equal(panelKey("ArrowLeft", 300, 1280, true), 364);
  assert.equal(panelKey("ArrowRight", 284, 1280, true), 280);
  assert.equal(panelKey("Home", 400, 1280), 280);
  assert.equal(panelKey("End", 400, 1280), 640);
  assert.equal(panelKey("Enter", 400, 1280), undefined);
});
