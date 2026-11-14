import { mkdir, realpath, lstat, opendir, open, readFile, writeFile, rename, unlink, rmdir, utimes } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SCAN_LIMITS } from './workspace-files';

type Entry = { size: number; mtimeMs: number; ctimeMs: number; hash: string };
type Manifest = { entries: Record<string, Entry>; directories: string[] };
export type UndoTarget = { id: string; workId: string; title: string; request: string };
type Copy = UndoTarget & { manifest: Manifest };
type State = { root: string; cache?: Manifest; pending?: Copy; undo?: Copy; notices: string[] };
export const BACKUP_LIMITS = { ...SCAN_LIMITS, bytes: 2 * 1024 ** 3, fileBytes: 256 * 1024 ** 2 };
const excluded = (name: string) => name.startsWith('.') || ['node_modules', 'adjuntos'].includes(name);
const inside = (root: string, target: string) => { const r = relative(root, target); return !isAbsolute(r) && r !== '..' && !r.startsWith('..\\') && !r.startsWith('../'); };

// One global undo slot, plus a pending pre-request copy. Objects are independent bytes,
// never hard links. Incomplete scans cannot be used as restoration manifests.
export class Backups {
  private state!: State;
  private root!: string;
  private store!: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(private workspace: string, private data: string, private limits = BACKUP_LIMITS) {}
  get target(): UndoTarget | undefined { const c = this.state?.undo; return c && { id: c.id, workId: c.workId, title: c.title, request: c.request }; }
  hasNotice(workId: string) { return this.state.notices.includes(workId); }
  async acknowledge(workId: string) { this.state.notices = this.state.notices.filter(id => id !== workId); await this.save(); }
  async initialize() {
    this.root = await realpath(this.workspace);
    await mkdir(this.data, { recursive: true });
    const data = await realpath(this.data);
    if (inside(this.root, data)) throw new Error('Backup data must be outside workspace');
    this.store = join(data, 'backups');
    await mkdir(join(this.store, 'objects'), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(join(this.store, 'state.json'), 'utf8'));
      if (this.state.root !== this.root || !Array.isArray(this.state.notices)) throw new Error('Invalid backup state');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.state = { root: this.root, notices: [] };
    }
    if (this.state.pending) await this.finish();
  }
  private async save() {
    const content = JSON.stringify(this.state);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await writeFile(join(this.store, 'state.tmp'), content, 'utf8');
      await rename(join(this.store, 'state.tmp'), join(this.store, 'state.json'));
    });
    await this.writes;
  }
  // Validate every existing component; realpath alone would allow an in-root link.
  private async path(path: string, missing = false) {
    const parts = path.split(/[\\/]/);
    if (!path || isAbsolute(path) || parts.some(p => !p || p === '..' || excluded(p) || /[:\x00-\x1f]/.test(p))) throw new Error('Unsafe backup path');
    if (await realpath(this.workspace) !== this.root) throw new Error('Workspace moved');
    let target = this.root;
    for (const part of parts) {
      target = join(target, part);
      try {
        if ((await lstat(target)).isSymbolicLink() || !inside(this.root, await realpath(target))) throw new Error('Link in restoration path');
      } catch (e) { if (!(missing && (e as NodeJS.ErrnoException).code === 'ENOENT')) throw e; }
    }
    return target;
  }
  private async scan(previous?: Manifest): Promise<Manifest> {
    const manifest: Manifest = { entries: Object.create(null), directories: [] };
    let visited = 0, count = 0, bytes = 0;
    const walk = async (folder: string, depth: number) => {
      if (depth > this.limits.depth) throw new Error('Backup depth limit');
      const target = folder ? await this.path(folder) : this.root;
      for await (const entry of await opendir(target)) {
        if (++visited > this.limits.entries) throw new Error('Backup entry limit');
        if (excluded(entry.name)) continue;
        const path = folder ? join(folder, entry.name) : entry.name;
        if (entry.isSymbolicLink()) continue;
        const full = await this.path(path);
        const stat = await lstat(full);
        if (stat.isDirectory()) { manifest.directories.push(path); await walk(path, depth + 1); }
        else if (stat.isFile()) {
          if (++count > this.limits.files || stat.size > this.limits.fileBytes || (bytes += stat.size) > this.limits.bytes) throw new Error('Backup size/count limit');
          const old = previous?.entries[path];
          let hash = old?.hash;
          if (!old || old.size !== stat.size || old.mtimeMs !== stat.mtimeMs || old.ctimeMs !== stat.ctimeMs) {
            const handle = await open(await this.path(path), 'r');
            try {
              const chunks: Buffer[] = []; let size = 0; const digest = createHash('sha256');
              for await (const chunk of handle.createReadStream({ autoClose: false })) {
                size += chunk.length;
                if (size > this.limits.fileBytes || bytes - stat.size + size > this.limits.bytes) throw new Error('Growing file limit');
                chunks.push(chunk); digest.update(chunk);
              }
              const after = await handle.stat();
              if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('File changed during backup');
              hash = digest.digest('hex');
              try { await writeFile(join(this.store, 'objects', hash), Buffer.concat(chunks), { flag: 'wx' }); }
              catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
            } finally { await handle.close(); }
          }
          manifest.entries[path] = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash: hash! };
        } else throw new Error('Unsupported file');
      }
    };
    if (await realpath(this.workspace) !== this.root) throw new Error('Workspace moved');
    await walk('', 0); return manifest;
  }
  async before(target: Omit<UndoTarget, 'id'>) {
    try {
      const manifest = await this.scan(this.state.cache);
      this.state.pending = { ...target, id: randomUUID(), manifest };
      this.state.cache = manifest;
      await this.save(); await this.clean(); return true;
    } catch {
      delete this.state.pending; delete this.state.undo; delete this.state.cache;
      await this.save().catch(() => {}); await this.clean().catch(() => {}); return false;
    }
  }
  async finish() {
    if (!this.state.pending) return true;
    const pending = this.state.pending;
    let complete = true;
    try {
      const after = await this.scan(pending.manifest);
      const signature = (m: Manifest) => JSON.stringify([Object.entries(m.entries).map(([p, e]) => [p, e.hash]).sort(), [...m.directories].sort()]);
      if (signature(after) !== signature(pending.manifest)) this.state.undo = pending;
      this.state.cache = after;
    } catch { complete = false; delete this.state.undo; delete this.state.cache; }
    delete this.state.pending;
    await this.save(); await this.clean(); return complete;
  }
  async undo(id: string) {
    const copy = this.state.undo;
    if (!copy || copy.id !== id) throw new Error('Undo unavailable');
    const current = await this.scan(this.state.cache);
    // Preflight *all* destination paths and content before the first mutation.
    for (const p of [...copy.manifest.directories, ...Object.keys(copy.manifest.entries)]) await this.path(p, true);
    for (const e of Object.values(copy.manifest.entries)) {
      if (!/^[a-f0-9]{64}$/.test(e.hash)) throw new Error('Invalid content identity');
      const bytes = await readFile(join(this.store, 'objects', e.hash));
      if (createHash('sha256').update(bytes).digest('hex') !== e.hash) throw new Error('Damaged backup');
    }
    // Consume durably before mutation: an interrupted restoration is never silently retried.
    delete this.state.undo; delete this.state.cache;
    if (!this.state.notices.includes(copy.workId)) this.state.notices.push(copy.workId);
    await this.save();
    for (const p of Object.keys(current.entries)) if (!copy.manifest.entries[p] || copy.manifest.directories.includes(p)) await unlink(await this.path(p));
    for (const p of [...current.directories].sort((a, b) => b.length - a.length)) if (!copy.manifest.directories.includes(p)) {
      try { await rmdir(await this.path(p)); } catch (e) { if (!['ENOTEMPTY', 'EEXIST'].includes((e as NodeJS.ErrnoException).code || '')) throw e; }
    }
    for (const p of copy.manifest.directories.sort((a, b) => a.length - b.length)) await mkdir(await this.path(p, true), { recursive: true });
    for (const [p, e] of Object.entries(copy.manifest.entries)) {
      if (current.entries[p]?.hash === e.hash) continue;
      const target = await this.path(p, true);
      // Remove an existing regular file first: never truncate a hard link to an outside file.
      try { const s = await lstat(target); if (!s.isFile()) throw new Error('Restoration type conflict'); await unlink(await this.path(p)); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      await writeFile(await this.path(p, true), await readFile(join(this.store, 'objects', e.hash)), { flag: 'wx' });
      await utimes(await this.path(p), new Date(), new Date(e.mtimeMs));
    }
    await this.clean();
  }
  async clean() {
    const retained = new Set([this.state.cache, this.state.pending?.manifest, this.state.undo?.manifest].flatMap(m => m ? Object.values(m.entries).map(e => e.hash) : []));
    for await (const entry of await opendir(join(this.store, 'objects'))) if (entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name) && !retained.has(entry.name)) await unlink(join(this.store, 'objects', entry.name));
  }
}
