import { mkdir, mkdtemp, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Backups } from '../server/src/backups';
await mkdir('.local', { recursive: true });
const base = await mkdtemp(resolve('.local/undo-benchmark-'));
const root = join(base, 'agency'), data = join(base, 'data'); await mkdir(root);
const target = { workId: 'benchmark', title: 'Prueba', request: 'Prueba' };
try {
  // JPEG headers, synthetic unique bytes; no real agency photos.
  for (let i = 0; i < 2000; i++) { const b = Buffer.alloc(16 * 1024, i % 251); b.writeUInt32LE(i, 4); b[0] = 255; b[1] = 216; await writeFile(join(root, `foto-${i}.jpg`), b); }
  for (let i = 0; i < 4; i++) await writeFile(join(root, `pesada-${i}.jpg`), Buffer.alloc(16 * 1024 ** 2, i));
  const b = new Backups(root, data); await b.initialize();
  const records: unknown[] = [];
  async function measure(name: string, action: () => Promise<unknown>) {
    const start = performance.now(); await action();
    const objects = await readdir(join(data, 'backups/objects'));
    let bytes = 0; for (const p of objects) bytes += (await stat(join(data, 'backups/objects', p))).size;
    records.push({ name, ms: Math.round(performance.now() - start), objects: objects.length, contentBytes: bytes, manifestBytes: (await stat(join(data, 'backups/state.json'))).size });
  }
  await measure('primera copia', () => b.before(target));
  await b.finish();
  await measure('pedido sin cambios (copia y comparación final)', async () => { await b.before(target); await b.finish(); });
  await measure('pedido con un archivo cambiado (copia y comparación final)', async () => { await b.before(target); await writeFile(join(root, 'foto-0.jpg'), Buffer.alloc(16 * 1024, 127)); await b.finish(); });
  await measure('deshacer', () => b.undo(b.target!.id));
  await mkdir('docs/verification/issue4', { recursive: true });
  await writeFile('docs/verification/issue4/benchmark.json', JSON.stringify({ files: 2004, logicalBytes: 2000 * 16 * 1024 + 4 * 16 * 1024 ** 2, records }, null, 2));
  console.log(records);
} finally { await rm(base, { recursive: true, force: true }); }
