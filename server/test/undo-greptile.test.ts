import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Backups } from '../src/backups';
import { lockForWriting } from './locks';
import { App } from '../src/app';
import { WorkspaceFiles } from '../src/workspace-files';
import { FakeEngine } from './fake-engine';
const target = { workId: 'work', title: 'Prueba', request: 'Cambiar' };
test('Greptile: failed copy and locked invalidation save cannot resurrect the previous undo', async () => {
  await mkdir('.local', { recursive: true }); const dir = await mkdtemp(resolve('.local/undo-greptile-'));
  const root = join(dir, 'agency'), data = join(dir, 'data'); await mkdir(root);
  let unlock: (() => Promise<void>) | undefined;
  try {
    const b = new Backups(root, data); await b.initialize(); await b.before(target);
    await writeFile(join(root, 'first.txt'), 'first request'); await b.finish(); assert.ok(b.target);
    const oldReceipt = (b as any).receipt;
    unlock = await lockForWriting(join(data, 'backups/state.json'));
    assert.equal(await b.before(target), false); assert.equal(b.target, undefined);
    await writeFile(join(root, 'second.txt'), 'second unbacked request');
    await unlock(); unlock = undefined;
    const next = new Backups(root, data); await (next as any).initialize(oldReceipt);
    assert.equal(next.target, undefined, 'the old host receipt cannot override the independent invalidation marker');
    assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), 'first request'); assert.equal(await readFile(join(root, 'second.txt'), 'utf8'), 'second unbacked request');
  } finally { await unlock?.(); await rm(dir, { recursive: true, force: true }); }
});
test('Greptile: failure of both marker and state writes stays disabled and host proof rejects stale undo at startup', async () => {
  await mkdir('.local', { recursive: true }); const dir = await mkdtemp(resolve('.local/undo-greptile-host-'));
  const root = join(dir, 'agency'), data = join(dir, 'data'); const engine = new FakeEngine(), files = new WorkspaceFiles(root);
  let app = new App(engine, data, () => {}, undefined, files), unlock: (() => Promise<void>) | undefined;
  engine.send = async (id, text) => {
    engine.sent.push(text); await writeFile(join(root, `${text}.txt`), text);
    engine.emit({ type: 'finished', conversationId: id, status: 'completed' });
  };
  const idle = async () => { for (let i = 0; i < 500 && app.snapshot().works.some(w => w.busy); i++) await new Promise(r => setTimeout(r, 10)); assert.equal(app.snapshot().works.some(w => w.busy), false); };
  try {
    await app.start(); await app.command({ type: 'send', text: 'first' }, () => {}); await idle(); assert.ok(app.snapshot().undo);
    const oldHostReceipt = JSON.parse(await readFile(join(data, 'works.json'), 'utf8')).backupReceipt;
    unlock = await lockForWriting(join(data, 'backups/state.json'));
    (app as any).backups.writeInvalidation = async () => { throw new Error('marker cannot be written'); };
    await app.command({ type: 'send', text: 'second' }, () => {}); await idle();
    assert.deepEqual(engine.sent, ['first', 'second']); assert.equal(app.snapshot().undo, undefined);
    const newHostReceipt = JSON.parse(await readFile(join(data, 'works.json'), 'utf8')).backupReceipt;
    assert.notEqual(oldHostReceipt, newHostReceipt);
    await app.close(); await unlock(); unlock = undefined;
    app = new App(engine, data, () => {}, undefined, files); await app.start();
    assert.equal(app.snapshot().undo, undefined);
    assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), 'first'); assert.equal(await readFile(join(root, 'second.txt'), 'utf8'), 'second');
    await app.command({ type: 'send', text: 'third' }, () => {}); await idle(); assert.equal(engine.sent.at(-1), 'third');
  } finally { await unlock?.(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Greptile: startup without independent host proof never offers a saved undo', async () => {
  await mkdir('.local', { recursive: true }); const dir = await mkdtemp(resolve('.local/undo-greptile-proof-'));
  const root = join(dir, 'agency'), data = join(dir, 'data'); await mkdir(root);
  try {
    const b = new Backups(root, data); await b.initialize(); await b.before(target); await writeFile(join(root, 'personal.txt'), 'preserved'); await b.finish();
    assert.ok(b.target);
    const next = new Backups(root, data); await next.initialize(); assert.equal(next.target, undefined);
    assert.equal(await readFile(join(root, 'personal.txt'), 'utf8'), 'preserved'); assert.equal(next.restoring, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Greptile: a proven later unchanged request legitimately retains the previous changed request undo', async () => {
  await mkdir('.local', { recursive: true }); const dir = await mkdtemp(resolve('.local/undo-greptile-unchanged-'));
  const root = join(dir, 'agency'), data = join(dir, 'data'); await mkdir(root);
  try {
    const b = new Backups(root, data); await b.initialize(); await b.before(target); await writeFile(join(root, 'first.txt'), 'first'); await b.finish();
    const id = b.target!.id; await writeFile(join(root, 'manual.txt'), 'mine'); await b.before(target); await b.finish();
    const next = new Backups(root, data); await next.initialize(b.receipt); assert.equal(next.target?.id, id);
    await next.undo(id); assert.equal(await readFile(join(root, 'manual.txt'), 'utf8'), 'mine');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Greptile: failure to write the independent marker disables undo for the rest of that execution', async () => {
  await mkdir('.local', { recursive: true }); const dir = await mkdtemp(resolve('.local/undo-greptile-disabled-'));
  const root = join(dir, 'agency'), data = join(dir, 'data'); await mkdir(root);
  try {
    const b = new Backups(root, data); await b.initialize(); await b.before(target); await writeFile(join(root, 'first.txt'), 'first'); await b.finish(); assert.ok(b.target);
    const writeMarker = (b as any).writeInvalidation.bind(b);
    (b as any).writeInvalidation = async () => { throw new Error('marker blocked'); };
    assert.equal(await b.before(target), false); assert.equal(b.target, undefined);
    (b as any).writeInvalidation = writeMarker;
    assert.equal(await b.before(target), false); await writeFile(join(root, 'second.txt'), 'second'); await b.finish(); assert.equal(b.target, undefined);
    assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), 'first'); assert.equal(await readFile(join(root, 'second.txt'), 'utf8'), 'second');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
