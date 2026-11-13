// Local browser fixture: no account, Codex, or inference. Stop with Ctrl+C.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { serve } from '../server/src/server';
import { denyRead } from '../server/test/acl';
import { FakeEngine } from '../server/test/fake-engine';
await mkdir('.local', { recursive: true });
const dir = await mkdtemp(resolve('.local/issue5-browser-'));
const workspace = join(dir, 'agency');
const engine = new FakeEngine();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
engine.send = async (conversationId, _text, _files) => {
  const denied = join(workspace, 'denied'); await mkdir(denied, { recursive: true });
  restore ||= denyRead(denied);
  await writeFile(join(workspace, 'resultado.png'), _files?.[0] ? await readFile(_files[0].path) : png);
  await writeFile(join(workspace, 'viaje.pdf'), pdf);
  engine.emit({ type: 'message', conversationId, id: 'answer', text: 'Te preparé una imagen y un PDF de prueba.', delta: false });
  engine.emit({ type: 'finished', conversationId, status: 'completed' });
};
let restore: (() => unknown) | undefined;
const app = await serve(engine, join(dir, 'data'), 4317, undefined, workspace);
// A valid one-page document, with byte-accurate xref offsets for Edge's viewer.
const pdfObjects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
const pdfText = 'BT /F1 24 Tf 40 200 Td (PDF de prueba - Bitacora) Tj ET';
pdfObjects.push(`<< /Length ${pdfText.length} >>\nstream\n${pdfText}\nendstream`);
let pdf = '%PDF-1.4\n'; const offsets = [0];
pdfObjects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => n.toString().padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const vite = await createServer({ configFile: resolve('web/vite.config.ts'), root: resolve('web') });
await vite.listen();

const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
const page = await context.newPage();
const fileRequests: string[] = [];
page.on('request', request => { if (new URL(request.url()).pathname === '/files') fileRequests.push(request.method() + ' ' + new URL(request.url()).searchParams.get('id')); });
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
    document.querySelector('aside')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, image);
  await page.getByRole('button', { name: 'Quitar playa con ñ.png' }).waitFor();
  await page.getByLabel('Tu pedido', { exact: true }).fill('Prepará una propuesta: https://example.test/viaje');
  await page.screenshot({ path: join(output, 'review-drop-outside.png') });
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  const results = page.getByRole('region', { name: 'Resultados del pedido' });
  await results.getByRole('button', { name: 'Copiar', exact: true }).waitFor();
  await page.getByRole('img', { name: 'playa con ñ.png' }).waitFor();
  const popupPromise = context.waitForEvent('page');
  await results.getByRole('link', { name: 'Abrir', exact: true }).click();
  const popup = await popupPromise; await popup.waitForLoadState();
  assert.ok(popup.url().startsWith('blob:')); assert.ok(!popup.url().includes('token='));
  await popup.waitForTimeout(1500);
  await popup.locator('embed[type="application/pdf"]').waitFor();
  assert.equal(fileRequests.length, 3);
  assert.equal(new Set(fileRequests).size, 3);
  assert.ok(fileRequests.every(r => r.startsWith('GET ')));
  await popup.screenshot({ path: join(output, 'review-pdf-open.png') });
  await popup.close();
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
  await page.getByText('Ver detalle', { exact: true }).click();
  await page.getByText(/denied:.*EACCES|denied:.*EPERM/).waitFor();
  await page.screenshot({ path: join(output, 'review-denied-result.png') });
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
  console.log('PASS: drop outside form, picker, thumbnail, link, result with denied folder, Edge PDF blob viewer, one GET per card, clipboard, exact download, keyboard gallery, reload, missing file, mobile overflow');
} finally {
  restore?.();
  await browser.close(); await app.close(); await vite.close();
  await rm(dir, { recursive: true, force: true });
}
