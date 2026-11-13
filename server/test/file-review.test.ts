import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink, readdir, truncate, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { WorkspaceFiles, MAX_RESULT, SCAN_LIMITS } from '../src/workspace-files';
import { App } from '../src/app';
import { FakeEngine } from './fake-engine';
import { serve } from '../src/server';
import type { FileRef } from '../src/contracts';
async function fixture() {
  await mkdir('.local', { recursive: true });
  const dir = await mkdtemp(resolve('.local/review-files-'));
  const files = new WorkspaceFiles(join(dir, 'agency'));
  await files.initialize();
  return { dir, files, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
async function wait(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('timeout');
}

test('whole scan failure releases pending marker, keeps warning and permits send and restart', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  let app = new App(engine, join(f.dir, 'data'), () => {}, undefined, f.files);
  const scan = f.files.scan.bind(f.files);
  try {
    await app.start(); await app.command({ type: 'send', text: 'Primero' }, () => {});
    f.files.scan = async () => { throw new Error('scan root EACCES'); };
    engine.emit({ type: 'finished', conversationId: 'conversation-1', status: 'completed' });
    await wait(() => !app.snapshot().works[0].busy);
    assert.match(app.snapshot().works[0].problem!, /No pude revisar los resultados de ese pedido/);
    f.files.scan = scan;
    await app.command({ type: 'send', text: 'Segundo' }, () => {});
    assert.equal(engine.sent.length, 2);
    await app.close();
    const next = new FakeEngine(); app = new App(next, join(f.dir, 'data'), () => {}, undefined, f.files);
    await app.start(); await app.command({ type: 'send', text: 'Tercero' }, () => {});
    assert.equal(next.sent.length, 1);
  } finally { f.files.scan = scan; await app.close(); await f.cleanup(); }
});

for (const status of ['interrupted', 'failed'] as const) test(`results after ${status}, unchanged hashes and separate pending state`, async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const app = new App(engine, join(f.dir, 'data'), () => {}, undefined, f.files);
  try {
    await writeFile(join(f.files.root, 'old.png'), 'same');
    await app.start(); await app.command({ type: 'send', text: 'Hacé algo' }, () => {});
    const saved = JSON.parse(await readFile(join(f.dir, 'data', 'works.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved.works[0].pendingFiles), ['messageId']);
    assert.equal(JSON.stringify(saved).includes('old.png'), false);
    await writeFile(join(f.files.root, 'new.pdf'), '%PDF-1.4');
    engine.emit({ type: 'finished', conversationId: 'conversation-1', status });
    await wait(() => !app.snapshot().works[0].busy);
    assert.deepEqual(app.snapshot().works[0].messages[0].results?.map(r => r.name), ['new.pdf']);
    assert.deepEqual(await readdir(join(f.dir, 'data', 'pending-files')), []);
    const before = await f.files.scan();
    assert.equal(before.hashedBytes, 0);
    await writeFile(join(f.files.root, 'old.png'), 'same');
    const after = await f.files.scan(before);
    assert.equal(after.entries['old.png'].hash, before.entries['old.png'].hash);
  } finally { await app.close(); await f.cleanup(); }
});

test('preflight failures roll back attachments and do not create empty work', async () => {
  const f = await fixture();
  const scan = f.files.scan.bind(f.files);
  const app = new App(new FakeEngine(), join(f.dir, 'data'), () => {}, undefined, f.files);
  try {
    await app.start();
    f.files.scan = async () => { throw new Error('preflight failed'); };
    await assert.rejects(app.command({ type: 'send', text: 'Prueba', attachments: [{ name: 'nota.txt', data: 'SG9sYQ==' }] }, () => {}), /preflight failed/);
    assert.equal(app.snapshot().works.length, 0);
    for (const directory of await readdir(join(f.files.root, 'adjuntos'))) assert.deepEqual(await readdir(join(f.files.root, 'adjuntos', directory)), []);
    f.files.scan = scan;
    await rm(join(f.files.root, 'adjuntos'), { recursive: true });
    await writeFile(join(f.files.root, 'adjuntos'), 'not a directory');
    await assert.rejects(app.command({ type: 'send', text: 'Prueba', attachments: [{ name: 'nota.txt', data: 'SG9sYQ==' }] }, () => {}));
    assert.equal(app.snapshot().works.length, 0);
  } finally { f.files.scan = scan; await app.close(); await f.cleanup(); }
});

test('long filenames preserve extension and clean the truncated stem', async () => {
  const f = await fixture();
  try {
    const name = 'a'.repeat(132) + ' .  ' + 'b'.repeat(100) + '.txt';
    const valid = f.files.validate([{ name, data: 'SG9sYQ==' }])[0];
    assert.ok(valid.name.endsWith('.txt')); assert.equal(valid.name.length <= 140, true);
    assert.doesNotMatch(valid.name.slice(0, -4), /[. ]$/);
    assert.equal(valid.name.includes('ñ'), false);
  } finally { await f.cleanup(); }
});

test('scan skips broken links, junction loops and external junctions and enforces budgets', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, 'outside')); await writeFile(join(f.dir, 'outside', 'secret.png'), 'outside');
    await symlink(f.files.root, join(f.files.root, 'loop'), 'junction');
    await symlink(join(f.dir, 'absent'), join(f.files.root, 'broken'), 'junction');
    await symlink(join(f.dir, 'outside'), join(f.files.root, 'external'), 'junction');
    await writeFile(join(f.files.root, 'visible.png'), 'visible');
    const scan = await f.files.scan();
    assert.deepEqual(Object.keys(scan.entries), ['visible.png']);
    assert.equal(scan.warnings.filter(w => w.includes('link skipped')).length, 3);
    await writeFile(join(f.files.root, 'huge.pdf'), ''); await truncate(join(f.files.root, 'huge.pdf'), MAX_RESULT + 1);
    assert.match((await f.files.scan()).warnings.join('\n'), /file size limit/);
    for (let i = 0; i < 8; i++) await writeFile(join(f.files.root, `small-${i}.png`), '1234');
    const limited = new WorkspaceFiles(f.files.root, { ...SCAN_LIMITS, files: 2 });
    assert.ok(Object.keys((await limited.scan()).entries).length <= 2);
    const byteLimit = new WorkspaceFiles(f.files.root, { ...SCAN_LIMITS, bytes: 1 });
    assert.match((await byteLimit.scan()).warnings.join('\n'), /hash byte limit/);
  } finally { await f.cleanup(); }
});

test('registered HTTP files enforce paths, headers, HEAD and streaming size cap', async () => {
  const f = await fixture(); const data = join(f.dir, 'data'); await mkdir(data);
  await mkdir(join(f.dir, 'outside')); await writeFile(join(f.dir, 'outside', 'secret.pdf'), '%PDF-1.4');
  await symlink(join(f.dir, 'outside'), join(f.files.root, 'escape'), 'junction');
  await writeFile(join(f.files.root, 'safe.pdf'), '%PDF-1.4'); await writeFile(join(f.files.root, 'safe.png'), 'image');
  await writeFile(join(f.files.root, 'huge.pdf'), ''); await truncate(join(f.files.root, 'huge.pdf'), MAX_RESULT + 1);
  const refs: FileRef[] = ['safe.pdf', 'safe.png', 'huge.pdf', '../outside/secret.pdf', join(f.dir, 'outside', 'secret.pdf'), 'escape/secret.pdf'].map((path, i) => ({ id: String(i), path, name: path.endsWith('.png') ? 'imagen.png' : 'cotización.pdf', mime: path.endsWith('.png') ? 'image/png' : 'application/pdf', createdAt: new Date().toISOString() }));
  await writeFile(join(data, 'works.json'), JSON.stringify({ version: 1, works: [{ id: 'work', conversationId: 'conversation-1', messages: [{ id: 'm', role: 'user', text: 'registered', attachments: refs }], details: '', busy: false }] }));
  const server = await serve(new FakeEngine(), data, 0, undefined, f.files.root);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: 'http://127.0.0.1:5173' });
  try {
    const token = await new Promise<string>(resolve => ws.once('message', data => resolve(JSON.parse(String(data)).state.fileToken)));
    const url = (id: number) => `http://127.0.0.1:${server.port}/files?id=${id}&token=${token}`;
    for (const method of ['GET', 'HEAD']) for (const id of [0, 1]) {
      const res = await fetch(url(id), { method });
      assert.equal(res.status, 200); assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('content-type'), refs[id].mime);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(res.headers.get('content-security-policy'), id === 0 ? "default-src 'none'" : "default-src 'none'; sandbox");
      assert.match(res.headers.get('content-disposition')!, /inline; filename\*=UTF-8''/);
      assert.equal(res.headers.get('content-length'), id === 0 ? '8' : '5');
      assert.equal((await res.arrayBuffer()).byteLength, method === 'HEAD' ? 0 : id === 0 ? 8 : 5);
    }
    const download = await fetch(url(0) + '&download=1');
    assert.match(download.headers.get('content-disposition')!, /attachment.*cotizaci%C3%B3n.pdf/); await download.body?.cancel();
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await fetch(url(2), { method })).status, 413);
      for (const id of [3, 4, 5]) assert.equal((await fetch(url(id), { method })).status, 404, `registered path ${id}`);
    }
  } finally { ws.terminate(); await server.close(); await f.cleanup(); }
});


test('a partial attachment write failure removes already created files', async () => {
  const f = await fixture();
  let calls = 0;
  const files = new WorkspaceFiles(f.files.root, SCAN_LIMITS, { open: async (path, flags, mode) => {
    if (++calls === 2) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
    return open(path, flags, mode);
  } });
  const app = new App(new FakeEngine(), join(f.dir, 'data'), () => {}, undefined, files);
  try {
    await app.start();
    await assert.rejects(app.command({ type: 'send', text: 'Prueba', attachments: [
      { name: 'primero.txt', data: 'SG9sYQ==' }, { name: 'segundo.txt', data: 'SG9sYQ==' },
    ] }, () => {}), /disk failure/);
    assert.equal(app.snapshot().works.length, 0);
    for (const directory of await readdir(join(files.root, 'adjuntos'))) assert.deepEqual(await readdir(join(files.root, 'adjuntos', directory)), []);
  } finally { await app.close(); await f.cleanup(); }
});


test('exclusive Windows file lock is skipped with technical detail', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  const path = join(f.files.root, 'locked.png');
  await writeFile(path, 'locked');
  const script = `$s=[System.IO.File]::Open('${path.replace(/'/g, "''")}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None);[Console]::WriteLine('LOCKED');[Console]::ReadLine()|Out-Null;$s.Dispose()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', chunk => { if (String(chunk).includes('LOCKED')) resolve(); });
      child.stderr.on('data', chunk => reject(new Error(String(chunk))));
      child.once('error', reject);
    });
    const scan = await f.files.scan();
    assert.equal(scan.entries['locked.png'], undefined);
    assert.match(scan.warnings.join('\n'), /locked.png.*(EBUSY|EACCES|EPERM)/);
  } finally { child.stdin.end('\n'); await exited; await f.cleanup(); }
});

test('separate pending snapshot restores results after app closure', async () => {
  const f = await fixture();
  let app = new App(new FakeEngine(), join(f.dir, 'data'), () => {}, undefined, f.files);
  try {
    await app.start(); await app.command({ type: 'send', text: 'Pendiente' }, () => {});
    await app.close();
    await writeFile(join(f.files.root, 'late.png'), 'late result');
    app = new App(new FakeEngine(), join(f.dir, 'data'), () => {}, undefined, f.files);
    await app.start();
    assert.deepEqual(app.snapshot().works[0].messages[0].results?.map(f => f.name), ['late.png']);
    assert.deepEqual(await readdir(join(f.dir, 'data', 'pending-files')), []);
  } finally { await app.close(); await f.cleanup(); }
});

test('only an active scan delays sends; completing it releases the gate', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const app = new App(engine, join(f.dir, 'data'), () => {}, undefined, f.files);
  const scan = f.files.scan.bind(f.files);
  let release!: () => void;
  try {
    await app.start(); await app.command({ type: 'send', text: 'Primero' }, () => {});
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.files.scan = async previous => { await gate; return scan(previous); };
    engine.emit({ type: 'finished', conversationId: 'conversation-1', status: 'completed' });
    await app.command({ type: 'send', text: 'Esperá' }, () => {});
    assert.equal(engine.sent.length, 1);
    release(); await wait(() => !app.snapshot().works[0].busy);
    await app.command({ type: 'send', text: 'Ahora sí' }, () => {});
    assert.equal(engine.sent.length, 2);
  } finally { release?.(); f.files.scan = scan; await app.close(); await f.cleanup(); }
});
