import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { App } from '../src/app';
import { Backups, BACKUP_LIMITS } from '../src/backups';
import { WorkspaceFiles } from '../src/workspace-files';
import { AgencyFiles } from '../src/tools/paths';
import { initializeKit } from '../src/tools/kit';
import { allowedUrlsPath, readAllowedUrls, rememberUserUrls } from '../src/allowed-urls';
import { FakeEngine } from './fake-engine';
import { photoFixture } from './photo-fixture';

async function fixture() {
  await mkdir('.local', { recursive: true }); const base = await mkdtemp(resolve('.local/kit-undo-'));
  const root = join(base, 'agency'), data = join(base, 'data'); await mkdir(root); await mkdir(data);
  return { root, data, close: () => rm(base, { recursive: true, force: true }) };
}
test('kit starter edits undo, moving kit artifacts are ignored, and maintenance preserves kit data', async () => {
  const f = await fixture();
  try {
    await initializeKit(f.root, f.data); await rememberUserUrls(f.data, 'https://user.example/');
    const marker = (await readdir(f.data)).find(p => p.startsWith('kit-initialized-')); assert.ok(marker);
    const protectedData = await Promise.all([marker, 'allowed-urls.json'].map(p => readFile(join(f.data, p))));
    const original = await Promise.all(['AGENTS.md', 'ejemplo/pieza.html'].map(p => readFile(join(f.root, p))));
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined);
    await b.initialize();
    await writeFile(join(f.root, '.kit-input.tmp'), 'outside the copy');
    // Remove a temp while another file is being copied, not merely between scans.
    const files = b.files, scan = files.scan.bind(files);
    files.scan = (previous, copy) => scan(previous, copy && { ...copy, capture: async (p, s) => {
      await rm(join(f.root, '.kit-input.tmp'), { force: true }); await writeFile(join(f.root, '.kit-guard-changing'), 'guard');
      return copy.capture(p, s);
    } });
    assert.equal(await b.before({ workId: 'kit', title: 'Editar', request: 'Editar el kit' }), true);
    assert.ok(!Object.keys(b.lastScan!.entries).some(p => p.startsWith('.kit-')));
    for (const p of ['AGENTS.md', 'ejemplo/pieza.html']) await writeFile(join(f.root, p), 'edited in request');
    assert.equal(await b.finish(), true); await b.undo(b.target!.id);
    for (const [i, p] of ['AGENTS.md', 'ejemplo/pieza.html'].entries()) assert.deepEqual(await readFile(join(f.root, p)), original[i]);
    assert.equal(await readFile(join(f.root, '.kit-guard-changing'), 'utf8'), 'guard');
    await b.clean();
    for (let i = 0; i < 3; i++) { await b.before({ workId: 'kit', title: 'Sin cambios', request: 'Seguir' }); await b.finish(); }
    await b.purgeTrash(Date.now() + 8 * 86400000);
    assert.deepEqual(await readdir(join(f.data, 'backups/trash')), ['clock.json']);
    await b.before({ workId: 'kit', title: 'Limpieza', request: 'Seguir' }); await b.finish();
    for (const [i, p] of [marker, 'allowed-urls.json'].entries()) assert.deepEqual(await readFile(join(f.data, p)), protectedData[i]);
  } finally { await f.close(); }
});

test('real kit MCP writes within a fake-engine request share two scans, exclude inputs from results and undo all tool files', async () => {
  const f = await fixture(), engine = new FakeEngine(), files = new WorkspaceFiles(f.root), agency = new AgencyFiles(f.root);
  const app = new App(engine, f.data, () => {}, undefined, files);
  const png = photoFixture();
  const operator = createServer((req, res) => req.url === '/photo'
    ? res.writeHead(200, { 'content-type': 'image/png' }).end(png)
    : res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Oferta</h1><p>7 noches</p><img src="/photo">'));
  await new Promise<void>(r => operator.listen(0, '127.0.0.1', r));
  const address = operator.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`, url = origin + '/offer';
  const client = new Client({ name: 'kit-undo-test', version: '1' });
  let scans = 0; const scan = files.scan.bind(files); files.scan = (...args) => { scans++; return scan(...args); };
  try {
    await app.start();
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href, resolve('server/test/kit-mcp.ts'), f.root, allowedUrlsPath(f.data), origin], stderr: 'pipe' }));
    let requestCount = 0, contextSeen = false;
    engine.send = async (id, text, _attachments, context?: { filesReverted?: boolean }) => {
      requestCount++;
      if (requestCount === 1) {
        assert.equal(text, url); assert.deepEqual(await readAllowedUrls(allowedUrlsPath(f.data)), [url]);
        await agency.write('propuesta/pieza.html', '<style>body{margin:0}section{width:128px;height:128px}</style><section data-piece>Oferta</section>');
        for (const [name, args] of [
          ['traer', { url, destination: 'propuesta' }],
          ['dibujar', { html: 'propuesta/pieza.html', destination: 'propuesta/salida', width: 128, height: 128 }],
        ] as const) {
          const response = await client.callTool({ name, arguments: args }); assert.ok(!response.isError, JSON.stringify(response));
          assert.ok(!JSON.stringify(response).includes('"ok":false'), JSON.stringify(response));
        }
      } else contextSeen = !!context?.filesReverted;
      engine.emit({ type: 'finished', conversationId: id, status: 'completed' });
    };
    const idle = async () => { for (let i = 0; i < 500 && app.snapshot().works.some(w => w.busy); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(!app.snapshot().works.some(w => w.busy)); };
    await app.command({ type: 'send', text: url }, () => {}); await idle();
    assert.equal(scans, 2);
    const work = app.snapshot().works[0], results = work.messages[0].results!;
    assert.deepEqual(results.map(r => r.name).sort(), ['pieza-1.png', 'piezas.pdf', 'todas.png']);
    const photos = await readdir(join(f.root, 'propuesta/fotos/operador')); assert.ok(photos.length);
    await app.command({ type: 'undo', id: app.snapshot().undo!.id }, () => {});
    assert.equal(app.snapshot().undo, undefined);
    for (const p of ['propuesta/fuente.md', 'propuesta/pieza.html', ...photos.map(p => `propuesta/fotos/operador/${p}`), ...results.map(r => r.path)]) await assert.rejects(stat(join(f.root, p)), { code: 'ENOENT' });
    assert.ok((await readdir(join(f.data, 'backups/trash'))).some(p => p !== 'clock.json'));
    assert.ok(app.snapshot().works[0].messages[0].results!.every(r => r.reverted));
    assert.deepEqual(await readAllowedUrls(allowedUrlsPath(f.data)), [url]);
    await app.command({ type: 'send', workId: work.id, text: 'Continuar' }, () => {}); await idle();
    assert.equal(contextSeen, true); assert.equal(scans, 4);
    assert.deepEqual(await readAllowedUrls(allowedUrlsPath(f.data)), [url]);
    assert.equal(app.snapshot().works[0].messages.at(-1)?.text, 'Continuar');
  } finally {
    await client.close(); await app.close(); operator.closeAllConnections(); await new Promise<void>(r => operator.close(() => r())); await f.close();
  }
});
