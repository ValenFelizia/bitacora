import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, rename, unlink, readdir, chmod, stat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Backups, BACKUP_LIMITS } from '../src/backups';
import { BackupTrash, TRASH_RETENTION_MS } from '../src/backup-trash';
import { lockForWriting } from './locks';
const target = { workId: 'work', title: 'Prueba', request: 'Cambiar' };
async function fixture() {
  await mkdir('.local', { recursive: true }); const dir = await mkdtemp(resolve('.local/undo-r4-'));
  const root = join(dir, 'agency'), data = join(dir, 'data'); await mkdir(root);
  return { dir, root, data, close: () => rm(dir, { recursive: true, force: true }) };
}
async function contentHashes(folder: string): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const e of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) for (const h of await contentHashes(join(folder, e.name))) hashes.add(h);
    else if (e.isFile()) hashes.add(createHash('sha256').update(await readFile(join(folder, e.name))).digest('hex'));
  } return hashes;
}
async function conserved(f: Awaited<ReturnType<typeof fixture>>, texts: string[]) {
  const all = new Set([...(await contentHashes(f.root)), ...(await contentHashes(join(f.data, 'backups/trash'))), ...(await contentHashes(join(f.data, 'backups/objects')))]);
  for (const text of texts) assert.ok(all.has(createHash('sha256').update(text).digest('hex')), `lost content: ${text}`);
}
test('R4 Opus A: discard restores an interrupted parked file before dropping the journal', async () => {
  const f = await fixture(); let stop = true;
  try {
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename: async (a, z) => {
      await rename(a, z); if (stop && String(z).includes('.bitacora-keep-')) { stop = false; throw new Error('crash after park'); }
    }, afterStep: async () => {} });
    await b.initialize(); await writeFile(join(f.root, 'presupuesto.txt'), 'before'); await b.before(target);
    await writeFile(join(f.root, 'presupuesto.txt'), 'agent'); await b.finish(); await assert.rejects(b.undo(b.target!.id));
    const resumed = new Backups(f.root, f.data); await resumed.initialize(b.receipt); await resumed.discard(resumed.target!.id);
    assert.equal(await readFile(join(f.root, 'presupuesto.txt'), 'utf8'), 'agent');
    await conserved(f, ['before', 'agent']); assert.equal(resumed.restoring, false); assert.equal(await resumed.before(target), true);
  } finally { await f.close(); }
});
test('R4 trash transfer verifies a complete cross-volume copy before removing its source', async () => {
  const f = await fixture();
  try {
    const trash = new BackupTrash(f.data, { rename: async () => { throw Object.assign(new Error('other volume'), { code: 'EXDEV' }); } }); await trash.initialize();
    const source = join(f.root, 'folder'); await mkdir(source); await writeFile(join(source, 'a.txt'), 'personal');
    const dest = await trash.move(source, { undoId: 'undo', action: 0, path: 'folder', role: 'original', references: [] });
    assert.equal(await readFile(join(dest, 'a.txt'), 'utf8'), 'personal'); await assert.rejects(stat(source), { code: 'ENOENT' }); await conserved(f, ['personal']);
  } finally { await f.close(); }
});
test('R4 purge requires both seven days AND three later successful copies, and protects pending undo', async () => {
  const f = await fixture();
  try {
    const trash = new BackupTrash(f.data); await trash.initialize(); const source = join(f.root, 'a.txt'); await writeFile(source, 'retained');
    const dest = await trash.move(source, { undoId: 'undo', action: 0, path: 'a.txt', role: 'original', references: [] });
    const future = Date.now() + TRASH_RETENTION_MS + 10000;
    await trash.purge(future); assert.equal(await readFile(dest, 'utf8'), 'retained');
    await trash.completedCopy(); await trash.completedCopy(); await trash.purge(future); assert.equal(await readFile(dest, 'utf8'), 'retained');
    await trash.completedCopy(); await trash.purge(Date.now()); assert.equal(await readFile(dest, 'utf8'), 'retained');
    await trash.purge(future, 'undo'); assert.equal(await readFile(dest, 'utf8'), 'retained');
    await trash.purge(future); await assert.rejects(stat(dest), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('R4 store collection is deferred and protects every live trash reference', async () => {
  const f = await fixture();
  try {
    const b = new Backups(f.root, f.data); await b.initialize(); await writeFile(join(f.root, 'a.txt'), 'before'); await b.before(target);
    await writeFile(join(f.root, 'a.txt'), 'agent'); await b.finish(); await b.undo(b.target!.id);
    const object = (text: string) => join(f.data, 'backups/objects', createHash('sha256').update(text).digest('hex'));
    await b.clean(); assert.equal(await readFile(object('agent'), 'utf8'), 'agent');
    await b.before(target); await b.finish(); assert.equal(await readFile(object('agent'), 'utf8'), 'agent');
    await b.before(target); await b.finish(); await b.before(target); await b.finish();
    await b.purgeTrash(Date.now() + TRASH_RETENTION_MS + 10000); await b.clean();
    // Purge alone does not collect objects. Only another completed copy may do so.
    assert.equal(await readFile(object('agent'), 'utf8'), 'agent');
    await b.before(target); await b.finish(); await assert.rejects(stat(object('agent')), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before');
  } finally { await f.close(); }
});
test('R4 property: every process-exit cut conserves pre-undo contents through restart, retry and discard', { timeout: 240000 }, async t => {
  const setup = async () => {
    const f = await fixture(), b = new Backups(f.root, f.data); await b.initialize();
    await writeFile(join(f.root, 'a.txt'), 'before-a'); await writeFile(join(f.root, 'report'), 'before-report'); await writeFile(join(f.root, 'z.txt'), 'before-z');
    await b.before(target); await writeFile(join(f.root, 'a.txt'), 'agent-a'); await chmod(join(f.root, 'a.txt'), 0o444);
    await unlink(join(f.root, 'report')); await mkdir(join(f.root, 'report')); await writeFile(join(f.root, 'report/child'), 'agent-child'); await writeFile(join(f.root, 'z.txt'), 'agent-z');
    await writeFile(join(f.root, 'new.png'), 'agent-new'); await b.finish(); await writeFile(join(f.root, 'manual.txt'), 'personal'); return { ...f, receipt: b.receipt! };
  };
  type WorkerResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; elapsedMs: number; error?: Error };
  const runWorker = (f: Awaited<ReturnType<typeof setup>>, cut: number, timeoutMs: number): Promise<WorkerResult> =>
    new Promise((resolvePromise) => {
      const start = Date.now();
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('server/test/undo-cut-worker.ts'), f.root, f.data, f.receipt, String(cut)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', timedOut = false, settled = false;
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      const finish = (status: number | null, signal: NodeJS.Signals | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ status, signal, stdout, stderr, timedOut, elapsedMs: Date.now() - start, error });
      };
      child.once('error', err => finish(null, null, err));
      child.once('close', (status, signal) => finish(status, signal));
    });
  const assertWorker = (result: WorkerResult, expectedStatus: number, label: string) => {
    if (result.timedOut) assert.fail(`${label} timed out after ${result.elapsedMs}ms${result.stderr ? `: ${result.stderr}` : ''}`);
    if (result.error) assert.fail(`${label} failed to run: ${result.error.message}`);
    assert.equal(result.status, expectedStatus, `${label} exited with status ${result.status} (signal ${result.signal})${result.stderr ? `: ${result.stderr}` : ''}`);
  };
  const baseline = await setup(); let total = 0; let workerTimeoutMs = 45000;
  try {
    const result = await runWorker(baseline, 0, 60000);
    assertWorker(result, 0, 'baseline');
    workerTimeoutMs = Math.max(45000, result.elapsedMs * 10);
    total = JSON.parse(result.stdout.trim().split('\n').at(-1)!).total;
    assert.ok(total > 30);
  } finally { await baseline.close(); }
  const cases: { mode: 'retry' | 'discard'; cut: number }[] = [];
  for (const mode of ['retry', 'discard'] as const) for (let cut = 1; cut <= total; cut++) cases.push({ mode, cut });
  let next = 0;
  let failure: unknown;
  const verifyCase = async (mode: 'retry' | 'discard', cut: number) => {
    const f = await setup();
    try {
      const result = await runWorker(f, cut, workerTimeoutMs);
      assertWorker(result, 73, `${mode} cut ${cut}/${total}`);
      await conserved(f, ['agent-a', 'agent-child', 'agent-z', 'agent-new', 'personal']);
      const b = new Backups(f.root, f.data); await b.initialize(f.receipt);
      const expected = new Map<string, string>();
      if (mode === 'discard') {
        // Simulate deleting a file ourselves after its replacement completed.
        if (await readFile(join(f.root, 'a.txt'), 'utf8').catch(() => '') === 'before-a') await unlink(join(f.root, 'a.txt'));
        const state = JSON.parse(await readFile(join(f.data, 'backups/state.json'), 'utf8'));
        for (const p of ['a.txt', 'z.txt', 'report', 'report/child', 'new.png', 'manual.txt']) {
          const path = join(f.root, p), s = await stat(path).catch(() => undefined);
          let wanted = s?.isDirectory() ? 'directory' : s ? await readFile(path, 'utf8') : 'missing';
          const index = state.plan?.actions.findIndex((a: { path: string }) => a.path === p);
          // A replacement is unfinished only while its prepared file is still
          // present. A completed deletion or installation leaves no such gap.
          if (!s && b.restoring && index >= 0 && ['a.txt', 'z.txt', 'report'].includes(p) &&
              await stat(join(f.root, `.bitacora-undo-${state.undo.id}-${index}.tmp`)).catch(() => undefined)) {
            wanted = p === 'report' ? 'directory' : `agent-${p[0]}`;
          }
          expected.set(p, wanted);
        }
      }
      if (b.target) {
        if (mode === 'discard' && b.restoring) await b.discard(b.target.id);
        else if (mode === 'retry') await b.undo(b.target.id);
      }
      await conserved(f, ['agent-a', 'agent-child', 'agent-z', 'agent-new', 'personal']);
      for (const [p, wanted] of expected) {
        const path = join(f.root, p), s = await stat(path).catch(() => undefined);
        assert.equal(s?.isDirectory() ? 'directory' : s ? await readFile(path, 'utf8') : 'missing', wanted, `discard changed ${p} at cut ${cut}`);
      }
      assert.equal(await readFile(join(f.root, 'manual.txt'), 'utf8'), 'personal');
      assert.equal(b.restoring, false, `${mode} cut ${cut} must have an exit`);
      assert.equal(await b.before(target), true);
    } catch (e) { throw Object.assign(new Error(`${mode} after operation ${cut}/${total}`), { cause: e }); }
    finally { await f.close(); }
  };
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (!failure && next < cases.length) {
      const { mode, cut } = cases[next++]!;
      try { await verifyCase(mode, cut); } catch (e) { failure ??= e; }
    }
  }));
  if (failure) throw failure;
  t.diagnostic(`${total} operation cuts × retry/discard: ${total * 2} real process exits; all pre-undo content hashes conserved`);
});
test('R4 Opus B: discard repairs a directory removed before a failed replacement', async () => {
  const f = await fixture();
  try {
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename: async (a, z) => {
      if (String(a).includes('.bitacora-undo-')) throw new Error('replacement blocked'); await rename(a, z);
    }, afterStep: async () => {} });
    await b.initialize(); await writeFile(join(f.root, 'report'), 'user original'); await b.before(target);
    await unlink(join(f.root, 'report')); await mkdir(join(f.root, 'report')); await writeFile(join(f.root, 'report/child'), 'agent child'); await b.finish();
    await assert.rejects(b.undo(b.target!.id)); await b.discard(b.target!.id);
    assert.ok((await stat(join(f.root, 'report'))).isDirectory()); await conserved(f, ['user original', 'agent child']); assert.equal(b.restoring, false);
  } finally { await f.close(); }
});
test('R4 Greptile later backups retain bytes for cached unchanged hashes after undo', async () => {
  const f = await fixture();
  try {
    const b = new Backups(f.root, f.data); await b.initialize();
    await writeFile(join(f.root, 'a.txt'), 'before'); await writeFile(join(f.root, 'unrelated.txt'), 'keep me'); await b.before(target);
    await writeFile(join(f.root, 'a.txt'), 'after'); await b.finish(); await b.undo(b.target!.id);
    assert.equal(await b.before(target), true); await unlink(join(f.root, 'unrelated.txt')); await b.finish();
    await b.undo(b.target!.id); assert.equal(await readFile(join(f.root, 'unrelated.txt'), 'utf8'), 'keep me'); await conserved(f, ['keep me', 'after']);
  } finally { await f.close(); }
});
test('R4 Greptile retry recovers a later park even when an earlier action is active', async () => {
  const f = await fixture(); let stop = true;
  try {
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename: async (a, z) => {
      await rename(a, z); if (stop && a === join(f.root, 'z.txt')) { stop = false; throw new Error('crash after second park'); }
    }, afterStep: async () => {} });
    await b.initialize(); for (const p of ['a.txt', 'z.txt']) await writeFile(join(f.root, p), `before ${p}`);
    await b.before(target); for (const p of ['a.txt', 'z.txt']) await writeFile(join(f.root, p), `agent ${p}`); await b.finish();
    await assert.rejects(b.undo(b.target!.id)); const resumed = new Backups(f.root, f.data); await resumed.initialize(b.receipt);
    await resumed.undo(resumed.target!.id); assert.equal(await readFile(join(f.root, 'z.txt'), 'utf8'), 'before z.txt');
    await conserved(f, ['agent a.txt', 'agent z.txt']); assert.equal(resumed.restoring, false);
  } finally { await f.close(); }
});
test('R4 Greptile interrupted read-only step is recovered from disk before retry', async () => {
  const f = await fixture();
  try {
    const b = new Backups(f.root, f.data); await b.initialize(); const path = join(f.root, 'a.txt');
    await writeFile(path, 'before'); await b.before(target); await writeFile(path, 'agent'); await chmod(path, 0o444); await b.finish();
    // Model a process exit after chmod and before its completion/park: the durable intent already exists.
    const file = join(f.data, 'backups/state.json'), state = JSON.parse(await readFile(file, 'utf8'));
    state.plan = { actions: [{ path: 'a.txt', from: { kind: 'file', entry: state.undo.after.entries['a.txt'] }, to: { kind: 'file', entry: state.undo.before.entries['a.txt'] }, started: true }], skipped: [], omitted: [], active: false };
    await writeFile(file, JSON.stringify(state)); await chmod(path, 0o666);
    const resumed = new Backups(f.root, f.data); await resumed.initialize(b.receipt); await resumed.undo(resumed.target!.id);
    assert.equal(await readFile(path, 'utf8'), 'before'); await conserved(f, ['agent']); assert.equal(resumed.restoring, false);
  } finally { await f.close(); }
});
test('R4 Opus 2: ambiguous NTFS names omit only the ambiguous entries', async () => {
  const f = await fixture();
  try {
    const b = new Backups(f.root, f.data); await b.initialize();
    for (const [p, text] of [['año.txt', 'composed'], ['an\u0303o.txt', 'decomposed'], ['ß.txt', 'sharp'], ['SS.txt', 'double'], ['ı.txt', 'dotless'], ['I.txt', 'ascii'], ['safe.txt', 'before']]) await writeFile(join(f.root, p), text);
    assert.equal(await b.before(target), true); await writeFile(join(f.root, 'safe.txt'), 'after'); await b.finish();
    const result = await b.undo(b.target!.id); assert.equal(await readFile(join(f.root, 'safe.txt'), 'utf8'), 'before'); assert.equal(result.omitted.length, 6);
    await conserved(f, ['composed', 'decomposed', 'sharp', 'double', 'dotless', 'ascii']); assert.equal(b.restoring, false);
  } finally { await f.close(); }
});
test('R4 Opus 3: returned original after failed replacement leaves no active restoration', async () => {
  const f = await fixture();
  try {
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename: async (a, z) => {
      if (String(a).includes('.bitacora-undo-')) throw new Error('replacement blocked'); await rename(a, z);
    }, afterStep: async () => {} });
    await b.initialize(); await writeFile(join(f.root, 'a.txt'), 'before'); await b.before(target); await writeFile(join(f.root, 'a.txt'), 'agent'); await b.finish();
    await assert.rejects(b.undo(b.target!.id)); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'agent');
    assert.equal(b.restoring, false); await conserved(f, ['before', 'agent']); assert.equal(await b.before(target), true);
  } finally { await f.close(); }
});
test('R4 Opus 4: an internal junction is rejected explicitly even with matching contents', async () => {
  const f = await fixture();
  try {
    const b = new Backups(f.root, f.data); await b.initialize(); await mkdir(join(f.root, 'box')); await mkdir(join(f.root, 'other'));
    await writeFile(join(f.root, 'box/a.txt'), 'before'); await writeFile(join(f.root, 'other/a.txt'), 'agent'); await b.before(target);
    await writeFile(join(f.root, 'box/a.txt'), 'agent'); await b.finish(); await rm(join(f.root, 'box'), { recursive: true }); await symlink(join(f.root, 'other'), join(f.root, 'box'), 'junction');
    await assert.rejects(b.undo(b.target!.id), /enlace/); assert.equal(await readFile(join(f.root, 'other/a.txt'), 'utf8'), 'agent'); await conserved(f, ['before', 'agent']); assert.equal(b.restoring, false);
  } finally { await f.close(); }
});
test('R4 containment: an external junction with identical contents cannot redirect restoration', async () => {
  const f = await fixture();
  try {
    const b = new Backups(f.root, f.data); await b.initialize(); await mkdir(join(f.root, 'box')); await mkdir(join(f.dir, 'outside'));
    await writeFile(join(f.root, 'box/a.txt'), 'before'); await writeFile(join(f.dir, 'outside/a.txt'), 'agent'); await b.before(target);
    await writeFile(join(f.root, 'box/a.txt'), 'agent'); await b.finish(); await rm(join(f.root, 'box'), { recursive: true }); await symlink(join(f.dir, 'outside'), join(f.root, 'box'), 'junction');
    await assert.rejects(b.undo(b.target!.id), /enlace/); assert.equal(await readFile(join(f.dir, 'outside/a.txt'), 'utf8'), 'agent'); await conserved(f, ['before', 'agent']); assert.equal(b.restoring, false);
  } finally { await f.close(); }
});
test('R4 discard cannot drop its journal while a missing original cannot be put back', async () => {
  const f = await fixture(); let unlock: (() => Promise<void>) | undefined;
  try {
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename: async (a, z) => { await rename(a, z); if (String(z).includes('.bitacora-keep-')) throw new Error('cut'); }, afterStep: async () => {} });
    await b.initialize(); await writeFile(join(f.root, 'a.txt'), 'before'); await b.before(target); await writeFile(join(f.root, 'a.txt'), 'agent'); await b.finish(); await assert.rejects(b.undo(b.target!.id));
    const parked = (await readdir(f.root)).find(p => p.startsWith('.bitacora-keep-'))!; unlock = await lockForWriting(join(f.root, parked));
    const resumed = new Backups(f.root, f.data); await resumed.initialize(b.receipt);
    await assert.rejects(resumed.discard(resumed.target!.id)); assert.equal(resumed.restoring, true); assert.ok(resumed.target?.retry);
    await conserved(f, ['before', 'agent']);
    await unlock(); unlock = undefined; await resumed.discard(resumed.target!.id);
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'agent'); assert.equal(resumed.restoring, false); assert.equal(await resumed.before(target), true);
  } finally { await unlock?.(); await f.close(); }
});
test('R4 discard does not claim a manual deletion of a new agent file as its own reversal', async () => {
  const f = await fixture();
  try {
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename, afterStep: async () => { throw new Error('stop'); } }); await b.initialize();
    await writeFile(join(f.root, 'a.txt'), 'before'); await b.before(target); await writeFile(join(f.root, 'a.txt'), 'agent'); await writeFile(join(f.root, 'new.txt'), 'new'); await b.finish();
    await unlink(join(f.root, 'new.txt')); await assert.rejects(b.undo(b.target!.id)); const result = await b.discard(b.target!.id);
    assert.ok(!result.restored.includes('new.txt')); assert.ok(result.remaining.includes('new.txt')); await conserved(f, ['before', 'agent']); assert.equal(b.restoring, false);
  } finally { await f.close(); }
});
test('R4 Opus 5: skipped basename duplicates count separately and manual deletion is not reported as reverted', async () => {
  const f = await fixture();
  try {
    const b = new Backups(f.root, f.data, BACKUP_LIMITS, undefined, { rename, afterStep: async () => { throw new Error('stop'); } });
    await b.initialize(); for (const folder of ['a', 'b']) { await mkdir(join(f.root, folder)); await writeFile(join(f.root, folder, 'x.txt'), 'before'); }
    await writeFile(join(f.root, 'first.txt'), 'before'); await b.before(target);
    for (const folder of ['a', 'b']) await writeFile(join(f.root, folder, 'x.txt'), 'agent');
    await writeFile(join(f.root, 'first.txt'), 'agent'); await writeFile(join(f.root, 'new.txt'), 'new'); await b.finish();
    for (const folder of ['a', 'b']) await writeFile(join(f.root, folder, 'x.txt'), 'manual'); await unlink(join(f.root, 'new.txt'));
    await assert.rejects(b.undo(b.target!.id)); const result = await b.discard(b.target!.id);
    assert.equal(result.skipped.filter(n => n === 'x.txt').length, 2); assert.ok(!result.restored.includes('new.txt'));
    await conserved(f, ['manual', 'agent']); assert.equal(b.restoring, false);
  } finally { await f.close(); }
});
