import { mkdir, open, lstat, readdir, readFile, rename, unlink, rmdir, rm, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type Item = { path: string; hash?: string; mode: number };
export type TrashOrigin = { undoId: string; action: number; path: string; role: 'original' | 'prepared'; references: string[] };
type Record = TrashOrigin & { id: string; source: string; createdAt: number; generation: number; items: Item[] };
const inside = (root: string, p: string) => { const r = relative(root, p); return !isAbsolute(r) && r !== '..' && !r.startsWith('..\\') && !r.startsWith('../'); };
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
async function digest(path: string) {
  const h = await open(path, 'r'), hash = createHash('sha256');
  try { for await (const chunk of h.createReadStream({ autoClose: false })) hash.update(chunk); return hash.digest('hex'); }
  finally { await h.close(); }
}
async function inventory(root: string, path = ''): Promise<Item[]> {
  const full = join(root, path), s = await lstat(full);
  if (s.isSymbolicLink()) throw new Error('Trash refuses links');
  if (s.isFile()) return [{ path, hash: await digest(full), mode: s.mode }];
  if (!s.isDirectory()) throw new Error('Trash refuses special files');
  const result: Item[] = [{ path, mode: s.mode }];
  for (const name of await readdir(full)) result.push(...await inventory(root, join(path, name)));
  return result;
}
const same = (a: Item[], b: Item[]) => JSON.stringify(a.map(x => [x.path, x.hash]).sort()) === JSON.stringify(b.map(x => [x.path, x.hash]).sort());

// Recovery data is independent of the restoration journal. Nothing here is
// permanently removed except by purge(), or the verified cross-volume transfer.
export class BackupTrash {
  readonly directory: string;
  private generation = 0;
  constructor(data: string, private io: { rename: typeof rename; afterOperation?(operation: string): Promise<void> } = { rename }) { this.directory = join(data, 'backups', 'trash'); }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try { this.generation = JSON.parse(await readFile(join(this.directory, 'clock.json'), 'utf8')).generation; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!Number.isSafeInteger(this.generation) || this.generation < 0) throw new Error('Invalid trash clock');
  }
  private async records() {
    const result: Record[] = [];
    for (const name of await readdir(this.directory)) if (/^[a-f0-9-]{36}$/.test(name)) {
      const folder = join(this.directory, name);
      if ((await lstat(folder)).isSymbolicLink() || !inside(await realpath(this.directory), await realpath(folder))) throw new Error('Unsafe trash directory');
      let r: Record;
      try { r = JSON.parse(await readFile(join(folder, 'record.json'), 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      if (r.id !== name || !Array.isArray(r.items) || !Array.isArray(r.references) || !Number.isFinite(r.createdAt) || !Number.isSafeInteger(r.generation)) throw new Error('Invalid trash record');
      result.push(r);
    } return result;
  }
  async move(source: string, origin: TrashOrigin, checkSource: () => Promise<unknown> = async () => {}) {
    await checkSource();
    const items = await inventory(source), id = randomUUID(), folder = join(this.directory, id);
    await mkdir(folder);
    // Before record publication no payload has moved. Incomplete folders are
    // ignored by collection and retained, including across a process exit.
    await this.io.afterOperation?.('trash-mkdir');
    const record: Record = { ...origin, id, source, createdAt: Date.now(), generation: this.generation, items };
    const h = await open(join(folder, 'record.tmp'), 'wx');
    try { await h.writeFile(JSON.stringify(record), 'utf8'); await h.sync(); } finally { await h.close(); }
    await rename(join(folder, 'record.tmp'), join(folder, 'record.json'));
    await this.io.afterOperation?.('trash-record');
    const destination = join(folder, 'content');
    try { await checkSource(); await this.io.rename(source, destination); await this.io.afterOperation?.('trash-rename'); await checkSource(); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      // A full, synced, hash-verified copy exists BEFORE source removal. A crash
      // at any point leaves the source, the verified destination, or both.
      const staging = join(folder, 'copying');
      for (const item of items) {
        const target = join(staging, item.path);
        if (!item.hash) { await mkdir(target, { recursive: true }); await this.io.afterOperation?.('trash-copy-mkdir'); }
        else {
          const input = await open(join(source, item.path), 'r'), output = await open(target, 'wx');
          try {
            await this.io.afterOperation?.('trash-copy-open');
            for await (const chunk of input.createReadStream({ autoClose: false })) { await output.writeFile(chunk); await this.io.afterOperation?.('trash-copy-write'); }
            await output.sync(); await this.io.afterOperation?.('trash-copy-sync');
          }
          finally { await input.close(); await output.close(); }
        }
      }
      if (!same(items, await inventory(staging)) || !same(items, await inventory(source))) throw new Error('Trash transfer verification failed');
      await rename(staging, destination);
      await this.io.afterOperation?.('trash-copy-publish');
      // Source removal is a transfer, never a purge: the complete verified data
      // is already durable in the private trash. Recheck each leaf before removing.
      for (const item of [...items].sort((a, b) => b.path.length - a.path.length)) {
        const full = join(source, item.path);
        await checkSource();
        if ((await lstat(full)).isSymbolicLink()) throw new Error('Source changed during transfer');
        if (item.hash) {
          if (await digest(full) !== item.hash) throw new Error('Source changed during transfer');
          if (!(item.mode & 0o200)) { const h = await open(full, 'r'); try { await h.chmod(0o666); } finally { await h.close(); } }
          await unlink(full);
        } else await rmdir(full);
        await this.io.afterOperation?.('trash-source-transfer');
      }
    }
    if (!same(items, await inventory(destination))) throw new Error('Trash content mismatch');
    return destination;
  }
  async find(undoId: string, action: number, role: TrashOrigin['role']) {
    for (const r of (await this.records()).reverse()) if (r.undoId === undoId && r.action === action && r.role === role) {
      const content = join(this.directory, r.id, 'content');
      try { if (same(r.items, await inventory(content))) return content; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  async references() { return new Set((await this.records()).flatMap(r => [...r.references, ...r.items.flatMap(i => i.hash ? [i.hash] : [])])); }
  async completedCopy() {
    const generation = this.generation + 1;
    const h = await open(join(this.directory, 'clock.tmp'), 'w');
    try { await h.writeFile(JSON.stringify({ generation })); await h.sync(); } finally { await h.close(); }
    await rename(join(this.directory, 'clock.tmp'), join(this.directory, 'clock.json')); this.generation = generation;
  }
  // Deliberately separate from undo/retry/discard. A missing/corrupt record
  // fails closed; an interrupted transfer is retained indefinitely.
  async purge(now = Date.now(), protectedUndoId?: string) {
    for (const r of await this.records()) {
      if (r.undoId === protectedUndoId || now - r.createdAt < TRASH_RETENTION_MS || this.generation - r.generation < 3) continue;
      const folder = join(this.directory, r.id);
      try { if (!same(r.items, await inventory(join(folder, 'content')))) continue; }
      catch { continue; }
      await rm(folder, { recursive: true });
    }
  }
}
