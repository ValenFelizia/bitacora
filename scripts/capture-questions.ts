import { randomBytes } from "node:crypto";
// Screenshots of the question card (issue #52) on the built screen, in Edge.
// A scripted engine asks the questions: no Codex, no account, no inference.
// Run `npm run build` first.
import { chromium, type Page } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve } from "../server/src/server";
import type { EngineFile, Question } from "../server/src/engine";
import { FakeEngine } from "../server/test/fake-engine";

const out = "docs/design/capturas";
const samples: Question[] = [{
  id: "muestra",
  header: "Muestra",
  text: "¿Cuál te gusta más?",
  options: [
    { label: "La 1 (Recommended)", description: "Editorial, con título con serifa y mucho aire." },
    { label: "La 2", description: "Bloques de color con título grande." },
    { label: "La 3", description: "Cercana, con una frase en letra manuscrita." },
  ],
  other: true,
  secret: false,
}];
const voice: Question[] = [
  {
    id: "trato",
    header: "Trato",
    text: "¿Les hablás de vos o de usted?",
    options: [
      { label: "Vos (Recommended)", description: "Más cercano, como en una charla." },
      { label: "Usted", description: "Más formal." },
    ],
    other: true,
    secret: false,
  },
  {
    id: "tono",
    header: "Tono",
    text: "¿Preferís algo cálido o más formal?",
    options: [
      { label: "Cálido", description: "Frases cortas y cercanas." },
      { label: "Formal", description: "Más sobrio y prolijo." },
    ],
    other: true,
    secret: false,
  },
];

/** Asks one card per request, in order, and records what comes back. */
class AskingEngine extends FakeEngine {
  cards = [
    { intro: "Ya dibujé las tres muestras con los mismos datos. Miralas en la barra de la derecha.", questions: samples },
    { intro: "Ahora vamos con la forma de hablarles a tus clientes.", questions: voice },
    { intro: "Dibujé otra vez las tres muestras con tus colores.", questions: samples },
  ];
  override async send(id: string, text: string, files?: EngineFile[]) {
    await super.send(id, text, files);
    const card = this.cards.shift()!;
    this.emit({ type: "message", conversationId: id, id: `intro-${this.sent.length}`, text: card.intro, delta: false });
    this.emit({ type: "question", conversationId: id, id: `q-${this.sent.length}`, questions: card.questions });
  }
  override async answer(id: string, questionId: string, answers: Record<string, string[]>) {
    await super.answer(id, questionId, answers);
    setTimeout(() => {
      this.emit({ type: "message", conversationId: id, id: `${questionId}-done`, text: "Perfecto, sigo con esa.", delta: false });
      this.emit({ type: "finished", conversationId: id, status: "completed" });
    }, 50);
  }
  override async interrupt(id: string) {
    this.calls.push(`interrupt:${id}`);
    this.emit({ type: "questionClosed", conversationId: id, ids: [`q-${this.sent.length}`], reason: "paused" });
    this.emit({ type: "finished", conversationId: id, status: "interrupted" });
  }
}

await mkdir(out, { recursive: true });
await mkdir(".local", { recursive: true });
const data = await mkdtemp(resolve(".local/capture-questions-"));
const engine = new AskingEngine();
const screenSecret = randomBytes(32).toString("hex");
const server = await serve(engine, data, 0, undefined, undefined, {
  webRoot: resolve("web/dist"),
  kitSource: resolve("kit/turismo"),
}, screenSecret);
await server.app.startEngine();
const browser = await chromium.launch({ channel: "msedge" });
const errors: string[] = [];
async function open(width: number, height: number) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (error) => errors.push(String(error)));
  const origin = `http://127.0.0.1:${server.port}`;
  await page.addInitScript(({ origin, secret }) => {
    if (window === window.top && location.origin === origin)
      Object.defineProperty(window, "__BITACORA_SCREEN_SECRET__", { value: secret });
  }, { origin, secret: screenSecret });
  await page.goto(origin);
  await page.getByLabel("Tu pedido", { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}
async function ask(page: Page, text: string) {
  await page.getByLabel("Tu pedido", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Enviar pedido", exact: true }).click();
  await page.getByRole("group").first().waitFor();
}
try {
  // Desktop: the card as it arrives, then answered with the keyboard only.
  const desktop = await open(1280, 800);
  await ask(desktop, "Ayudame a armar mi marca y mis plantillas para empezar.");
  assert.equal(await desktop.evaluate(() => document.activeElement?.tagName), "H2", "a new question takes the focus");
  await desktop.screenshot({ path: join(out, "pregunta.png") });
  await desktop.keyboard.press("Tab");
  await desktop.keyboard.press("ArrowDown");
  assert.equal(await desktop.getByRole("radio", { name: /La 2/ }).isChecked(), true);
  // The options are one radio group: the next stops are «Ahora no» and «Responder».
  await desktop.keyboard.press("Tab");
  assert.equal(await desktop.evaluate(() => document.activeElement?.textContent), "Ahora no");
  await desktop.keyboard.press("Tab");
  assert.equal(await desktop.evaluate(() => document.activeElement?.textContent), "Responder");
  await desktop.keyboard.press("Enter");
  await desktop.getByText("Muestra: La 2", { exact: true }).waitFor();
  assert.deepEqual(engine.answers.at(-1)?.answers, { muestra: ["La 2"] });
  // With the card gone, the focus goes to the text box, not to the page.
  await desktop.waitForFunction(() => document.activeElement?.id === "request");

  // Two questions in one card, with a written answer in «Otra».
  await ask(desktop, "Sigamos con la forma de hablar.");
  await desktop.getByRole("radio", { name: /Vos/ }).check();
  await desktop.getByRole("group", { name: /Tono/ }).getByRole("radio", { name: "Otra" }).check();
  await desktop.getByLabel(/Tu respuesta a: ¿Preferís algo cálido/).fill("Cálido pero sin emojis");
  await desktop.screenshot({ path: join(out, "pregunta-otra.png") });
  await desktop.getByRole("button", { name: "Responder", exact: true }).click();
  await desktop.getByText(/Trato: Vos\s+Tono: Cálido pero sin emojis/).waitFor();
  assert.deepEqual(engine.answers.at(-1)?.answers, { trato: ["Vos (Recommended)"], tono: ["None of the above", "user_note: Cálido pero sin emojis"] });

  // Narrow: the same card on a phone-sized window.
  await ask(desktop, "Probemos otra vez las muestras.");
  const narrow = await open(390, 844);
  await narrow.getByRole("button", { name: "Abrir trabajos" }).click();
  await narrow.getByRole("button", { name: /Ayudame a armar/ }).click();
  await narrow.getByRole("group").first().scrollIntoViewIfNeeded();
  await narrow.screenshot({ path: join(out, "pregunta-angosta.png") });

  // Paused before answering: the card stays, closed, with the notice. The
  // notice goes into a live region that was already there while it was open.
  const card = desktop.locator("section").filter({ has: desktop.getByRole("heading", { name: "Te hago una pregunta" }) });
  assert.equal(await card.getByRole("status").count(), 1);
  await desktop.getByRole("button", { name: "Pausar pedido" }).click();
  await desktop.getByText(/^Pausaste el trabajo y esta pregunta quedó sin responder/).waitFor();
  await desktop.waitForFunction(() => document.activeElement?.textContent === "Pregunta sin responder");
  await desktop.screenshot({ path: join(out, "pregunta-sin-responder.png") });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ captures: ["pregunta.png", "pregunta-otra.png", "pregunta-angosta.png", "pregunta-sin-responder.png"], keyboard: "PASS", pageErrors: errors }));
} finally {
  await browser.close();
  await server.close();
  await rm(data, { recursive: true, force: true });
}
