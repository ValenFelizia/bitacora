import { mkdir, realpath, lstat, open, readFile, rename, unlink, rmdir, utimes, chmod, readdir } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { WorkspaceFiles, SCAN_LIMITS, excludedFromCopy, type FileScan, type Fingerprint } from './workspace-files';
export type UndoTarget = { id: string; workId: string; title: string; request: string; messageId?: string; retry?: boolean };
type Copy = UndoTarget & { before: FileScan; after?: FileScan };
type Value = { kind: 'file'; entry: Fingerprint } | { kind: 'directory' } | { kind: 'missing' };
type Action = { path: string; from: Value; to: Value; started?: boolean; done?: boolean };
type Plan = { actions: Action[]; skipped: string[]; omitted: string[] };
type State = { version: 2; root: string; cache?: FileScan; pending?: Copy; undo?: Copy; plan?: Plan; notices: string[] };
export const BACKUP_LIMITS = { ...SCAN_LIMITS, bytes: 2 * 1024 ** 3, fileBytes: 256 * 1024 ** 2 };
const inside = (root: string, target: string) => { const r = relative(root, target); return !isAbsolute(r) && r !== '..' && !r.startsWith('..\\') && !r.startsWith('../'); };
const readonly = (e: Fingerprint) => (e.mode! & 0o200) === 0;
const equal = (a: Value, b: Value) => a.kind === b.kind && (a.kind !== 'file' || (b.kind === 'file' && a.entry.hash === b.entry.hash && readonly(a.entry) === readonly(b.entry)));
const value = (m: FileScan, p: string): Value => Object.hasOwn(m.entries, p) ? { kind: 'file', entry: m.entries[p] } : m.directories?.includes(p) ? { kind: 'directory' } : { kind: 'missing' };
const names = (paths: string[]) => [...new Set(paths.map(p => basename(p)))];
export class RestoreProblem extends Error {
  constructor(path: string, reason: string) { super(`No pude deshacer todavía: ${reason}${path ? ` (${basename(path)})` : ''}. Cerrá el archivo si está abierto y tocá Reintentar deshacer.`); }
}
export class Backups {
  private state!: State;
  private root!: string;
  private store!: string;
  private writes: Promise<void> = Promise.resolve();
  readonly files: WorkspaceFiles;
  lastScan?: FileScan;
  latestOmitted: string[] = [];
  constructor(private workspace: string, private data: string, private limits = BACKUP_LIMITS, files?: WorkspaceFiles,
    private io = { rename, afterStep: async (_index: number) => {} }) { this.files = files || new WorkspaceFiles(workspace); }
  get target(): UndoTarget | undefined { const c = this.state?.undo; return c && { id: c.id, workId: c.workId, title: c.title, request: c.request, messageId: c.messageId, retry: !!this.state.plan }; }
  get restoring() { return !!this.state?.plan; }
  hasNotice(workId: string) { return this.state.notices.includes(workId); }
  async acknowledge(workId: string) { this.state.notices = this.state.notices.filter(id => id !== workId); await this.save(); }
  async initialize() {
    this.root = await realpath(this.workspace); await mkdir(this.data, { recursive: true });
    const data = await realpath(this.data); if (inside(this.root, data)) throw new Error('Backup data must be outside workspace');
    this.store = join(data, 'backups'); await mkdir(join(this.store, 'objects'), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.store, 'state.json'), 'utf8'));
      if (saved.version !== 2) {
        await rename(join(this.store, 'state.json'), join(this.store, `legacy-${randomUUID()}.json`));
        this.state = { version: 2, root: this.root, notices: [] };
      } else { this.state = saved; this.validate(); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.state = { version: 2, root: this.root, notices: [] };
    }
    // Startup cannot attribute intervening manual edits to an unfinished request.
    // Keep pending objects until a subsequent successful request supersedes them.
    if (this.state.pending) { delete this.state.undo; delete this.state.pending; await this.save(); }
  }
  private validPath(path: string) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).some(p => !p || p === '..' || excludedFromCopy(p) || /[:\x00-\x1f]|[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe backup path');
  }
  private validate() {
    if (this.state.root !== this.root || !Array.isArray(this.state.notices) || this.state.notices.some(p => typeof p !== 'string')) throw new Error('Invalid backup state');
    for (const m of [this.state.cache, this.state.pending?.before, this.state.undo?.before, this.state.undo?.after]) {
      if (!m) continue;
      if (!m.entries || !Array.isArray(m.directories) || !m.omitted || !Array.isArray(m.warnings)) throw new Error('Invalid manifest');
      for (const p of [...Object.keys(m.entries), ...m.directories, ...Object.keys(m.omitted)]) this.validPath(p);
      for (const e of Object.values(m.entries)) if (!/^[a-f0-9]{64}$/.test(e.hash) || ![e.size, e.mtimeMs, e.ctimeMs, e.mode].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) throw new Error('Invalid file fingerprint');
    }
    if (this.state.undo && !this.state.undo.after) throw new Error('Missing after manifest');
    for (const copy of [this.state.pending, this.state.undo]) if (copy && (!/^[a-zA-Z0-9-]+$/.test(copy.id) || [copy.workId, copy.title, copy.request].some(v => typeof v !== 'string') || (copy.messageId !== undefined && typeof copy.messageId !== 'string'))) throw new Error('Invalid copy identity');
    if (this.state.plan) {
      if (!this.state.undo || !Array.isArray(this.state.plan.actions) || !Array.isArray(this.state.plan.skipped) || !Array.isArray(this.state.plan.omitted)) throw new Error('Invalid restoration plan');
      for (const a of this.state.plan.actions) {
        this.validPath(a.path);
        if (!equal(a.from, value(this.state.undo.after!, a.path)) || !equal(a.to, value(this.state.undo.before, a.path)) || equal(a.from, a.to)) throw new Error('Plan does not match manifests');
      }
      for (const p of [...this.state.plan.skipped, ...this.state.plan.omitted]) this.validPath(p);
    }
  }
  private async save() {
    const content = JSON.stringify(this.state);
    this.writes = this.writes.catch(() => {}).then(async () => {
      const h = await open(join(this.store, 'state.tmp'), 'w');
      try { await h.writeFile(content, 'utf8'); await h.sync(); } finally { await h.close(); }
      await rename(join(this.store, 'state.tmp'), join(this.store, 'state.json'));
    }); await this.writes;
  }
  // Full component checks at preflight AND immediately before each mutation.
  private async path(path: string, missing = false) {
    this.validPath(path); if (await realpath(this.workspace) !== this.root) throw new Error('Workspace moved');
    let target = this.root;
    for (const part of path.split(/[\\/]/)) {
      target = join(target, part);
      try {
        const resolved = await realpath(target);
        if ((await lstat(target)).isSymbolicLink() || !inside(this.root, resolved) || relative(this.root, resolved).split(/[\\/]/).some(excludedFromCopy)) throw new RestoreProblem(path, 'hay un enlace o una carpeta excluida en el camino');
      }
      catch (e) { if (!(missing && ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || ''))) throw e; }
    } return target;
  }
  private async capture(path: string, stat: Stats) {
    const temporary = join(this.store, 'objects', `pending-${randomUUID()}`);
    const output = await open(temporary, 'wx');
    let bytes = 0; const digest = createHash('sha256');
    try {
      const input = await open(path, 'r');
      try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        bytes += chunk.length; if (bytes > this.limits.fileBytes || bytes > stat.size) throw new Error('Growing file limit');
        digest.update(chunk); await output.write(chunk);
      }
      const after = await input.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('File changed during copy');
      } finally { await input.close(); }
      const hash = digest.digest('hex'); await output.close();
      await rename(temporary, join(this.store, 'objects', hash)); return hash;
    } finally { await output.close(); await unlink(temporary).catch(() => {}); }
  }
  private async scan(previous = this.state.cache) {
    this.lastScan = undefined;
    this.lastScan = await this.files.scan(previous, { limits: this.limits, capture: (p, s) => this.capture(p, s) });
    return this.lastScan;
  }
  async before(target: Omit<UndoTarget, 'id'>) {
    if (this.restoring) throw new RestoreProblem('', 'hay una restauración pendiente');
    try {
      const before = await this.scan();
      if (before.warnings.some(w => !w.endsWith('link skipped'))) throw new Error('Incomplete copy');
      this.state.pending = { ...target, id: randomUUID(), before }; this.state.cache = before;
      await this.save(); return true;
    } catch {
      delete this.state.pending; delete this.state.undo; delete this.state.cache;
      await this.save().catch(() => {}); return false;
    }
  }
  async finish() {
    const pending = this.state.pending;
    this.latestOmitted = [];
    try {
      const after = await this.scan(pending?.before);
      if (after.warnings.some(w => !w.endsWith('link skipped'))) throw new Error('Incomplete copy');
      if (pending) {
        this.latestOmitted = names(this.omittedChanges(pending.before, after));
        if (this.difference(pending.before, after).length || this.latestOmitted.length) this.state.undo = { ...pending, after };
      }
      this.state.cache = after; delete this.state.pending; await this.save(); await this.clean(); return true;
    } catch { delete this.state.undo; delete this.state.cache; delete this.state.pending; await this.save(); return false; }
  }
  private omittedChanges(before: FileScan, after: FileScan) {
    return [...new Set([...Object.keys(before.omitted || {}), ...Object.keys(after.omitted || {})])].filter(p => before.omitted?.[p] !== after.omitted?.[p] || before.entries[p]?.hash !== after.entries[p]?.hash);
  }
  private difference(before: FileScan, after: FileScan) {
    return [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries), ...(before.directories || []), ...(after.directories || [])])]
      .filter(p => !before.omitted?.[p] && !after.omitted?.[p] && !equal(value(before, p), value(after, p)));
  }
  private async current(path: string): Promise<Value> {
    const full = await this.path(path, true);
    try {
      const stat = await lstat(full);
      if (stat.isDirectory()) return { kind: 'directory' };
      if (!stat.isFile()) throw new RestoreProblem(path, 'no es un archivo común');
      return { kind: 'file', entry: { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode, hash: await this.digest(full) } };
    } catch (e) {
      if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || '')) return { kind: 'missing' };
      throw new RestoreProblem(path, 'no puedo leer ese archivo o está abierto');
    }
  }
  private stage(a: Action, index: number) { return `.bitacora-undo-${this.state.undo!.id}-${index}.tmp`; }
  private async digest(path: string) {
    const h = await open(path, 'r'); const digest = createHash('sha256');
    try { for await (const chunk of h.createReadStream({ autoClose: false })) digest.update(chunk); return digest.digest('hex'); }
    finally { await h.close(); }
  }
  private async preflight(plan: Plan) {
    this.validate();
    for (const a of plan.actions) {
      await this.path(a.path, true);
      if (a.to.kind === 'file') {
        try { if (await this.digest(join(this.store, 'objects', a.to.entry.hash)) !== a.to.entry.hash) throw new Error('Content mismatch'); }
        catch { throw new RestoreProblem(a.path, 'la copia está incompleta'); }
      }
    }
    for (const a of plan.actions.filter(a => !a.done && !plan.skipped.includes(a.path))) {
      const current = await this.current(a.path);
      if (a.started && equal(current, a.to)) { a.done = true; continue; }
      const finishing = a.started && current.kind === 'file' && a.to.kind === 'file' && current.entry.hash === a.to.entry.hash;
      if (!equal(current, a.from) && !finishing && !(a.started && current.kind === 'missing')) { plan.skipped.push(a.path); continue; }
      if (current.kind === 'file') {
        try { const h = await open(await this.path(a.path), 'r+'); await h.close(); }
        catch { throw new RestoreProblem(a.path, 'el archivo está abierto o no se puede reemplazar'); }
      }
    }
    for (const a of plan.actions.filter(a => !a.done && !plan.skipped.includes(a.path) && a.from.kind === 'directory' && a.to.kind !== 'directory')) {
      if ((await this.current(a.path)).kind !== 'directory') continue;
      for (const child of await readdir(await this.path(a.path))) {
        const path = join(a.path, child);
        if (!plan.actions.some(other => other.path === path && other.to.kind === 'missing' && !plan.skipped.includes(path))) {
          if (a.to.kind === 'file') throw new RestoreProblem(a.path, 'hay una carpeta con archivos que no debo tocar');
          plan.skipped.push(a.path); break;
        }
      }
    }
    for (const a of plan.actions) if (a.to.kind === 'file' && a.from.kind === 'directory' && plan.skipped.some(p => p.startsWith(a.path + '\\') || p.startsWith(a.path + '/'))) throw new RestoreProblem(a.path, 'hay cambios posteriores dentro de esa carpeta');
  }
  private async stageFile(a: Action, index: number) {
    if (a.to.kind !== 'file') return;
    const parent = dirname(a.path), folder = parent === '.' ? this.root : await this.path(parent, true);
    const temporary = join(folder, this.stage(a, index));
    try {
      const s = await lstat(temporary);
      if (!s.isFile() || s.isSymbolicLink()) throw new RestoreProblem(a.path, 'hay un enlace en el temporal');
      if (await this.digest(temporary) === a.to.entry.hash) return;
      await unlink(temporary); // Incomplete staging after disk-full or process exit.
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const output = await open(temporary, 'wx');
    try {
      const input = await open(join(this.store, 'objects', a.to.entry.hash), 'r');
      try {
        const hash = createHash('sha256');
        for await (const chunk of input.createReadStream({ autoClose: false })) { hash.update(chunk); await output.write(chunk); }
        if (hash.digest('hex') !== a.to.entry.hash) throw new RestoreProblem(a.path, 'la copia está incompleta');
        await output.sync();
      }
      finally { await input.close(); }
    } catch (e) { await output.close(); await unlink(temporary).catch(() => {}); throw e; }
    finally { await output.close(); }
  }
  async undo(id: string) {
    this.validate(); const copy = this.state.undo;
    if (!copy || copy.id !== id) throw new RestoreProblem('', 'ese pedido ya no se puede deshacer');
    if (!this.state.plan) {
      this.state.plan = { actions: this.difference(copy.before, copy.after!).map(path => ({ path, from: value(copy.after!, path), to: value(copy.before, path) })), skipped: [], omitted: this.omittedChanges(copy.before, copy.after!) };
      await this.save();
    }
    const plan = this.state.plan; await this.preflight(plan); await this.save();
    // Prepare data while all original files are still intact. Missing parents are
    // created by journalled directory operations before staging their children.
    for (const [i, a] of plan.actions.entries()) if (!a.done && !plan.skipped.includes(a.path) && a.to.kind === 'file') {
      try { if ((await lstat(dirname(join(this.root, a.path)))).isDirectory()) await this.stageFile(a, i); }
      catch (e) { if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || '')) throw new RestoreProblem(a.path, 'no pude preparar el archivo'); }
    }
    const ordered = plan.actions.map((a, i) => ({ a, i })).sort((x, y) => {
      const priority = (a: Action) => a.to.kind === 'missing' ? 0 : a.to.kind === 'directory' ? 1 : 2;
      return priority(x.a) - priority(y.a) || (priority(x.a) === 0 ? y.a.path.length - x.a.path.length : x.a.path.length - y.a.path.length);
    });
    for (const { a, i } of ordered) {
      if (a.done || plan.skipped.includes(a.path)) continue;
      const current = await this.current(a.path);
      if (a.started && equal(current, a.to)) { a.done = true; await this.save(); continue; }
      const finishing = a.started && current.kind === 'file' && a.to.kind === 'file' && current.entry.hash === a.to.entry.hash;
      if (!equal(current, a.from) && !finishing && !(a.started && current.kind === 'missing')) { plan.skipped.push(a.path); await this.save(); continue; }
      const destination = await this.path(a.path, true);
      a.started = true; await this.save();
      if (!equal(await this.current(a.path), current)) { plan.skipped.push(a.path); await this.save(); continue; }
      try {
        if (a.to.kind === 'missing') { if (current.kind === 'directory') await rmdir(destination); else if (current.kind === 'file') await unlink(destination); }
        else if (a.to.kind === 'directory') { if (current.kind === 'file') await unlink(destination); await mkdir(destination, { recursive: true }); }
        else {
          if (!finishing) {
            if (current.kind === 'directory') await rmdir(destination);
            await this.stageFile(a, i);
            const expected: Value = current.kind === 'directory' ? { kind: 'missing' } : current;
            if (!equal(await this.current(a.path), expected)) { plan.skipped.push(a.path); await this.save(); continue; }
            const temporary = join(dirname(await this.path(a.path, true)), this.stage(a, i));
            if ((await lstat(temporary)).isSymbolicLink()) throw new Error('Link in temporary');
            await this.io.rename(temporary, await this.path(a.path, true));
          }
          await chmod(await this.path(a.path), readonly(a.to.entry) ? 0o444 : 0o666);
          await utimes(await this.path(a.path), new Date(), new Date(a.to.entry.mtimeMs));
        }
      } catch { throw new RestoreProblem(a.path, 'el archivo está abierto o no pude guardar el cambio'); }
      await this.io.afterStep(i); a.done = true; await this.save();
    }
    const restored = plan.actions.filter(a => a.done && !plan.skipped.includes(a.path)).map(a => a.path);
    const result = { restored, skipped: names(plan.skipped), omitted: names(plan.omitted), target: this.target! };
    // Remove only app-generated, verified staging files; never traverse a link.
    for (const [i, a] of plan.actions.entries()) {
      if (a.to.kind !== 'file') continue;
      const parent = dirname(a.path);
      try {
        const folder = parent === '.' ? this.root : await this.path(parent);
        const temp = join(folder, this.stage(a, i));
        const s = await lstat(temp);
        if (s.isFile() && !s.isSymbolicLink() && await this.digest(temp) === a.to.entry.hash) await unlink(temp);
      } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || '')) throw e; }
    }
    const active = this.state;
    this.state = { ...active, undo: undefined, plan: undefined, cache: undefined,
      notices: restored.length && !active.notices.includes(copy.workId) ? [...active.notices, copy.workId] : active.notices };
    try { await this.save(); }
    catch (e) { this.state = active; throw e; }
    // Failure to collect unreferenced objects must not turn a completed restore
    // into a failed operation. The next successful request also runs collection.
    await this.clean().catch(() => {}); return result;
  }
  async clean() {
    this.validate();
    const retained = new Set([this.state.cache, this.state.pending?.before, this.state.undo?.before, this.state.undo?.after].flatMap(m => m ? Object.values(m.entries).map(e => e.hash) : []));
    for (const entry of await readdir(join(this.store, 'objects'))) if (/^[a-f0-9]{64}$/.test(entry) && !retained.has(entry)) await unlink(join(this.store, 'objects', entry));
  }
}
