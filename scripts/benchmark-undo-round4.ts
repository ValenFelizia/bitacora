import { mkdir, mkdtemp, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Backups } from '../server/src/backups';
await mkdir('.local', { recursive: true }); const base = await mkdtemp(resolve('.local/undo-r4-bench-'));
async function bytes(folder: string): Promise<number> { let n = 0; for (const e of await readdir(folder, { withFileTypes: true })) n += e.isDirectory() ? await bytes(join(folder, e.name)) : (await stat(join(folder, e.name))).size; return n; }
const records: unknown[] = [];
try {
  const root = join(base, 'agency'); await mkdir(root);
  for (let i = 0; i < 2000; i++) { const b = Buffer.alloc(16384, i % 251); b.writeUInt32LE(i, 4); await writeFile(join(root, `foto-${i}.jpg`), b); }
  for (let i = 0; i < 4; i++) await writeFile(join(root, `pesada-${i}.jpg`), Buffer.alloc(16 * 1024 ** 2, i));
  for (const name of ['backups', 'workspace-files']) await writeFile(join(base, name + '.ts'), execFileSync('git', ['show', `9d72923:server/src/${name}.ts`]));
  const { Backups: Previous } = await import(pathToFileURL(join(base, 'backups.ts')).href);
  const target = { workId: 'benchmark', title: 'Prueba', request: 'Cambiar' };
  for (const [label, Class] of [['9d72923', Previous], ['round4', Backups]] as const) {
    const data = join(base, label), b = new Class(root, data); await b.initialize();
    async function measure(name: string, fn: () => Promise<unknown>) { const start = performance.now(); await fn(); const ms = Math.round(performance.now() - start); records.push({ version: label, name, ms, objectsBytes: await bytes(join(data, 'backups/objects')), dataBytes: await bytes(data), trashBytes: label === 'round4' ? await bytes(join(data, 'backups/trash')) : 0 }); }
    await measure('first before', () => b.before(target)); await b.finish();
    for (let i = 0; i < 5; i++) await measure('unchanged before + after', async () => { await b.before(target); await b.finish(); });
    await measure('one change before + after', async () => { await b.before(target); await writeFile(join(root, 'foto-0.jpg'), Buffer.alloc(16384, 127)); await b.finish(); });
    await measure('undo', () => b.undo(b.target!.id));
  }
  await writeFile('docs/verification/issue4/benchmark-round4.json', JSON.stringify({ files: 2004, logicalBytes: 99876864, records }, null, 2)); console.log(records);
} finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
