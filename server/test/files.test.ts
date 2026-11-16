import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { get } from 'node:http';
import { WebSocket } from 'ws';
import { WorkspaceFiles, MAX_FILE, MAX_REQUEST } from '../src/workspace-files';
import { App } from '../src/app';
import { serve } from '../src/server';
import { FakeEngine } from './fake-engine';
import type { EngineFile } from '../src/engine';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture() {
  await mkdir('.local', { recursive: true });
  const dir = await mkdtemp(resolve('.local/files-'));
  const files = new WorkspaceFiles(join(dir, 'agency'));
  await files.initialize();
  return { dir, files, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const upload = (name = 'foto con ñ y acentós.png') => ({ name, data: png.toString('base64') });

test('attachments validate formats, content, limits and safe unique names without overwriting', async () => {
  const f = await fixture();
  try {
    for (const name of ['foto.png', 'foto.jpg', 'foto.jpeg', 'foto.webp', 'viaje.pdf', 'notas.txt', 'notas.md', 'precios.csv', 'datos.json']) {
      const data = name.endsWith('.png') ? png : name.match(/jpe?g$/) ? Buffer.from([255,216,255,0]) : name.endsWith('.webp') ? Buffer.from('RIFF1234WEBP') : name.endsWith('.pdf') ? Buffer.from('%PDF-1.4') : Buffer.from('Hola, ñ');
      assert.equal(f.files.validate([{ name, data: data.toString('base64') }]).length, 1);
    }
    for (const input of [[upload('programa.exe')], [{ name: 'f.png', data: 'bad' }], [{ name: 'f.txt', data: Buffer.from([0]).toString('base64') }], [{ name: 'f.txt', data: Buffer.from([255]).toString('base64') }], [{ name: 'f.png', data: Buffer.from('not an image').toString('base64') }], Array(11).fill(upload()), [{ name: 'big.txt', data: 'a'.repeat(Math.ceil(MAX_FILE / 3) * 4 + 4) }]]) assert.throws(() => f.files.validate(input));
    const big = { name: 'big.txt', data: Buffer.alloc(MAX_FILE, 65).toString('base64') };
    assert.throws(() => f.files.validate([big, big, { name: 'extra.txt', data: 'YQ==' }]), /40 MB/);
    assert.equal(MAX_REQUEST, MAX_FILE * 2);
    const refs = await f.files.attach('work', f.files.validate([upload(), upload(), upload('../../archivo.png')]));
    assert.equal(refs[0].name, 'foto con ñ y acentós.png');
    assert.notEqual(refs[0].path, refs[1].path);
    assert.equal(refs[2].name, 'archivo.png');
    assert.deepEqual(await f.files.read(refs[0]), png);
    for (const path of ['../secret.png', 'C:/secret.png', '/secret.png', 'adjuntos/../secret.png', '.secret/file.png', 'node_modules/file.png']) await assert.rejects(f.files.safePath(path));
    const outside = join(f.dir, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.png'), png);
    await symlink(outside, join(f.files.root, 'escape'), 'junction');
    await assert.rejects(f.files.safePath('escape/secret.png'));
    await symlink(outside, join(f.files.root, 'adjuntos', 'escape'), 'junction');
    await assert.rejects(f.files.attach('escape', f.files.validate([upload()])));
    await rm(join(f.files.root, 'adjuntos'), { recursive: true });
    await symlink(outside, join(f.files.root, 'adjuntos'), 'junction');
    await assert.rejects(f.files.attach('must-not-exist', f.files.validate([upload()])));
    await assert.rejects(readFile(join(outside, 'must-not-exist')));
  } finally { await f.cleanup(); }
});

test('new and modified results exclude inputs, hidden directories and dependencies, persist per request and survive deletion', async () => {
  const f = await fixture();
  const engine = new FakeEngine();
  let delivered: EngineFile[] = [];
  engine.send = async (_id, _text, files?: EngineFile[]) => { delivered = files || []; };
  let app = new App(engine, join(f.dir, 'data'), () => {}, undefined, f.files);
  try {
    await writeFile(join(f.files.root, 'existing.png'), png);
    await app.start();
    await app.command({ type: 'send', text: 'Mirá https://example.test', attachments: [upload()] }, () => {});
    assert.equal(delivered.length, 1);
    assert.ok(delivered[0].path.includes('adjuntos'));
    const workId = app.snapshot().works[0].id;
    for (const dir of ['.hidden', 'node_modules', 'adjuntos/extra', 'salida']) {
      await mkdir(join(f.files.root, dir), { recursive: true }); await writeFile(join(f.files.root, dir, 'new.png'), png);
    }
    await writeFile(join(f.files.root, 'existing.png'), Buffer.concat([png, Buffer.from('changed')]));
    await writeFile(join(f.files.root, 'salida', 'viaje.pdf'), '%PDF-1.4');
    engine.emit({ type: 'finished', conversationId: 'conversation-1', status: 'completed' });
    await app.close();
    app = new App(new FakeEngine(), join(f.dir, 'data'), () => {}, undefined, f.files);
    await app.start();
    const message = app.snapshot().works[0].messages[0];
    assert.deepEqual(message.results?.map(f => f.name).sort(), ['existing.png', 'new.png', 'viaje.pdf']);
    assert.equal(message.attachments?.[0].name, 'foto con ñ y acentós.png');
    const result = message.results![0];
    await rm(join(f.files.root, result.path));
    await assert.rejects(f.files.read(result));
    assert.equal(app.file(result.id)?.id, result.id);
    await app.command({ type: 'send', workId, text: 'Otra' }, () => {});
    assert.equal(app.snapshot().works[0].messages[1].results, undefined);
  } finally { await app.close(); await f.cleanup(); }
});

test('HTTP files require session token, local host, allowed origin and registered real workspace path', async () => {
  const f = await fixture();
  const engine = new FakeEngine();
  const server = await serve(engine, join(f.dir, 'data'), 0, undefined, f.files.root);
  const base = `http://127.0.0.1:${server.port}`;
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: 'http://127.0.0.1:5173' });
  ws.on('error', () => {});
  const messages: any[] = [];
  ws.on('message', data => messages.push(JSON.parse(String(data))));
  const until = async (check: () => boolean, timeoutMs = 15000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error(`condition timed out after ${timeoutMs}ms`); };
  try {
    await until(() => !!messages[0]);
    const token = messages[0].state.fileToken;
    ws.send(JSON.stringify({ type: 'send', text: 'foto', attachments: [upload()] }));
    await until(() => messages.some(m => m.state?.works[0]?.messages[0]?.attachments?.length));
    const ref = messages.find(m => m.state?.works[0]?.messages[0]?.attachments?.length).state.works[0].messages[0].attachments[0];
    const url = `${base}/files?id=${ref.id}`;
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url + '&token=incorrect')).status, 403);
    assert.equal((await fetch(url + '&token=' + token, { headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal(await new Promise<number | undefined>(resolve => get(url + '&token=' + token, { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); })), 403);
    for (const id of ['../outside.png', 'C:/outside.png', '/outside.png', 'missing']) assert.equal((await fetch(`${base}/files?id=${encodeURIComponent(id)}&token=${token}`)).status, 404);
    const good = await fetch(url + '&token=' + token + '&download=1');
    assert.equal(good.status, 200); assert.match(good.headers.get('content-disposition')!, /attachment.*%C3%B1/);
    assert.deepEqual(Buffer.from(await good.arrayBuffer()), png);
    assert.equal(good.headers.get('access-control-allow-origin'), null);
    await rm(join(f.files.root, ref.path));
    assert.equal((await fetch(url + '&token=' + token)).status, 404);
  } finally {
    const closed = ws.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise<void>(r => { ws.once('close', () => r()); ws.terminate(); });
    await closed;
    await server.close();
    await f.cleanup();
  }
});
