// Screenshots for issues #56 and #57 on the built screen, in Edge: the works
// list, the model picker, the copy button and the deliverables panel, on a
// desktop window and a narrow one. `antes` was taken on main (cd47e21) before
// the change; `despues` on this branch. Steps that only exist after the change
// are skipped on the old screen. The works and plates are seeded on disk and a
// fake engine answers: no Codex, no account, no inference.
// Run `npm run build` first: `npx tsx scripts/capture-uso-y-modelo.ts despues`.
import { chromium, type Browser, type Page } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve } from "../server/src/server";
import { FAKE_CATALOGUE, FakeEngine } from "../server/test/fake-engine";

const phase = process.argv[2] === "antes" ? "antes" : "despues";
const out = "docs/design/capturas";
const plates = ["Porto de Galinhas", "Todo incluido", "Vuelo y traslados", "Desde USD 1.670"];

/** Draws one 1080×1920 plate with thin lines and small text, the details that show blur. */
async function drawPlates(browser: Browser, folder: string) {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  const names: string[] = [];
  for (const [index, title] of plates.entries()) {
    await page.setContent(`<!doctype html><html><body style="margin:0;width:1080px;height:1920px;background:${index % 2 ? "#fffcf5" : "#1d2838"};color:${index % 2 ? "#1d2838" : "#fffcf5"};font-family:Georgia,serif;display:flex;flex-direction:column;justify-content:space-between;padding:96px;box-sizing:border-box">
      <div style="font:600 34px/1.3 system-ui;letter-spacing:6px;text-transform:uppercase;border-bottom:3px solid #d4612a;padding-bottom:24px">787 Rumbos · Febrero 2027</div>
      <div><div style="font-size:150px;line-height:1">${title}</div>
      <div style="margin-top:40px;font:34px/1.5 system-ui">8 noches · vuelo desde Córdoba · traslados · asistencia al viajero</div></div>
      <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:10px">${Array.from({ length: 48 }, () => `<div style="height:22px;border:2px solid currentColor"></div>`).join("")}</div>
    </body></html>`);
    const name = `placa-0${index + 1}.png`;
    await page.screenshot({ path: join(folder, name) });
    names.push(name);
  }
  await page.close();
  return names;
}

await mkdir(out, { recursive: true });
await mkdir(".local", { recursive: true });
const base = await mkdtemp(resolve(".local/capture-uso-"));
const data = join(base, "data");
const workspace = join(base, "workspace");
const browser = await chromium.launch({ channel: "msedge" });
const errors: string[] = [];
let server: Awaited<ReturnType<typeof serve>> | undefined;
try {
  await mkdir(join(workspace, "propuestas", "porto", "salida"), { recursive: true });
  await mkdir(data, { recursive: true });
  const names = await drawPlates(browser, join(workspace, "propuestas", "porto", "salida"));
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 18, 17, minutes)).toISOString();
  const work = (id: string, title: string, minutes: number, extra: object = {}) => ({
    id,
    conversationId: `conversation-${id}`,
    title,
    createdAt: at(minutes),
    updatedAt: at(minutes + 5),
    messages: [],
    details: "",
    busy: false,
    progress: "Listo.",
    ...extra,
  });
  const results = names.map((name, index) => ({
    id: `placa-${index + 1}`,
    path: join("propuestas", "porto", "salida", name),
    name,
    mime: "image/png",
    createdAt: at(50),
  }));
  const works = [
    work("w-porto", "Porto de Galinhas, febrero", 40, {
      messages: [
        { id: "u1", role: "user", text: "Armame una propuesta con este link: https://example.test/porto" },
        {
          id: "a1",
          role: "assistant",
          text: "Listo. Te armé **4 placas** con el hotel, el vuelo y el precio.\n\n- Portada con la playa.\n- Qué incluye el todo incluido.\n- Vuelo desde Córdoba y traslados.\n- Precio desde USD 1.670 por persona.",
          results,
        },
      ],
    }),
    work("w-cancun", "Cancún en familia", 20),
    work("w-bariloche", "Bariloche, vacaciones de invierno", 10),
    work("w-marca", "Mi marca y plantillas", 0),
  ];
  await writeFile(join(data, "works.json"), JSON.stringify({ version: 1, works }, null, 2));

  const engine = new FakeEngine();
  server = await serve(engine, data, 0, undefined, workspace, {
    webRoot: resolve("web/dist"),
    kitSource: resolve("kit/turismo"),
  });
  await server.app.startEngine();

  async function open(width: number, height: number) {
    // 150 % is the usual Windows scale on a laptop: the density the thumbnails are drawn for.
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1.5,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server!.port}`);
    await page.getByLabel("Tu pedido", { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    return page;
  }
  async function selectWork(page: Page, narrow: boolean) {
    if (narrow) await page.getByRole("button", { name: "Abrir trabajos" }).click();
    await page.getByRole("button", { name: /Porto de Galinhas, febrero/ }).click();
    await page.getByText("Te armé").waitFor();
  }
  const file = (name: string, narrow = false) => join(out, `${name}-${phase}${narrow ? "-angosto" : ""}.png`);
  const shot = (page: Page, name: string, narrow = false) => page.screenshot({ path: file(name, narrow) });
  const plateImages = (page: Page) => page.locator("aside img");
  async function platesReady(page: Page) {
    await plateImages(page).first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("aside img")].every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0));
    await page.waitForTimeout(300);
  }

  // Desktop.
  const desktop = await open(1280, 800);
  await desktop.screenshot({ path: file("barra-lateral"), clip: { x: 0, y: 0, width: 520, height: 800 } });
  await selectWork(desktop, false);
  await platesReady(desktop);
  await shot(desktop, "principal");
  const picker = desktop.getByRole("button", { name: /^Modelo:/ });
  if (await picker.count()) {
    await picker.click();
    await desktop.getByRole("menu").waitFor();
  }
  await shot(desktop, "selector-modelo");
  if (await picker.count()) await desktop.keyboard.press("Escape");
  const copy = desktop.getByRole("button", { name: "Copiar mensaje" }).first();
  if (await copy.count()) {
    await copy.focus();
    await desktop.keyboard.press("Enter");
    await desktop.getByText("Copiado", { exact: true }).waitFor();
  }
  await desktop.screenshot({ path: file("copiar"), clip: { x: 220, y: 0, width: 760, height: 800 } });
  const separator = desktop.getByRole("separator", { name: /entregables/i });
  if (await separator.count()) {
    const box = (await separator.boundingBox())!;
    await desktop.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await desktop.mouse.down();
    await desktop.mouse.move(box.x - 180, box.y + box.height / 2, { steps: 8 });
    await desktop.mouse.up();
    await platesReady(desktop);
  }
  await shot(desktop, "panel-ancho");
  await desktop.screenshot({ path: file("miniaturas"), clip: { x: 680, y: 0, width: 600, height: 520 } });

  // Narrow.
  const narrow = await open(390, 844);
  await narrow.getByRole("button", { name: "Abrir trabajos" }).click();
  await shot(narrow, "barra-lateral", true);
  await narrow.getByRole("button", { name: /Porto de Galinhas, febrero/ }).click();
  await narrow.getByText("Te armé").waitFor();
  const narrowPicker = narrow.getByRole("button", { name: /^Modelo:/ });
  if (await narrowPicker.count()) {
    await narrowPicker.click();
    await narrow.getByRole("menu").waitFor();
  }
  await shot(narrow, "selector-modelo", true);
  if (await narrowPicker.count()) await narrow.keyboard.press("Escape");
  const narrowCopy = narrow.getByRole("button", { name: "Copiar mensaje" }).first();
  if (await narrowCopy.count()) {
    await narrowCopy.click();
    await narrow.getByText("Copiado", { exact: true }).waitFor();
  }
  await shot(narrow, "copiar", true);
  await narrow.getByRole("button", { name: "Abrir entregables" }).click();
  await platesReady(narrow);
  await shot(narrow, "panel", true);

  if (phase === "despues") {
    // The divider answers the arrows and remembers the width for the next session.
    const before = Number(await separator.getAttribute("aria-valuenow"));
    await separator.focus();
    await desktop.keyboard.press("ArrowLeft");
    assert.equal(Number(await separator.getAttribute("aria-valuenow")), before + 16);
    await desktop.keyboard.press("ArrowRight");
    assert.equal(Number(await separator.getAttribute("aria-valuenow")), before);
    await desktop.waitForTimeout(500);
    assert.equal(server!.app.snapshot().panelWidth, before);

    // Shift+Enter makes a new paragraph; Enter sends.
    const box = desktop.getByLabel("Tu pedido", { exact: true });
    await box.fill("Sumá una placa");
    await box.press("Shift+Enter");
    await box.pressSequentially("con el mapa");
    assert.equal(await box.inputValue(), "Sumá una placa\ncon el mapa");
    assert.equal(engine.sent.length, 0);
    await box.press("Enter");
    await desktop.waitForFunction(() => (document.getElementById("request") as HTMLTextAreaElement).value === "");
    assert.deepEqual(engine.sent, ["Sumá una placa\ncon el mapa"]);
    // With the request running the button pauses, and Enter keeps its new line.
    await desktop.getByRole("button", { name: "Pausar pedido" }).waitFor();
    await box.pressSequentially("Después");
    await box.press("Enter");
    await box.pressSequentially("sumá otra");
    assert.equal(await box.inputValue(), "Después\nsumá otra");
    assert.equal(engine.sent.length, 1);
    await box.fill("");
    engine.emit({ type: "finished", conversationId: "conversation-w-porto", status: "completed" });
    await desktop.getByRole("button", { name: "Enviar pedido" }).waitFor();
    await desktop.locator("main").click({ position: { x: 20, y: 20 } });

    // The account without the recommended model: the screen says which one works instead.
    engine.catalogue = FAKE_CATALOGUE.filter((model) => model.id !== "gpt-6.2-sol");
    engine.emit({ type: "account", account: { connected: true } });
    await desktop.getByText(/no está disponible en tu cuenta/).waitFor();
    await desktop.screenshot({ path: file("selector-modelo-aviso"), clip: { x: 220, y: 400, width: 760, height: 400 } });

    // Another account whose list fails: the old models are not offered, and
    // the menu can ask again.
    engine.catalogue = "fail";
    engine.emit({ type: "account", account: { connected: true, email: "otra@example.test" } });
    await desktop.getByText(/no está disponible en tu cuenta/).waitFor({ state: "detached" });
    await picker.click();
    const retry = desktop.getByRole("menuitem", { name: "Volver a intentar" });
    await retry.waitFor();
    await desktop.getByText("No pude traer la lista de modelos de tu cuenta.", { exact: false }).waitFor();
    await desktop.screenshot({ path: file("selector-modelo-reintentar"), clip: { x: 220, y: 300, width: 760, height: 500 } });
    engine.catalogue = FAKE_CATALOGUE;
    await retry.click();
    await desktop.getByRole("menuitemradio", { name: /GPT-6.1 Terra/ }).waitFor();
    await desktop.keyboard.press("Escape");
  }

  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({ phase, out, pageErrors: errors }));
} finally {
  await browser.close();
  await server?.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
