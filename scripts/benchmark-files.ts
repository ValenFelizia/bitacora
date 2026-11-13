import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkspaceFiles } from '../server/src/workspace-files';
await mkdir('.local', { recursive: true });
const dir = await mkdtemp(resolve('.local/scan-benchmark-'));
try {
  const files = new WorkspaceFiles(dir);
  const small = Buffer.alloc(2048, 65), large = Buffer.alloc(16 * 1024 * 1024, 66);
  for (let i = 0; i < 2000; i++) await writeFile(join(dir, `small-${i}.png`), small);
  for (let i = 0; i < 8; i++) await writeFile(join(dir, `large-${i}.png`), large);
  const times: number[] = [];
  const hashedBytes: number[] = [];
  let maxTimerGapMs = 0;
  let tick = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maxTimerGapMs = Math.max(maxTimerGapMs, now - tick); tick = now; }, 10);
  let before: any;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const snapshot = await files.scan(before);
    times.push(Math.round(performance.now() - start));
    hashedBytes.push(snapshot.hashedBytes);
    before = snapshot;
    if (i === 1) await writeFile(join(dir, 'small-0.png'), Buffer.alloc(2049, 67));
  }
  clearInterval(timer);
  const output = { files: 2008, bytes: 2000 * small.length + 8 * large.length, scansMs: times, hashedBytes, maxTimerGapMs: Math.round(maxTimerGapMs), serializedSnapshotBytes: JSON.stringify(before).length };
  await writeFile(resolve(`docs/verification/issue5/benchmark-${process.argv[2] || 'before'}.json`), JSON.stringify(output, null, 2));
  console.log(output);
} finally { await rm(dir, { recursive: true, force: true }); }
