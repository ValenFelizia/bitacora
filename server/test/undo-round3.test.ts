import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, rename, unlink, symlink, chmod, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Backups, BACKUP_LIMITS } from '../src/backups';
import { denyRead } from './acl';
import { lockForWriting } from './locks';
import { App } from '../src/app';
import { WorkspaceFiles } from '../src/workspace-files';
import { FakeEngine } from './fake-engine';
const target = { workId: 'work', title: 'Prueba', request: 'Cambiar' };
async function fixture() {
  await mkdir('.local', { recursive: true }); const dir = await mkdtemp(resolve('.local/undo-r3-'));
  const root = join(dir, 'agency'), data = join(dir, 'data'); await mkdir(root);
  const b = new Backups(root, data); await b.initialize();
  return { dir, root, data, b, close: () => rm(dir, { recursive: true, force: true }) };
}
async function retained(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  if (f.b.target) assert.equal(await readFile(join(f.data, 'backups/objects', createHash('sha256').update(text).digest('hex')), 'utf8'), text);
}
for (const directory of [false, true]) test(`N1 agent case-only rename preserves ${directory ? 'directory with user content' : 'file'}`, async () => {
  const f = await fixture();
  try {
    if (directory) { await mkdir(join(f.root, 'Fotos')); await writeFile(join(f.root, 'Fotos/mía.txt'), 'personal'); }
    else await writeFile(join(f.root, 'Informe.txt'), 'personal');
    await f.b.before(target);
    await rename(join(f.root, directory ? 'Fotos' : 'Informe.txt'), join(f.root, 'temporary'));
    await rename(join(f.root, 'temporary'), join(f.root, directory ? 'fotos' : 'informe.txt')); await f.b.finish();
    await f.b.undo(f.b.target!.id).catch(() => {});
    assert.equal(await readFile(join(f.root, directory ? 'fotos/mía.txt' : 'informe.txt'), 'utf8'), 'personal');
    await retained(f, 'personal'); assert.equal(f.b.restoring, false);
  } finally { await f.close(); }
});
test('N2a agent read-only file can be undone without mistaking its attribute for a lock', async () => {
  const f = await fixture(); const p = join(f.root, 'a.txt');
  try {
    await writeFile(p, 'before'); await f.b.before(target); await writeFile(p, 'after'); await chmod(p, 0o444); await f.b.finish();
    await f.b.undo(f.b.target!.id); assert.equal(await readFile(p, 'utf8'), 'before'); assert.equal(f.b.restoring, false);
  } finally { await chmod(p, 0o666).catch(() => {}); await f.close(); }
});
test('N2b preflight junction rejection does not persist a plan or block new requests', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'old')); await writeFile(join(f.root, 'old/user.txt'), 'personal'); await f.b.before(target);
    const outside = join(f.dir, 'outside'); await mkdir(outside); await writeFile(join(outside, 'user.txt'), 'outside');
    await rm(join(f.root, 'old'), { recursive: true }); await symlink(outside, join(f.root, 'old'), 'junction'); await f.b.finish();
    await assert.rejects(f.b.undo(f.b.target!.id));
    assert.equal(await readFile(join(outside, 'user.txt'), 'utf8'), 'outside'); await retained(f, 'personal'); assert.equal(f.b.restoring, false);
    assert.equal(await f.b.before(target), true);
  } finally { await f.close(); }
});
test('N2c replaced parent is rejected before restoring any file and leaves an exit', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'old')); await writeFile(join(f.root, 'old/user.txt'), 'personal'); await writeFile(join(f.root, 'a.txt'), 'before'); await f.b.before(target);
    await rm(join(f.root, 'old'), { recursive: true }); await writeFile(join(f.root, 'a.txt'), 'after'); await f.b.finish();
    await writeFile(join(f.root, 'old'), 'manual parent'); await assert.rejects(f.b.undo(f.b.target!.id));
    assert.equal(await readFile(join(f.root, 'old'), 'utf8'), 'manual parent'); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'after');
    await retained(f, 'personal'); assert.equal(f.b.restoring, false);
  } finally { await f.close(); }
});
for (const directory of [false, true]) test(`N3 unreadable ${directory ? 'folder' : 'file'} does not disable the rest of the copy`, async () => {
  const f = await fixture(); let restore: (() => unknown) | undefined, unlock: (() => Promise<void>) | undefined;
  try {
    const denied = join(f.root, 'denied'); await mkdir(denied); await writeFile(join(denied, 'locked.txt'), 'unreadable');
    if (directory) restore = denyRead(denied);
    else unlock = await lockForWriting(join(denied, 'locked.txt'), 'None');
    await writeFile(join(f.root, 'a.txt'), 'before'); assert.equal(await f.b.before(target), true);
    await writeFile(join(f.root, 'a.txt'), 'after'); await f.b.finish(); await f.b.undo(f.b.target!.id);
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before'); assert.equal(f.b.restoring, false);
    restore?.(); restore = undefined; await unlock?.(); unlock = undefined; assert.equal(await readFile(join(denied, 'locked.txt'), 'utf8'), 'unreadable');
  } finally { restore?.(); await unlock?.(); await f.close(); }
});
test('N4 retry does not recreate a file manually deleted after a failed rename', async () => {
  const f = await fixture(); let fail = true;
  try {
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename: async (a, z) => { if (fail) throw new Error('rename failed'); await rename(a, z); }, afterStep: async () => {} });
    await b.initialize(); await writeFile(join(f.root, 'a.txt'), 'before'); await b.before(target); await writeFile(join(f.root, 'a.txt'), 'after'); await b.finish();
    await assert.rejects(b.undo(b.target!.id)); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'after');
    assert.equal(await readFile(join(f.data, 'backups/objects', createHash('sha256').update('before').digest('hex')), 'utf8'), 'before');
    await unlink(join(f.root, 'a.txt')); fail = false; await b.undo(b.target!.id);
    assert.equal((await readdir(f.root)).includes('a.txt'), false); assert.equal(b.restoring, false);
  } finally { await f.close(); }
});
for (const directory of [false, true]) test(`N1 manual case rename after the request preserves ${directory ? 'folder' : 'file'}`, async () => {
  const f = await fixture();
  try {
    if (directory) await mkdir(join(f.root, 'Fotos'));
    const original = directory ? 'Fotos/data.txt' : 'Informe.txt';
    await writeFile(join(f.root, original), 'before'); await f.b.before(target); await writeFile(join(f.root, original), 'after'); await f.b.finish();
    const from = directory ? 'Fotos' : 'Informe.txt', to = directory ? 'fotos' : 'informe.txt';
    await rename(join(f.root, from), join(f.root, 'temporary')); await rename(join(f.root, 'temporary'), join(f.root, to));
    if (directory) await writeFile(join(f.root, 'fotos/personal.txt'), 'manual');
    const result = await f.b.undo(f.b.target!.id);
    assert.equal(await readFile(join(f.root, directory ? 'fotos/data.txt' : 'informe.txt'), 'utf8'), 'after');
    if (directory) assert.equal(await readFile(join(f.root, 'fotos/personal.txt'), 'utf8'), 'manual');
    assert.ok(result.skipped.length); assert.equal(f.b.restoring, false);
  } finally { await f.close(); }
});
test('N1 Unicode composition-only rename is refused without losing either content or copy', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'año.txt'), 'personal'); await f.b.before(target);
    await rename(join(f.root, 'año.txt'), join(f.root, 'an\u0303o.txt')); await f.b.finish();
    await assert.rejects(f.b.undo(f.b.target!.id), /acento/);
    assert.equal(await readFile(join(f.root, 'an\u0303o.txt'), 'utf8'), 'personal'); await retained(f, 'personal'); assert.equal(f.b.restoring, false);
  } finally { await f.close(); }
});
test('N1 distinct NTFS names with equivalent Unicode stay separate and are individually omitted', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'año.txt'), 'composed'); await writeFile(join(f.root, 'an\u0303o.txt'), 'decomposed');
    assert.equal(await f.b.before(target), true); assert.equal(f.b.restoring, false);
    assert.equal(await readFile(join(f.root, 'año.txt'), 'utf8'), 'composed'); assert.equal(await readFile(join(f.root, 'an\u0303o.txt'), 'utf8'), 'decomposed');
  } finally { await f.close(); }
});
test('N2 partial restore can always be discarded after restart, reports paths by name and accepts a new request', async () => {
  const f = await fixture(); const engine = new FakeEngine(); const files = new WorkspaceFiles(f.root);
  let app = new App(engine, f.data, () => {}, undefined, files);
  try {
    await writeFile(join(f.root, 'a.txt'), 'before'); await writeFile(join(f.root, 'z.txt'), 'personal');
    await app.start(); await app.command({ type: 'send', text: 'change' }, () => {});
    await writeFile(join(f.root, 'a.txt'), 'after'); await writeFile(join(f.root, 'z.txt'), 'after-z');
    engine.emit({ type: 'finished', conversationId: 'conversation-1', status: 'completed' });
    for (let i = 0; i < 300 && app.snapshot().works[0].busy; i++) await new Promise(r => setTimeout(r, 10));
    (app as any).backups.io.afterStep = async () => { throw new Error('stopped after first action'); };
    await app.command({ type: 'undo', id: app.snapshot().undo!.id }, () => {});
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before'); assert.equal(await readFile(join(f.root, 'z.txt'), 'utf8'), 'after-z');
    assert.equal(await readFile(join(f.data, 'backups/objects', createHash('sha256').update('personal').digest('hex')), 'utf8'), 'personal');
    await app.close(); app = new App(engine, f.data, () => {}, undefined, files); await app.start();
    assert.equal(app.snapshot().undo?.retry, true);
    await app.command({ type: 'discardUndo', id: app.snapshot().undo!.id }, () => {});
    assert.equal(app.snapshot().undo, undefined); assert.match(app.snapshot().notice!, /a.txt/); assert.match(app.snapshot().notice!, /z.txt/);
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before'); assert.equal(await readFile(join(f.root, 'z.txt'), 'utf8'), 'after-z');
    const count = engine.sent.length; await app.command({ type: 'send', text: 'continue' }, () => {}); assert.equal(engine.sent.length, count + 1);
  } finally { await app.close(); await f.close(); }
});
test('N3 entry/depth limits retain the known subset and warn once without treating unknown files as deleted', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.txt'), 'before'); await mkdir(join(f.root, 'deep')); await mkdir(join(f.root, 'deep/nested')); await writeFile(join(f.root, 'deep/nested/personal'), 'mine');
    const b = new Backups(f.root, f.data, { ...BACKUP_LIMITS, depth: 0 }); await b.initialize();
    await b.before(target); await writeFile(join(f.root, 'a.txt'), 'after'); await b.finish(); assert.ok(b.latestOmitted.length);
    await b.before(target); await b.finish(); assert.deepEqual(b.latestOmitted, []);
    await b.undo(b.target!.id); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before');
    assert.equal(await readFile(join(f.root, 'deep/nested/personal'), 'utf8'), 'mine'); assert.equal(b.restoring, false);
    const limited = new Backups(f.root, f.data, { ...BACKUP_LIMITS, entries: 1 }); await limited.initialize(); assert.equal(await limited.before(target), true);
    await limited.finish(); assert.equal(limited.restoring, false); assert.equal(await readFile(join(f.root, 'deep/nested/personal'), 'utf8'), 'mine');
  } finally { await f.close(); }
});
test('N6 a leaf junction is rejected by preflight without admin, changes or a blocking plan', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'leaf')); await writeFile(join(f.root, 'leaf/personal'), 'mine'); await f.b.before(target);
    await rm(join(f.root, 'leaf'), { recursive: true }); await f.b.finish();
    const outside = join(f.dir, 'outside'); await mkdir(outside); await writeFile(join(outside, 'personal'), 'outside');
    await symlink(outside, join(f.root, 'leaf'), 'junction');
    await assert.rejects(f.b.undo(f.b.target!.id), /enlace/); assert.equal(await readFile(join(outside, 'personal'), 'utf8'), 'outside'); await retained(f, 'mine'); assert.equal(f.b.restoring, false);
  } finally { await f.close(); }
});
test('N6 later edits in a directory-to-file change are rejected before restoring another route', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.txt'), 'old-a'); await writeFile(join(f.root, 'report'), 'old-report'); await f.b.before(target);
    await writeFile(join(f.root, 'a.txt'), 'after-a'); await unlink(join(f.root, 'report')); await mkdir(join(f.root, 'report')); await writeFile(join(f.root, 'report/child'), 'agent'); await f.b.finish();
    await writeFile(join(f.root, 'report/child'), 'personal edit'); await assert.rejects(f.b.undo(f.b.target!.id));
    assert.equal(await readFile(join(f.root, 'report/child'), 'utf8'), 'personal edit'); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'after-a');
    await retained(f, 'old-report'); assert.equal(f.b.restoring, false);
  } finally { await f.close(); }
});
for (const kind of ['write', 'rename']) test(`N5/N6 recheck immediately before ${kind} prevents a redirected parent syscall`, async () => {
  const f = await fixture(); const outside = join(f.dir, 'outside');
  try {
    await mkdir(join(f.root, 'box')); await writeFile(join(f.root, 'box/a.txt'), 'before'); let injected = false, renameCount = 0, attempts = 0;
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, {
      rename: async (a, z) => { if (injected) attempts++; await rename(a, z); }, afterStep: async () => {},
      beforeMutation: async (p, operation) => {
        if (injected || p !== join('box', 'a.txt') || operation !== kind) return;
        if (kind === 'rename' && ++renameCount < 2) return;
        injected = true; await rename(join(f.root, 'box'), outside); await symlink(outside, join(f.root, 'box'), 'junction');
      },
      afterMutation: async (_p, operation) => { if (kind === 'write' && injected && operation === 'open') attempts++; },
    });
    await b.initialize(); await b.before(target); await writeFile(join(f.root, 'box/a.txt'), 'after'); await b.finish();
    await assert.rejects(b.undo(b.target!.id)); assert.equal(attempts, 0);
    assert.equal(await readFile(join(f.data, 'backups/objects', createHash('sha256').update('before').digest('hex')), 'utf8'), 'before');
    if (b.restoring) await b.discard(b.target!.id); assert.equal(b.restoring, false);
    if (kind === 'write') assert.equal(await readFile(join(outside, 'a.txt'), 'utf8'), 'after');
  } finally { await f.close(); }
});
for (const kind of ['write', 'rename']) test(`N5 recheck after ${kind} rolls back an operation redirected outside`, async () => {
  const f = await fixture(); const outside = join(f.dir, 'outside');
  try {
    await mkdir(join(f.root, 'box')); await writeFile(join(f.root, 'box/a.txt'), 'before'); let injected = false, renames = 0;
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename, afterStep: async () => {}, afterMutation: async (p, operation) => {
      if (injected || p !== join('box', 'a.txt') || operation !== kind) return;
      if (kind === 'rename' && ++renames < 2) return;
      injected = true; await rename(join(f.root, 'box'), outside); await symlink(outside, join(f.root, 'box'), 'junction');
    } });
    await b.initialize(); await b.before(target); await writeFile(join(f.root, 'box/a.txt'), 'after'); await b.finish();
    await assert.rejects(b.undo(b.target!.id));
    assert.equal(await readFile(join(outside, 'a.txt'), 'utf8'), 'after');
    assert.equal((await readdir(outside)).some(n => n.startsWith('.bitacora-')), false);
    assert.equal(await readFile(join(f.data, 'backups/objects', createHash('sha256').update('before').digest('hex')), 'utf8'), 'before');
    if (b.restoring) await b.discard(b.target!.id); assert.equal(b.restoring, false);
  } finally { await f.close(); }
});
test('N4 a partial-journal retry after restart preserves a manual deletion of a later action', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.txt'), 'before-a'); await writeFile(join(f.root, 'z.txt'), 'before-z');
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename: async (from, to) => {
      if (from === join(f.root, 'z.txt')) throw new Error('blocked later file'); await rename(from, to);
    }, afterStep: async () => {} });
    await b.initialize(); await b.before(target); await writeFile(join(f.root, 'a.txt'), 'after-a'); await writeFile(join(f.root, 'z.txt'), 'after-z'); await b.finish();
    await assert.rejects(b.undo(b.target!.id)); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before-a');
    await unlink(join(f.root, 'z.txt')); const resumed = new Backups(f.root, f.data); await resumed.initialize(b.receipt);
    await resumed.undo(resumed.target!.id); assert.equal((await readdir(f.root)).includes('z.txt'), false); assert.equal(resumed.restoring, false);
  } finally { await f.close(); }
});
test('an interrupted park is recognized from its preserved original and can finish after restart', async () => {
  const f = await fixture(); let interrupted = false;
  try {
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename: async (a, z) => {
      await rename(a, z); if (!interrupted) { interrupted = true; throw new Error('stopped after OS rename'); }
    }, afterStep: async () => {} });
    await b.initialize(); await writeFile(join(f.root, 'a.txt'), 'before'); await b.before(target); await writeFile(join(f.root, 'a.txt'), 'after'); await b.finish();
    await assert.rejects(b.undo(b.target!.id)); assert.equal(b.restoring, true);
    assert.equal(await readFile(join(f.data, 'backups/objects', createHash('sha256').update('before').digest('hex')), 'utf8'), 'before');
    const restarted = new Backups(f.root, f.data); await restarted.initialize(b.receipt); await restarted.undo(restarted.target!.id);
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before'); assert.equal(restarted.restoring, false);
  } finally { await f.close(); }
});
