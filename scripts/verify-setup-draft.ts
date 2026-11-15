// Local browser check for the "Armar mi agencia" shortcut: no account, Codex, or inference.
// Run with `npx tsx scripts/verify-setup-draft.ts`. Uses free ports, never 5173 or 4317.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer as createVite } from 'vite';
import { createServer as createProbe } from 'node:net';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serve } from '../server/src/server';
import { FakeEngine } from '../server/test/fake-engine';

const base = resolve(process.env.LOCALAPPDATA!, 'Bitacora-dev/issue29');
const workspace = join(base, 'agencia'), data = join(base, 'datos');
await rm(base, { recursive: true, force: true });
await mkdir(workspace, { recursive: true });
await mkdir(data, { recursive: true });

// The server renders the user message before it calls the engine, so poll instead of asserting once.
async function waitFor(done: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (done()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for the request to reach the engine');
}

const freePort = () => new Promise<number>((done, fail) => {
  const probe = createProbe();
  probe.on('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => done(port));
  });
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const opening = 'Ayudame a armar mi marca y mis plantillas para empezar.';
const draft = 'Mi agencia se llama Rumbo Sur Viajes y vende escapadas.';
const engine = new FakeEngine();
const sent: { text: string; files: string[] }[] = [];
engine.send = async (conversationId, text, files) => {
  sent.push({ text, files: (files || []).map(f => f.path) });
  engine.emit({ type: 'finished', conversationId, status: 'completed' });
};

const serverPort = await freePort();
const webPort = await freePort();
const app = await serve(engine, data, serverPort, `http://127.0.0.1:${webPort}`, workspace);
const vite = await createVite({
  configFile: resolve('web/vite.config.ts'),
  root: resolve('web'),
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/files': { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true, changeOrigin: true },
    },
  },
});
await vite.listen();
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${webPort}`);
  await page.getByText('ChatGPT conectado', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Armar mi agencia' }).waitFor();
  // A new user attaches her logo and types a note before using the shortcut.
  await page.getByLabel('Elegir archivos', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Quitar logo.png' }).waitFor();
  await page.getByLabel('Tu pedido', { exact: true }).fill(draft);
  await page.getByRole('button', { name: 'Armar mi agencia' }).click();
  // The request carries the fixed message, the draft and the attachment.
  await page.getByRole('img', { name: 'logo.png' }).waitFor();
  await waitFor(() => sent.length === 1);
  assert.equal(sent[0].text, `${opening}\n\n${draft}`);
  assert.equal(sent[0].files.length, 1);
  assert.ok((await readFile(sent[0].files[0])).equals(png));
  assert.equal(await page.getByLabel('Tu pedido', { exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Quitar logo.png' }).count(), 0);
  // The normal "Enviar pedido" path still sends only what she wrote.
  await page.getByLabel('Tu pedido', { exact: true }).fill('Ahora armame una propuesta.');
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await waitFor(() => sent.length === 2);
  assert.equal(sent[1].text, 'Ahora armame una propuesta.');
  assert.equal(sent[1].files.length, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: "Armar mi agencia" sends the draft and the attachment; "Enviar pedido" is unchanged');
} finally {
  await browser.close();
  await vite.close();
  await app.close();
  await rm(base, { recursive: true, force: true });
}
