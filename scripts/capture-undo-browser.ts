// Fallback after shared preview snapshot timeout. Requires verify-undo-browser.ts.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
await mkdir('docs/verification/issue4', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto('http://127.0.0.1:5184');
  await page.getByLabel('Tu pedido', { exact: true }).fill('Prepará una propuesta de prueba');
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await page.getByRole('button', { name: 'Deshacer', exact: true }).waitFor();
  await page.screenshot({ path: 'docs/verification/issue4/01-request.png', fullPage: true });
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  await page.getByRole('group', { name: 'Confirmar Deshacer' }).waitFor();
  await page.screenshot({ path: 'docs/verification/issue4/02-confirm.png', fullPage: true });
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  await page.getByRole('button', { name: 'Sí, deshacer', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Tu carpeta volvió a estar como antes' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Deshacer', exact: true }).count(), 0);
  await page.screenshot({ path: 'docs/verification/issue4/03-restored.png', fullPage: true });
  console.log('PASS: request, undo available, confirmation, cancellation, restoration notice and consumed button');
} finally { await browser.close(); }
