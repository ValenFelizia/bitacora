// Local browser fixture: no account, Codex, or inference. Stop with Ctrl+C.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { serve } from '../server/src/server';
import { FakeEngine } from '../server/test/fake-engine';
await mkdir('.local', { recursive: true });
const dir = await mkdtemp(resolve('.local/issue5-browser-'));
const workspace = join(dir, 'agency');
const engine = new FakeEngine();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
engine.send = async (conversationId, _text, _files) => {
  await writeFile(join(workspace, 'resultado.png'), _files?.[0] ? await readFile(_files[0].path) : png);
  await writeFile(join(workspace, 'viaje.pdf'), '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
  engine.emit({ type: 'message', conversationId, id: 'answer', text: 'Te preparé una imagen y un PDF de prueba.', delta: false });
  engine.emit({ type: 'finished', conversationId, status: 'completed' });
};
const app = await serve(engine, join(dir, 'data'), 4317, undefined, workspace);
const vite = await createServer({ configFile: resolve('web/vite.config.ts'), root: resolve('web') });
await vite.listen();

const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
const page = await context.newPage();
const output = resolve('docs/verification/issue5');
await mkdir(output, { recursive: true });
try {
  await page.goto('http://127.0.0.1:5173');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
    const c = canvas.getContext('2d')!; c.fillStyle = '#72949c'; c.fillRect(0, 0, 600, 400);
    c.fillStyle = '#f3e3be'; c.fillRect(0, 280, 600, 120);
    c.fillStyle = '#fff'; c.font = '28px sans-serif'; c.fillText('Playa de prueba', 30, 60);
    return canvas.toDataURL().split(',')[1];
  });
  await page.evaluate(data => {
    const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'playa con ñ.png', { type: 'image/png' }));
    document.querySelector('form')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, image);
  await page.getByRole('button', { name: 'Quitar playa con ñ.png' }).waitFor();
  await page.getByLabel('Tu pedido', { exact: true }).fill('Prepará una propuesta: https://example.test/viaje');
  await page.screenshot({ path: join(output, 'drop.png') });
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  const results = page.getByRole('region', { name: 'Resultados del pedido' });
  await results.getByRole('button', { name: 'Copiar', exact: true }).waitFor();
  await page.getByRole('img', { name: 'playa con ñ.png' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'https://example.test/viaje' }).getAttribute('href'), 'https://example.test/viaje');
  await results.getByRole('button', { name: 'Copiar', exact: true }).click();
  await page.getByText('Imagen copiada.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await navigator.clipboard.read())[0].types.includes('image/png')), true);
  const downloadEvent = page.waitForEvent('download');
  await results.getByRole('button', { name: 'Guardar', exact: true }).first().click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'resultado.png');
  const downloaded = join(dir, 'download.png'); await download.saveAs(downloaded);
  assert.deepEqual(await readFile(downloaded), Buffer.from(image, 'base64'));
  await results.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'conversation.png') });
  await page.getByRole('button', { name: 'Galería', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Todo lo que creamos' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Copiar', exact: true }).count(), 1);
  assert.equal(await page.getByRole('link', { name: 'Abrir', exact: true }).count(), 1);
  await page.screenshot({ path: join(output, 'gallery.png') });
  await page.getByRole('button', { name: 'Ir al trabajo' }).focus(); await page.keyboard.press('Enter');
  await results.waitFor();
  await page.reload(); await page.locator('nav button').click(); await results.waitFor();
  // Native file selection uses the same attachment path as dropping.
  await page.getByLabel('Elegir archivos', { exact: true }).setInputFiles({ name: 'notas con ñ.txt', mimeType: 'text/plain', buffer: Buffer.from('Hola, una nota.') });
  await page.getByRole('button', { name: 'Quitar notas con ñ.txt' }).waitFor();
  await rm(join(workspace, 'resultado.png'));
  await page.getByRole('button', { name: 'Galería', exact: true }).click();
  await page.getByText('Este archivo ya no está disponible.', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'missing.png') });
  await page.setViewportSize({ width: 460, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'gallery-mobile.png') });
  console.log('PASS: drop, picker, thumbnail, link, result, image clipboard, exact download, keyboard gallery, return, reload, missing file, mobile overflow');
} finally {
  await browser.close(); await app.close(); await vite.close();
  await rm(dir, { recursive: true, force: true });
}
