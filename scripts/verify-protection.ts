// Run without inference; uses a separate fake peer and local browser.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdtemp, mkdir, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { serve } from '../server/src/server';
import { CodexEngine } from '../server/src/codex/engine';

const parent = join(process.env.LOCALAPPDATA!, 'Bitacora-dev', 'issue12-browser');
await mkdir(parent, { recursive: true });
const base = await mkdtemp(join(parent, 'run-'));
const output = resolve('docs/verification/issue12');
await mkdir(output, { recursive: true });
process.env.BITACORA_FAKE_SAFETY = 'notConfigured';
process.env.BITACORA_FAKE_SETUP_FAIL = '1';
process.env.BITACORA_FAKE_SETUP_DELAY = '1500';
const engine = () => new CodexEngine({ home: join(base, 'home'), workspace: join(base, 'workspace'),
  binary: process.execPath, args: [resolve('server/test/stdio-server.mjs')], probeProtection: async () => false });
let app: Awaited<ReturnType<typeof serve>> | undefined;
const vite = await createServer({ configFile: resolve('web/vite.config.ts'), root: resolve('web'),
  server: { port: 5174, proxy: { '/ws': { target: 'ws://127.0.0.1:4318', ws: true, changeOrigin: true } } } });
const browser = await chromium.launch({ channel: 'msedge' });
try {
  app = await serve(engine(), join(base, 'data'), 4318, 'http://127.0.0.1:5174');
  await vite.listen();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://127.0.0.1:5174');
  const prepare = page.getByRole('button', { name: 'Preparar la protección', exact: true });
  await prepare.waitFor();
  await page.getByText(/Tocá «Sí»/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Enviar pedido' }).isDisabled(), true);
  await page.screenshot({ path: join(output, 'needed.png') });
  await prepare.click();
  await page.getByRole('button', { name: 'Preparando…', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'preparing.png') });
  await page.getByRole('button', { name: 'Reintentar preparación' }).waitFor();
  await page.screenshot({ path: join(output, 'failed.png') });
  await app.close(); app = undefined;
  delete process.env.BITACORA_FAKE_SETUP_FAIL;
  app = await serve(engine(), join(base, 'data'), 4318, 'http://127.0.0.1:5174');
  await page.reload();
  await page.getByRole('button', { name: 'Preparar la protección', exact: true }).click();
  await page.getByText('Todo listo para empezar.', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'ready.png') });
  await app.close(); app = undefined;
  app = await serve(engine(), join(base, 'data'), 4318, 'http://127.0.0.1:5174');
  await page.reload();
  await page.getByText('Todo listo para empezar.', { exact: true }).waitFor();
  assert.equal(await prepare.count(), 0);
  await page.setViewportSize({ width: 460, height: 800 });
  await page.screenshot({ path: join(output, 'ready-mobile.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: warning before setup, blocked send, progress, failure, retry, persisted readiness, no page errors');
} finally {
  await app?.close(); await browser.close(); await vite.close();
  for (const k of ['BITACORA_FAKE_SAFETY', 'BITACORA_FAKE_SETUP_FAIL', 'BITACORA_FAKE_SETUP_DELAY']) delete process.env[k];
  assert.equal(base.startsWith(join(parent, 'run-')), true);
  await rm(base, { recursive: true, force: true });
  await rmdir(parent).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
}
