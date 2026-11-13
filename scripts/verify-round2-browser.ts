import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { serve } from '../server/src/server';
import { CodexEngine } from '../server/src/codex/engine';
import { resolve, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

const base = resolve('.local/issue16-verify-round2-browser');
await mkdir(base, { recursive: true });
await mkdir('docs/verification/pr11', { recursive: true });
process.env.BITACORA_FAKE_IDLE_CRASH = '1';
let server: Awaited<ReturnType<typeof serve>> | undefined;
const browser = await chromium.launch({ channel: 'msedge' });
try {
  server = await serve(new CodexEngine({
    home: join(base, 'codex'), workspace: join(base, 'workspace'),
    binary: process.execPath, args: [resolve('server/test/stdio-server.mjs')], restartDelayMs: 100,
  }), join(base, 'data'));
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.entryUrl);
  await page.getByText('ChatGPT conectado', { exact: true }).waitFor();
  assert.equal(await page.getByText('Detalle del motor', { exact: true }).count(), 0);
  const newWork = page.getByRole('button', { name: '+ Nuevo trabajo', exact: true });
  const send = page.getByRole('button', { name: 'Enviar pedido', exact: true });
  await page.getByLabel('Tu pedido', { exact: true }).fill('race');
  for (const button of [newWork, send]) {
    await button.hover();
    const colors = await button.evaluate(el => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor, border: s.borderTopColor };
    });
    assert.deepEqual(colors, { color: 'rgb(255, 255, 255)', background: 'rgb(34, 72, 62)', border: 'rgb(49, 89, 77)' });
  }
  await send.click();
  const selected = page.locator('button[aria-current="page"]');
  await selected.waitFor();
  assert.equal(await selected.evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(217, 221, 210)');
  await page.screenshot({ path: 'docs/verification/pr11/round2-buttons.png' });
  await page.getByText('El motor se detuvo. Estoy intentando volver a conectarlo.', { exact: true }).waitFor();
  assert.equal(await page.getByText(/No pude completar el pedido/).count(), 0);
  const details = page.locator('details').filter({ has: page.getByText('Detalle del motor', { exact: true }) });
  assert.equal(await details.getAttribute('open'), null);
  assert.equal(await details.locator('pre').isVisible(), false);
  const retry = page.getByRole('button', { name: 'Reintentar', exact: true });
  await retry.waitFor({ timeout: 30000 });
  await page.screenshot({ path: 'docs/verification/pr11/round2-exhausted.png' });
  delete process.env.BITACORA_FAKE_IDLE_CRASH;
  await retry.click();
  await page.getByText('ChatGPT conectado', { exact: true }).waitFor();
  assert.equal(await retry.count(), 0);
  assert.equal(await page.getByText('Detalle del motor', { exact: true }).count(), 0);
  await page.screenshot({ path: 'docs/verification/pr11/round2-recovered.png' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ hover: 'PASS', selectedBorder: 'PASS', idleCrash: 'PASS', exhaustedRetry: 'PASS', foldedDetails: 'PASS', pageErrors: errors }));
} finally {
  delete process.env.BITACORA_FAKE_IDLE_CRASH;
  await server?.close();
  await browser.close();
  await rm(base, { recursive: true, force: true });
}
