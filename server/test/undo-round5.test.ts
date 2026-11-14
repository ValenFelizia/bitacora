import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, rename, unlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Backups, BACKUP_LIMITS } from '../src/backups';
import { lockForWriting } from './locks';
const target = { workId: 'work', title: 'Prueba', request: 'Cambiar' };
async function fixture() {
  await mkdir('.local', { recursive: true }); const dir = await mkdtemp(resolve('.local/undo-r5-'));
  const root = join(dir, 'agency'), data = join(dir, 'data'); await mkdir(root);
  const b = new Backups(root, data, BACKUP_LIMITS, undefined, { rename: async (a, z) => {
    if (a === join(root, 'z.txt')) throw new Error('later file blocked'); await rename(a, z);
  }, afterStep: async () => {} }); await b.initialize();
  return { root, data, b, close: () => rm(dir, { recursive: true, force: true }) };
}
for (const manual of [false, true]) test(`R5 discard preserves ${manual ? 'a manual deletion of an already restored file' : 'an undo deletion already completed'}`, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'z.txt'), 'before-z');
    if (manual) await writeFile(join(f.root, 'a.txt'), 'before-a');
    await f.b.before(target); await writeFile(join(f.root, 'z.txt'), 'agent-z'); await writeFile(join(f.root, 'a.txt'), 'agent-a'); await f.b.finish();
    await assert.rejects(f.b.undo(f.b.target!.id));
    if (manual) { assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before-a'); await unlink(join(f.root, 'a.txt')); }
    else await assert.rejects(stat(join(f.root, 'a.txt')), { code: 'ENOENT' });
    const result = await f.b.discard(f.b.target!.id);
    await assert.rejects(stat(join(f.root, 'a.txt')), { code: 'ENOENT' });
    assert.equal(result.restored.includes('a.txt'), !manual); assert.equal(f.b.restoring, false);
    assert.equal(await readFile(join(f.root, 'z.txt'), 'utf8'), 'agent-z');
  } finally { await f.close(); }
});
test('R5 a locked trash counter does not invalidate a saved copy or advance retention', async () => {
  const f = await fixture(); let unlock: (() => Promise<void>) | undefined;
  try {
    await writeFile(join(f.root, 'a.txt'), 'before'); await f.b.before(target); await f.b.finish();
    const clock = join(f.data, 'backups/trash/clock.json'), original = await readFile(clock, 'utf8');
    await f.b.before(target); await writeFile(join(f.root, 'a.txt'), 'agent'); unlock = await lockForWriting(clock);
    assert.equal(await f.b.finish(), true); assert.ok(f.b.target); assert.equal(await readFile(clock, 'utf8'), original);
    await unlock(); unlock = undefined; await f.b.undo(f.b.target!.id); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before');
  } finally { await unlock?.(); await f.close(); }
});
test('R5 historical mutation runners start and detect their mutations', async () => {
  // The runners rewrite their evidence; point them at a scratch folder so the
  // test run never modifies tracked files under docs/.
  await mkdir('.local', { recursive: true });
  const evidence = await mkdtemp(resolve('.local/mutation-evidence-'));
  try {
    for (const script of ['verify-undo-round3-mutations', 'verify-undo-mutation']) {
      const env: NodeJS.ProcessEnv = { ...process.env, BITACORA_EVIDENCE_DIR: evidence }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--import', 'tsx', `scripts/${script}.ts`], { encoding: 'utf8', timeout: 30000, env });
      assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /PASS:/);
    }
  } finally { await rm(evidence, { recursive: true, force: true }); }
});
