import { mkdir, mkdtemp, writeFile, rm, readdir, stat, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Backups } from '../server/src/backups';
await mkdir('.local', { recursive: true });
const base = await mkdtemp(resolve('.local/undo-rework-benchmark-'));
const root = join(base, 'agency'), data = join(base, 'data'); await mkdir(root);
const target = { workId: 'benchmark', title: 'Prueba', request: 'Prueba' };
try {
  for (let i = 0; i < 2000; i++) { const bytes = Buffer.alloc(16 * 1024, i % 251); bytes.writeUInt32LE(i, 4); await writeFile(join(root, `foto-${i}.jpg`), bytes); }
  for (let i = 0; i < 4; i++) await writeFile(join(root, `pesada-${i}.jpg`), Buffer.alloc(16 * 1024 ** 2, i));
  // Exact baseline code, no checkout changes, services, or installation.
  const baselinePath = join(base, 'workspace-files.ts');
  await writeFile(baselinePath, execFileSync('git', ['show', '7b120b6:server/src/workspace-files.ts']));
  const { WorkspaceFiles } = await import(pathToFileURL(baselinePath).href);
  const baseline = new WorkspaceFiles(root); await baseline.scan();
  const oldPath = join(base, 'old-backups.ts');
  await writeFile(oldPath, execFileSync('git', ['show', 'ecfafed:server/src/backups.ts']));
  const { Backups: OldBackups } = await import(pathToFileURL(oldPath).href);
  const old = new OldBackups(root, join(base, 'old-data')); await old.initialize(); await old.before(target); await old.finish();
  const b = new Backups(root, data); await b.initialize();
  const records: { name: string; ms: number; contentBytes: number; objects: number }[] = [];
  async function measure(name: string, action: () => Promise<unknown>) {
    const start = performance.now(); await action(); const ms = performance.now() - start;
    const objects = await readdir(join(data, 'backups/objects')); let bytes = 0;
    for (const p of objects) bytes += (await stat(join(data, 'backups/objects', p))).size;
    records.push({ name, ms: Math.round(ms), contentBytes: bytes, objects: objects.length });
  }
  await measure('first copy (shared before scan)', () => b.before(target)); await b.finish();
  for (let i = 0; i < 5; i++) {
    await measure('main unchanged before + after scans', async () => { const before = await baseline.scan(); await baseline.scan(before); });
    await measure('PR18 ecfafed unchanged (four scans)', async () => { const before = await baseline.scan(); await old.before(target); await baseline.scan(before); await old.finish(); });
    await measure('rework unchanged shared before + after', async () => { await b.before(target); await b.finish(); });
  }
  await measure('rework one changed file before + after', async () => { await b.before(target); await writeFile(join(root, 'foto-0.jpg'), Buffer.alloc(16 * 1024, 127)); await b.finish(); });
  await measure('rework undo', () => b.undo(b.target!.id));
  const output = { baseline: '7b120b6', files: 2004, logicalBytes: 99876864, previousPR18: JSON.parse(await readFile('docs/verification/issue4/benchmark.json', 'utf8')), records };
  await writeFile('docs/verification/issue4/benchmark-rework.json', JSON.stringify(output, null, 2)); console.log(records);
} finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
