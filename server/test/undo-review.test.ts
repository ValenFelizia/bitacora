import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir, rename, symlink, unlink, chmod, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Backups, BACKUP_LIMITS } from '../src/backups';
import { App } from '../src/app';
import { WorkspaceFiles } from '../src/workspace-files';
import { FakeEngine } from './fake-engine';
import { lockForWriting } from './locks';
const target = { workId: 'work', title: 'Prueba', request: 'Cambiar' };
async function fixture() {
  await mkdir('.local', { recursive: true }); const dir = await mkdtemp(resolve('.local/undo-review-'));
  const root = join(dir, 'agency'), data = join(dir, 'data'); await mkdir(root);
  const backups = new Backups(root, data); await backups.initialize();
  return { root, data, backups, close: () => rm(dir, { recursive: true, force: true }) };
}
test('review blocker 1: manual additions and edits survive undo, including a later unchanged request', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'agency.txt'), 'before'); await writeFile(join(f.root, 'personal.txt'), 'personal');
    await f.backups.before(target); await writeFile(join(f.root, 'agency.txt'), 'after'); await f.backups.finish();
    await writeFile(join(f.root, 'foto.jpg'), 'my photo'); await writeFile(join(f.root, 'personal.txt'), 'my edit');
    await f.backups.before(target); await f.backups.finish();
    await f.backups.undo(f.backups.target!.id);
    assert.equal(await readFile(join(f.root, 'foto.jpg'), 'utf8'), 'my photo');
    assert.equal(await readFile(join(f.root, 'personal.txt'), 'utf8'), 'my edit');
    assert.equal(await readFile(join(f.root, 'agency.txt'), 'utf8'), 'before');
  } finally { await f.close(); }
});
test('review blocker 2: write-locked file prevents all mutations, preserves undo and retries', async () => {
  const f = await fixture(); let unlock: (() => Promise<void>) | undefined;
  try {
    await writeFile(join(f.root, 'word.docx'), 'before'); await f.backups.before(target);
    await writeFile(join(f.root, 'word.docx'), 'after'); await writeFile(join(f.root, 'new.txt'), 'new'); await f.backups.finish();
    const id = f.backups.target!.id; unlock = await lockForWriting(join(f.root, 'word.docx'));
    await assert.rejects(f.backups.undo(id));
    assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new');
    assert.equal(f.backups.target?.id, id);
    await unlock(); unlock = undefined;
    await f.backups.undo(id); assert.equal(await readFile(join(f.root, 'word.docx'), 'utf8'), 'before');
  } finally { await unlock?.(); await f.close(); }
});
test('manual edits, moves and deletion of agent-modified files are skipped by name', async () => {
  const f = await fixture();
  try {
    for (const p of ['edición ñ.txt', 'mover.txt', 'borrar.txt', 'revertir.txt']) await writeFile(join(f.root, p), 'before');
    await f.backups.before(target);
    for (const p of ['edición ñ.txt', 'mover.txt', 'borrar.txt', 'revertir.txt']) await writeFile(join(f.root, p), 'after');
    await f.backups.finish();
    await writeFile(join(f.root, 'edición ñ.txt'), 'manual');
    await rename(join(f.root, 'mover.txt'), join(f.root, 'movido.txt')); await unlink(join(f.root, 'borrar.txt'));
    const result = await f.backups.undo(f.backups.target!.id);
    assert.deepEqual(result.skipped.sort(), ['borrar.txt', 'edición ñ.txt', 'mover.txt']);
    assert.equal(await readFile(join(f.root, 'edición ñ.txt'), 'utf8'), 'manual');
    assert.equal(await readFile(join(f.root, 'movido.txt'), 'utf8'), 'after');
    assert.equal(await readFile(join(f.root, 'revertir.txt'), 'utf8'), 'before');
    await assert.rejects(stat(join(f.root, 'borrar.txt')));
  } finally { await f.close(); }
});
test('journal resumes after process death between rename and journal update; cleanup retains both snapshots', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.txt'), 'before-a'); await writeFile(join(f.root, 'b.txt'), 'before-b');
    const crashed = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename, afterStep: async () => { throw new Error('process died'); } });
    await crashed.initialize(); await crashed.before(target);
    await writeFile(join(f.root, 'a.txt'), 'after-a'); await writeFile(join(f.root, 'b.txt'), 'after-b'); await crashed.finish();
    const id = crashed.target!.id; await assert.rejects(crashed.undo(id), /process died/);
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before-a');
    assert.equal(await readFile(join(f.root, 'b.txt'), 'utf8'), 'after-b');
    await crashed.clean(); assert.equal((await readdir(join(f.data, 'backups/objects'))).length, 4);
    const resumed = new Backups(f.root, f.data); await resumed.initialize(crashed.receipt); assert.equal(resumed.target?.retry, true);
    await assert.rejects(resumed.before(target), /pendiente/);
    await resumed.undo(id); assert.equal(await readFile(join(f.root, 'b.txt'), 'utf8'), 'before-b');
    assert.equal(resumed.target, undefined); assert.equal((await readdir(join(f.data, 'backups/objects'))).length, 4);
  } finally { await f.close(); }
});
test('file/directory conflict with hidden contents is rejected before any mutation', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'informe'), 'before'); await f.backups.before(target);
    await unlink(join(f.root, 'informe')); await mkdir(join(f.root, 'informe'));
    await writeFile(join(f.root, 'informe/.keep'), 'excluded'); await writeFile(join(f.root, 'new.txt'), 'new'); await f.backups.finish();
    await assert.rejects(f.backups.undo(f.backups.target!.id), /carpeta con archivos/);
    assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new');
    assert.equal(await readFile(join(f.root, 'informe/.keep'), 'utf8'), 'excluded');
  } finally { await f.close(); }
});
test('individual oversized file is omitted without disabling other undo, and unchanged omissions do not repeat', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'video.mp4'), 'too large to copy'); await writeFile(join(f.root, 'a.txt'), 'old');
    const b = new Backups(f.root, f.data, { ...BACKUP_LIMITS, fileBytes: 8 }); await b.initialize();
    assert.equal(await b.before(target), true); await writeFile(join(f.root, 'a.txt'), 'new'); await writeFile(join(f.root, 'video.mp4'), 'changed oversized');
    await b.finish(); assert.deepEqual(b.latestOmitted, ['video.mp4']);
    await b.before(target); await b.finish(); assert.deepEqual(b.latestOmitted, []);
    const result = await b.undo(b.target!.id); assert.deepEqual(result.omitted, ['video.mp4']);
    assert.equal(await readFile(join(f.root, 'video.mp4'), 'utf8'), 'changed oversized'); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'old');
  } finally { await f.close(); }
});
test('junction introduced DURING restoration cannot redirect a later mutation outside', async () => {
  const f = await fixture(); const outside = join(f.data, 'outside');
  try {
    await mkdir(outside); await writeFile(join(outside, 'victim.txt'), 'after'); await mkdir(join(f.root, 'folder'));
    await writeFile(join(f.root, 'a.txt'), 'before'); await writeFile(join(f.root, 'folder/victim.txt'), 'before');
    let injected = false;
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename, afterStep: async () => {
      if (injected) return; injected = true;
      await rename(join(f.root, 'folder'), join(f.root, 'moved')); await symlink(outside, join(f.root, 'folder'), 'junction');
    } });
    await b.initialize(); await b.before(target);
    await writeFile(join(f.root, 'a.txt'), 'after'); await writeFile(join(f.root, 'folder/victim.txt'), 'after'); await b.finish();
    await assert.rejects(b.undo(b.target!.id), /enlace/);
    assert.equal(await readFile(join(outside, 'victim.txt'), 'utf8'), 'after');
    await unlink(join(f.root, 'folder')); await rename(join(f.root, 'moved'), join(f.root, 'folder'));
    const resumed = new Backups(f.root, f.data); await resumed.initialize(b.receipt); await resumed.undo(resumed.target!.id);
    assert.equal(await readFile(join(f.root, 'folder/victim.txt'), 'utf8'), 'before');
  } finally { await f.close(); }
});
test('tampered manifest or journal cannot escape the workspace; corrupt content fails preflight', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.txt'), 'before'); await f.backups.before(target);
    await writeFile(join(f.root, 'a.txt'), 'after'); await writeFile(join(f.root, 'new.txt'), 'new'); await f.backups.finish();
    const statePath = join(f.data, 'backups/state.json'); const original = JSON.parse(await readFile(statePath, 'utf8'));
    for (const evil of ['../outside.txt', 'C:\\Windows\\bad.txt', 'adjuntos/keep.txt', '.hidden/file']) {
      const state = structuredClone(original); state.undo.before.entries[evil] = Object.values(state.undo.before.entries)[0];
      await writeFile(statePath, JSON.stringify(state)); await assert.rejects(new Backups(f.root, f.data).initialize());
      assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new');
    }
    await writeFile(statePath, JSON.stringify(original));
    const hash = original.undo.before.entries['a.txt'].hash;
    await writeFile(join(f.data, 'backups/objects', hash), 'damaged');
    const b = new Backups(f.root, f.data); await b.initialize(f.backups.receipt); await assert.rejects(b.undo(b.target!.id), /incompleta/);
    assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new'); assert.ok(b.target);
    await unlink(join(f.data, 'backups/objects', hash)); await assert.rejects(b.undo(b.target!.id), /incompleta/);
    assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new');
  } finally { await f.close(); }
});
test('restore preserves original read-only attribute', async () => {
  const f = await fixture(); const path = join(f.root, 'a.txt');
  try {
    await writeFile(path, 'before'); await chmod(path, 0o444); await f.backups.before(target);
    await chmod(path, 0o666); await writeFile(path, 'after'); await f.backups.finish(); await f.backups.undo(f.backups.target!.id);
    assert.equal((await stat(path)).mode & 0o200, 0); assert.equal(await readFile(path, 'utf8'), 'before');
  } finally { await chmod(path, 0o666).catch(() => {}); await f.close(); }
});
test('App uses one scan per moment; context is sent once only to its work; reverted result stays unavailable', async () => {
  const f = await fixture(); const files = new WorkspaceFiles(f.root); const engine = new FakeEngine();
  const app = new App(engine, f.data, () => {}, undefined, files); const contexts: { id: string; text: string; reverted?: boolean }[] = [];
  let scans = 0; const scan = files.scan.bind(files); files.scan = async (...args) => { scans++; return scan(...args); };
  const idle = async () => { const deadline = Date.now() + 15000; while (Date.now() < deadline && app.snapshot().works.some(w => w.busy)) await new Promise(r => setTimeout(r, 10)); assert.equal(app.snapshot().works.some(w => w.busy), false, 'timed out waiting for app idle'); };
  engine.send = async (id, text, _files, context?: { filesReverted?: boolean }) => {
    contexts.push({ id, text, reverted: context?.filesReverted });
    if (text === 'change') await writeFile(join(f.root, 'result.png'), 'after');
    engine.emit({ type: 'finished', conversationId: id, status: 'completed' });
  };
  try {
    await app.start(); await app.command({ type: 'send', text: 'change' }, () => {}); await idle();
    assert.equal(scans, 2); const w = app.snapshot().works[0];
    await app.command({ type: 'undo', id: app.snapshot().undo!.id }, () => {});
    assert.equal(app.snapshot().works[0].messages[0].results![0].reverted, true);
    await app.command({ type: 'send', text: 'other work' }, () => {}); await idle();
    await app.command({ type: 'send', workId: w.id, text: 'continue' }, () => {}); await idle();
    await app.command({ type: 'send', workId: w.id, text: 'again' }, () => {}); await idle();
    assert.deepEqual(contexts.map(c => !!c.reverted), [false, false, true, false]);
    assert.deepEqual(app.snapshot().works.find(work => work.id === w.id)!.messages.filter(m => m.role === 'user').map(m => m.text), ['change', 'continue', 'again']);
    assert.equal(scans, 8); assert.equal(app.snapshot().notice, undefined);
  } finally { await app.close(); await f.close(); }
});
test('failed atomic replacement never removes the destination; partial staging is rebuilt on retry', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.txt'), 'before');
    let fail = true;
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename: async (a, z) => {
      if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return rename(a, z);
    }, afterStep: async () => {} });
    await b.initialize(); await b.before(target); await writeFile(join(f.root, 'a.txt'), 'after'); await b.finish();
    await assert.rejects(b.undo(b.target!.id)); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'after');
    const stage = (await readdir(f.root)).find(p => p.startsWith('.bitacora-undo-')) || `.bitacora-undo-${b.target!.id}-0.tmp`;
    await writeFile(join(f.root, stage), 'partial');
    fail = false; await b.undo(b.target!.id); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before');
    assert.equal((await readdir(f.root)).some(p => p.startsWith('.bitacora-undo-')), false);
  } finally { await f.close(); }
});
test('file/directory swaps without leftovers restore; new directories with manual files survive', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'file'), 'old-file'); await mkdir(join(f.root, 'dir')); await writeFile(join(f.root, 'dir/child'), 'old-child');
    await f.backups.before(target);
    await unlink(join(f.root, 'file')); await mkdir(join(f.root, 'file')); await writeFile(join(f.root, 'file/new-child'), 'new');
    await rm(join(f.root, 'dir'), { recursive: true }); await writeFile(join(f.root, 'dir'), 'new-file');
    await mkdir(join(f.root, 'new-dir')); await f.backups.finish(); await writeFile(join(f.root, 'new-dir/personal'), 'mine');
    await f.backups.undo(f.backups.target!.id);
    assert.equal(await readFile(join(f.root, 'file'), 'utf8'), 'old-file');
    assert.equal(await readFile(join(f.root, 'dir/child'), 'utf8'), 'old-child');
    assert.equal(await readFile(join(f.root, 'new-dir/personal'), 'utf8'), 'mine');
  } finally { await f.close(); }
});
test('completion journal failure preserves retry even after all files were restored', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.txt'), 'before'); await f.backups.before(target); await writeFile(join(f.root, 'a.txt'), 'after'); await f.backups.finish();
    const b = f.backups as any, save = b.save.bind(b);
    b.save = async () => { if (!b.state.undo) throw new Error('completion write failed'); await save(); };
    const id = f.backups.target!.id; await assert.rejects(f.backups.undo(id), /completion write failed/);
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before'); assert.equal(f.backups.target?.retry, true);
    const resumed = new Backups(f.root, f.data); await resumed.initialize(f.backups.receipt); await resumed.undo(id); assert.equal(resumed.target, undefined);
  } finally { await f.close(); }
});
test('App restart exposes retry and blocks new requests until the journal completes; busy undo explains why', async () => {
  const f = await fixture(); const engine = new FakeEngine(); const files = new WorkspaceFiles(f.root);
  let app = new App(engine, f.data, () => {}, undefined, files);
  const idle = async () => { const deadline = Date.now() + 15000; while (Date.now() < deadline && app.snapshot().works.some(w => w.busy)) await new Promise(r => setTimeout(r, 10)); assert.equal(app.snapshot().works.some(w => w.busy), false, 'timed out waiting for app idle'); };
  try {
    await writeFile(join(f.root, 'a.txt'), 'before'); await app.start(); await app.command({ type: 'send', text: 'change' }, () => {});
    const replies: any[] = []; await app.command({ type: 'undo', id: 'busy' }, m => replies.push(m)); assert.match(replies[0].text, /Esperá/);
    await writeFile(join(f.root, 'a.txt'), 'after'); await writeFile(join(f.root, 'new.txt'), 'new');
    engine.emit({ type: 'finished', conversationId: 'conversation-1', status: 'completed' }); await idle();
    (app as any).backups.io.afterStep = async () => { throw new Error('process died'); };
    await app.command({ type: 'undo', id: app.snapshot().undo!.id }, () => {});
    await app.close(); app = new App(engine, f.data, () => {}, undefined, files); await app.start();
    assert.equal(app.snapshot().undo?.retry, true); assert.match(app.snapshot().notice!, /pendiente/);
    const count = engine.sent.length; await app.command({ type: 'send', text: 'must wait' }, m => replies.push(m)); assert.equal(engine.sent.length, count);
    await app.command({ type: 'undo', id: app.snapshot().undo!.id }, () => {}); assert.equal(app.snapshot().undo, undefined);
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before'); await assert.rejects(readFile(join(f.root, 'new.txt')));
  } finally { await app.close(); await f.close(); }
});
test('a file symlink introduced during restoration is rejected without touching its external target', async t => {
  const f = await fixture(); const outside = join(f.data, 'outside.txt');
  try {
    await writeFile(outside, 'after');
    // Probe non-administrative file-symlink support without changing Windows setup.
    try { await symlink(outside, join(f.root, 'probe'), 'file'); await unlink(join(f.root, 'probe')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows does not permit file symlinks for this non-admin process'); return; } throw e; }
    await writeFile(join(f.root, 'a.txt'), 'before'); await writeFile(join(f.root, 'z.txt'), 'before');
    let injected = false;
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename, afterStep: async () => {
      if (injected) return; injected = true; await unlink(join(f.root, 'z.txt')); await symlink(outside, join(f.root, 'z.txt'), 'file');
    } });
    await b.initialize(); await b.before(target); await writeFile(join(f.root, 'a.txt'), 'after'); await writeFile(join(f.root, 'z.txt'), 'after'); await b.finish();
    await assert.rejects(b.undo(b.target!.id), /enlace/); assert.equal(await readFile(outside, 'utf8'), 'after');
  } finally { await f.close(); }
});
