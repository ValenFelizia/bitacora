import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { App } from '../src/app';
import { WorkspaceFiles } from '../src/workspace-files';
import { FakeEngine } from './fake-engine';
import { denyRead } from './acl';

test('denied subfolder does not block subsequent requests or restart (real Windows ACL)', { skip: process.platform !== 'win32' }, async () => {
  await mkdir('.local', { recursive: true });
  const dir = await mkdtemp(resolve('.local/acl-'));
  const files = new WorkspaceFiles(join(dir, 'agency'));
  const engine = new FakeEngine();
  let app = new App(engine, join(dir, 'data'), () => {}, undefined, files);
  let restore: (() => unknown) | undefined;
  try {
    await app.start();
    await app.command({ type: 'send', text: 'Primero' }, () => {});
    const denied = join(files.root, 'denied'); await mkdir(denied);
    await writeFile(join(denied, 'hidden.png'), 'blocked');
    restore = denyRead(denied);
    await writeFile(join(files.root, 'visible.png'), 'result');
    engine.emit({ type: 'finished', conversationId: 'conversation-1', status: 'completed' });
    for (let i = 0; app.snapshot().works[0].busy && i < 300; i++) await new Promise(r => setTimeout(r, 10));
    await app.command({ type: 'send', text: 'Segundo' }, () => {});
    assert.equal(engine.sent.length, 2, 'scan failure must never block another send');
    await app.close();
    const next = new FakeEngine();
    app = new App(next, join(dir, 'data'), () => {}, undefined, files);
    await app.start();
    await app.command({ type: 'send', text: 'Después de reiniciar' }, () => {});
    assert.equal(next.sent.length, 1);
    assert.match(app.snapshot().works.find(w => w.title === 'Primero')!.details, /denied|EACCES|EPERM/);
  } finally { restore?.(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});
