import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { undoFixture } from './undo-rework-fixture';
const fixture = await undoFixture();
const browser = await chromium.launch({ channel: 'msedge' });
try {
  await mkdir('docs/verification/issue4', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto('http://127.0.0.1:5184');
  await page.getByLabel('Tu pedido', { exact: true }).fill('Prepará una propuesta de prueba');
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await page.getByRole('button', { name: 'Deshacer', exact: true }).waitFor();
  await fixture.manual(); fixture.partial();
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  await page.getByRole('button', { name: 'Sí, deshacer', exact: true }).click();
  await page.getByRole('button', { name: 'Reintentar deshacer', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Dejar la carpeta como está', exact: true }).waitFor();
  assert.equal(await readFile(join(fixture.workspace, 'documento.docx'), 'utf8'), 'cambio del pedido');
  await page.screenshot({ path: 'docs/verification/issue4/round3-01-partial-options.png', fullPage: true });
  await Promise.all([
    page.waitForEvent('dialog').then(dialog => dialog.accept()),
    page.getByRole('button', { name: 'Dejar la carpeta como está', exact: true }).click(),
  ]);
  await page.getByRole('status').filter({ hasText: 'Dejé la carpeta como está. Podés seguir trabajando.' }).waitFor();
  await page.getByRole('status').filter({ hasText: 'propuesta.png' }).waitFor();
  await page.getByRole('status').filter({ hasText: 'documento.docx' }).waitFor();
  assert.equal(await readFile(join(fixture.workspace, 'foto personal.jpg'), 'utf8'), 'foto agregada a mano');
  assert.equal(await page.getByRole('button', { name: 'Reintentar deshacer', exact: true }).count(), 0);
  await page.screenshot({ path: 'docs/verification/issue4/round3-02-discarded-summary.png', fullPage: true });
  await page.getByLabel('Tu pedido', { exact: true }).fill('Sigamos con otra propuesta');
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await page.getByText('Sigamos con otra propuesta', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Deshacer', exact: true }).waitFor();
  await page.screenshot({ path: 'docs/verification/issue4/round3-03-new-request.png', fullPage: true });
  console.log('PASS: persistent late failure, retry/discard options, partial summary by name, personal file preserved, next request accepted.');
} finally { await browser.close(); await fixture.close(); }
