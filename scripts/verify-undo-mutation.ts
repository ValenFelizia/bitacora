// Run a mutant only in a disposable module. Never alter production source.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rename, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
await mkdir('.local', { recursive: true });
const base = await mkdtemp(resolve('.local/undo-mutant-'));
try {
  const source = await readFile('server/src/backups.ts', 'utf8');
  const start = source.indexOf('  private async path('), end = source.indexOf('  private async capture(', start);
  assert.ok(start > 0 && end > start);
  const modulePath = join(base, 'mutant.ts');
  let mutant = source.slice(0, start) + '  private async path(path: string, missing = false) { return join(this.root, path); }\n' + source.slice(end);
  // Restoration now has a second component/containment guard. This historical
  // mutant promises to remove ALL route checks, so remove that guard as well.
  const checkStart = mutant.indexOf('  private async checkAbsolute('), checkEnd = mutant.indexOf('  private async checkedRename(', checkStart);
  assert.ok(checkStart > 0 && checkEnd > checkStart);
  mutant = mutant.slice(0, checkStart) + '  private async checkAbsolute(path: string) { return realpath(dirname(path)); }\n' + mutant.slice(checkEnd);
  await writeFile(modulePath, mutant.replace("'./workspace-files'", JSON.stringify(pathToFileURL(resolve('server/src/workspace-files.ts')).href)).replace("'./backup-trash'", JSON.stringify(pathToFileURL(resolve('server/src/backup-trash.ts')).href)));
  const { Backups, BACKUP_LIMITS } = await import(pathToFileURL(modulePath).href);
  const root = join(base, 'agency'), outside = join(base, 'outside'); await mkdir(root); await mkdir(outside); await mkdir(join(root, 'folder'));
  await writeFile(join(outside, 'victim.txt'), 'after'); await writeFile(join(root, 'a.txt'), 'before'); await writeFile(join(root, 'folder/victim.txt'), 'before');
  let injected = false;
  const b = new Backups(root, join(base, 'data'), BACKUP_LIMITS, undefined, { rename, afterStep: async () => {
    if (injected) return; injected = true;
    await rename(join(root, 'folder'), join(root, 'moved')); await symlink(outside, join(root, 'folder'), 'junction');
  } });
  await b.initialize(); await b.before({ workId: 'test', title: 'Test', request: 'Test' });
  await writeFile(join(root, 'a.txt'), 'after'); await writeFile(join(root, 'folder/victim.txt'), 'after'); await b.finish();
  let rejected = false; try { await b.undo(b.target.id); } catch { rejected = true; }
  const witness = await readFile(join(outside, 'victim.txt'), 'utf8');
  const killed = !rejected || witness !== 'after';
  assert.equal(killed, true, 'The route-control mutant must fail the real restoration assertion');
  await writeFile(join(process.env.BITACORA_EVIDENCE_DIR ?? 'docs/verification/issue4', 'mutation.json'), JSON.stringify({ mutation: 'Remove all restore path checks from disposable module', expected: { rejected: true, witness: 'after' }, actual: { rejected, witness }, mutationKilled: killed }, null, 2));
  console.log('PASS: removing restoration path checks breaks the junction-during-restore assertion');
} finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
