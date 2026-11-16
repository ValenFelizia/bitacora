import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir, symlink, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Backups, BACKUP_LIMITS } from '../src/backups';
import { WorkspaceFiles } from '../src/workspace-files';
import { App } from '../src/app';
import { FakeEngine } from './fake-engine';
import { denyRead } from './acl';
import { lockForWriting } from './locks';
const target = { workId: 'work', title: 'Propuesta', request: 'Prepará la propuesta' };
test('a Windows exclusive lock omits only that file without hanging', async () => {
  const f = await fixture();
  const path = join(f.root, 'bloqueado.txt'); await writeFile(path, 'contenido');
  let unlock: (() => Promise<void>) | undefined;
  try {
    unlock = await lockForWriting(path, 'None');
    assert.equal(await f.backups.before(target), true); assert.equal(f.backups.target, undefined);
  } finally { await unlock?.(); await f.close(); }
});
async function fixture() {
  await mkdir('.local', { recursive: true });
  const dir = await mkdtemp(resolve('.local/undo-'));
  const root = join(dir, 'agency'), data = join(dir, 'data');
  await mkdir(root); const backups = new Backups(root, data); await backups.initialize();
  return { dir, root, data, backups, close: () => rm(dir, { recursive: true, force: true }) };
}
test('deduplicated copies restore create/modify/delete, unicode, empty directories, restart, cleanup and one undo', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'Carpeta ñ')); await mkdir(join(f.root, 'vacía'));
    for (const name of ['Carpeta ñ/cotización.txt', 'borrar.txt']) await writeFile(join(f.root, name), 'original');
    assert.equal(await f.backups.before(target), true);
    assert.equal((await readdir(join(f.data, 'backups/objects'))).length, 1);
    await writeFile(join(f.root, 'Carpeta ñ/cotización.txt'), 'modificado');
    await unlink(join(f.root, 'borrar.txt')); await writeFile(join(f.root, 'nuevo.png'), 'nuevo');
    await f.backups.finish();
    // Both snapshots survive restart; do not reconstruct an after-state at startup.
    const restarted = new Backups(f.root, f.data); await restarted.initialize(f.backups.receipt);
    assert.ok(restarted.target);
    await restarted.undo(restarted.target!.id);
    assert.equal(await readFile(join(f.root, 'Carpeta ñ/cotización.txt'), 'utf8'), 'original');
    assert.equal(await readFile(join(f.root, 'borrar.txt'), 'utf8'), 'original');
    await assert.rejects(readFile(join(f.root, 'nuevo.png')));
    assert.equal(restarted.target, undefined); assert.equal(restarted.hasNotice('work'), true);
    assert.ok((await readdir(join(f.data, 'backups/objects'))).length > 0); // Deferred collection; live trash retains references.
    await assert.rejects(restarted.undo('old'));
    assert.equal(await restarted.before(target), true); await restarted.finish(); assert.equal(restarted.target, undefined);
  } finally { await f.close(); }
});
test('junctions outside are skipped; restoring through a substituted junction fails before touching outside', async () => {
  const f = await fixture();
  try {
    const outside = join(f.dir, 'outside'); await mkdir(outside); await writeFile(join(outside, 'testigo.txt'), 'intacto');
    await symlink(outside, join(f.root, 'enlace'), 'junction');
    await mkdir(join(f.root, 'real')); await writeFile(join(f.root, 'real/testigo.txt'), 'adentro');
    assert.equal(await f.backups.before(target), true);
    await rm(join(f.root, 'real'), { recursive: true }); await symlink(outside, join(f.root, 'real'), 'junction');
    await writeFile(join(f.root, 'nuevo.txt'), 'nuevo'); await f.backups.finish();
    await assert.rejects(f.backups.undo(f.backups.target!.id), /enlace/);
    assert.equal(await readFile(join(outside, 'testigo.txt'), 'utf8'), 'intacto');
    assert.equal(await readFile(join(f.root, 'nuevo.txt'), 'utf8'), 'nuevo');
  } finally { await f.close(); }
});
test('excluded content survives undo; limits and unreadable folders invalidate copies', async () => {
  const f = await fixture(); let restore: (() => unknown) | undefined;
  try {
    await writeFile(join(f.root, 'a'), 'a');
    for (const limits of [{ ...BACKUP_LIMITS, files: 0 }, { ...BACKUP_LIMITS, bytes: 0 }, { ...BACKUP_LIMITS, fileBytes: 0 }]) {
      const b = new Backups(f.root, f.data, limits); await b.initialize(); assert.equal(await b.before(target), true); assert.deepEqual(Object.keys(b.lastScan!.entries), []);
    }
    const limited = new Backups(f.root, f.data, { ...BACKUP_LIMITS, entries: 0 }); await limited.initialize(); assert.equal(await limited.before(target), true);
    await mkdir(join(f.root, 'denied')); restore = denyRead(join(f.root, 'denied'));
    assert.equal(await f.backups.before(target), true); restore(); restore = undefined;
    assert.equal(await f.backups.before(target), true);
    await mkdir(join(f.root, 'node_modules')); await writeFile(join(f.root, 'node_modules/keep'), 'keep');
    await writeFile(join(f.root, 'a'), 'b'); await f.backups.finish(); await f.backups.undo(f.backups.target!.id);
    assert.equal(await readFile(join(f.root, 'node_modules/keep'), 'utf8'), 'keep');
  } finally { restore?.(); await f.close(); }
});
test('fake engine sees pre-request copy; global undo survives restart, results refresh, context is separate, failed copy still sends', async () => {
  const f = await fixture(); let app: App | undefined;
  try {
    const engine = new FakeEngine(); const files = new WorkspaceFiles(f.root);
    app = new App(engine, f.data, () => {}, undefined, files); await app.start();
    const send = engine.send.bind(engine); const contexts: unknown[] = [];
    engine.send = async (id, text, attachments, context?: { filesReverted?: boolean }) => {
      contexts.push(context);
      const state = JSON.parse(await readFile(join(f.data, 'backups/state.json'), 'utf8'));
      if (text !== 'sin copia') assert.ok(state.pending);
      await send(id, text, attachments);
      await writeFile(join(f.root, 'resultado.png'), text);
      engine.emit({ type: 'finished', conversationId: id, status: 'completed' });
    };
    const waitIdle = async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (!app!.snapshot().works.some(w => w.busy)) return;
        await delay(10);
      }
      assert.fail('timed out waiting for app idle');
    };
    await app.command({ type: 'send', text: 'primero' }, () => {});
    await waitIdle();
    const ref = app.snapshot().works[0].messages[0].results![0]; assert.ok(ref);
    const workId = app.snapshot().works[0].id;
    await app.close(); app = new App(engine, f.data, () => {}, undefined, files); await app.start();
    await app.command({ type: 'undo', id: app.snapshot().undo!.id }, () => {});
    await assert.rejects(files.openResult(ref)); assert.equal(app.snapshot().undo, undefined);
    await app.command({ type: 'send', workId, text: 'segundo' }, () => {});
    await waitIdle();
    assert.deepEqual(contexts[1], { filesReverted: true }); assert.equal(engine.sent[1], 'segundo');
    const opened = await files.openResult(ref); await opened.handle.close();
    const denied = join(f.root, 'denied'); await mkdir(denied); const restore = denyRead(denied);
    try { await app.command({ type: 'send', text: 'sin copia' }, () => {}); }
    finally { restore(); }
    await waitIdle();
    assert.equal(engine.sent.at(-1), 'sin copia'); assert.ok(app.snapshot().undo);
    assert.match(app.snapshot().notice!, /no pude guardar copia/i);
  } finally { await app?.close(); await f.close(); }
});
