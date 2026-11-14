import { mkdir, realpath, lstat, open, readFile, rename, unlink, readdir } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { BackupTrash } from './backup-trash';
import { WorkspaceFiles, SCAN_LIMITS, excludedFromCopy, type FileScan, type Fingerprint } from './workspace-files';
export type UndoTarget = { id: string; workId: string; title: string; request: string; messageId?: string; retry?: boolean };
type Copy = UndoTarget & { before: FileScan; after?: FileScan };
type Value = { kind: 'file'; entry: Fingerprint } | { kind: 'directory' } | { kind: 'missing' };
type Action = { path: string; from: Value; to: Value; started?: boolean; done?: boolean; removed?: boolean };
type Plan = { actions: Action[]; skipped: string[]; omitted: string[]; active?: boolean };
type State = { version: 2; root: string; cache?: FileScan; pending?: Copy; undo?: Copy; plan?: Plan; notices: string[]; warned?: string[]; receipt?: string };
type RestoreIO = { rename: typeof rename; afterStep(index: number): Promise<void>; beforeMutation?(path: string, kind: string): Promise<void>; afterMutation?(path: string, kind: string): Promise<void>; afterOperation?(operation: string): Promise<void> };
export const BACKUP_LIMITS = { ...SCAN_LIMITS, bytes: 2 * 1024 ** 3, fileBytes: 256 * 1024 ** 2 };
const inside = (root: string, target: string) => { const r = relative(root, target); return !isAbsolute(r) && r !== '..' && !r.startsWith('..\\') && !r.startsWith('../'); };
const readonly = (e: Fingerprint) => (e.mode! & 0o200) === 0;
const equal = (a: Value, b: Value) => a.kind === b.kind && (a.kind !== 'file' || (b.kind === 'file' && a.entry.hash === b.entry.hash && readonly(a.entry) === readonly(b.entry)));
export const pathKey = (p: string) => p.replaceAll('/', '\\').normalize('NFC').toUpperCase();
const beneath = (p: string, parent: string) => !parent || pathKey(p) === pathKey(parent) || pathKey(p).startsWith(pathKey(parent) + '\\');
const value = (m: FileScan, p: string): Value => {
  const name = Object.hasOwn(m.entries, p) ? p : Object.keys(m.entries).find(n => pathKey(n) === pathKey(p));
  return name ? { kind: 'file', entry: m.entries[name] } : m.directories?.some(n => pathKey(n) === pathKey(p)) ? { kind: 'directory' } : { kind: 'missing' };
};
const names = (paths: string[]) => [...new Set(paths)].map(p => basename(p));
export class RestoreProblem extends Error {
  constructor(path: string, reason: string) { super(`No pude deshacer todavía: ${reason}${path ? ` (${basename(path)})` : ''}. Podés volver a intentar Deshacer.`); }
}
class LaterChange extends Error {}
export class Backups {
  private state!: State;
  private root!: string;
  private store!: string;
  private writes: Promise<void> = Promise.resolve();
  readonly files: WorkspaceFiles;
  lastScan?: FileScan;
  latestOmitted: string[] = [];
  private disabled = false;
  private requestReceipt?: string;
  private trash!: BackupTrash;
  private collectionAllowed = false;
  get trashLocation() { return this.trash.directory; }
  invalidated = false;
  get receipt() { return this.requestReceipt; }
  constructor(private workspace: string, private data: string, private limits = BACKUP_LIMITS, files?: WorkspaceFiles,
    private io: RestoreIO = { rename, afterStep: async (_index: number) => {} }) { this.files = files || new WorkspaceFiles(workspace); }
  get target(): UndoTarget | undefined { const c = !this.disabled && this.state?.undo; return c ? { id: c.id, workId: c.workId, title: c.title, request: c.request, messageId: c.messageId, retry: this.restoring } : undefined; }
  get restoring() { return !!this.state?.plan?.active; }
  hasNotice(workId: string) { return this.state.notices.includes(workId); }
  async acknowledge(workId: string) { this.state.notices = this.state.notices.filter(id => id !== workId); await this.save(); }
  async initialize(latestRequestReceipt?: string) {
    this.root = await realpath(this.workspace); await mkdir(this.data, { recursive: true });
    const data = await realpath(this.data); if (inside(this.root, data)) throw new Error('Backup data must be outside workspace');
    this.store = join(data, 'backups'); await mkdir(join(this.store, 'objects'), { recursive: true });
    this.trash = new BackupTrash(data, { rename, afterOperation: operation => this.io.afterOperation?.(operation) || Promise.resolve() }); await this.trash.initialize();
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
    this.requestReceipt = this.state.receipt;
    if (this.state.undo || this.state.pending || this.state.plan) {
      let marker: string | undefined;
      try { marker = JSON.parse(await readFile(join(this.data, 'backup-invalidation.json'), 'utf8')).receipt; } catch { /* Missing/unreadable proof is not authorization. */ }
      if (!latestRequestReceipt || marker !== latestRequestReceipt || this.state.receipt !== latestRequestReceipt) {
        this.invalidated = true;
        delete this.state.undo; delete this.state.pending; delete this.state.plan;
        await this.save().catch(() => {});
      }
    }
    // Startup cannot attribute intervening manual edits to an unfinished request.
    // Keep pending objects until a subsequent successful request supersedes them.
    if (this.state.pending) { delete this.state.undo; delete this.state.pending; await this.save(); }
    if (this.state.plan) {
      await this.recoverProgress(this.state.plan);
      if (!this.state.plan.active) delete this.state.plan;
      await this.save();
    }
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
      for (const p of m.incomplete || []) if (p) this.validPath(p);
      const seen = new Set<string>();
      for (const p of [...Object.keys(m.entries), ...m.directories]) {
        if (seen.has(pathKey(p))) throw new RestoreProblem(p, 'hay nombres que sólo difieren en mayúsculas o en cómo se escribe un acento');
        seen.add(pathKey(p));
      }
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
      if (new Set(this.state.plan.actions.map(a => pathKey(a.path))).size !== this.state.plan.actions.length) throw new Error('Ambiguous plan');
      for (const p of [...this.state.plan.skipped, ...this.state.plan.omitted]) this.validPath(p);
    }
  }
  private async save() {
    const content = JSON.stringify(this.state);
    this.writes = this.writes.catch(() => {}).then(async () => {
      const h = await open(join(this.store, 'state.tmp'), 'w');
      try { await h.writeFile(content, 'utf8'); await h.sync(); } finally { await h.close(); }
      await rename(join(this.store, 'state.tmp'), join(this.store, 'state.json'));
      await this.io.afterOperation?.('journal');
    }); await this.writes;
  }
  private async writeInvalidation(receipt: string) {
    // Separate from state.json, which may itself be locked. Written BEFORE an
    // unbacked request can be released. The host log supplies independent proof.
    const file = join(this.data, 'backup-invalidation.json');
    const h = await open(file + '.tmp', 'w');
    try { await h.writeFile(JSON.stringify({ receipt }), 'utf8'); await h.sync(); } finally { await h.close(); }
    await rename(file + '.tmp', file);
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
        digest.update(chunk); await output.writeFile(chunk);
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
    // WorkspaceFiles has a result-detection cache of its own. Only reuse hashes
    // whose bytes are actually present in the private content store.
    const available = new Set(await readdir(join(this.store, 'objects')));
    const reusable = previous ? { ...previous, entries: Object.fromEntries(Object.entries(previous.entries).filter(([, e]) => available.has(e.hash))) } : null;
    this.lastScan = await this.files.scan(reusable, { limits: this.limits, capture: (p, s) => this.capture(p, s) });
    return this.lastScan;
  }
  async before(target: Omit<UndoTarget, 'id'>, receipt: string = randomUUID()) {
    if (this.restoring) throw new RestoreProblem('', 'hay una restauración pendiente');
    this.lastScan = undefined;
    this.requestReceipt = receipt; this.state.receipt = receipt;
    try { await this.writeInvalidation(receipt); }
    catch { this.disabled = true; }
    if (this.disabled) {
      delete this.state.undo; delete this.state.pending; delete this.state.cache;
      await this.save().catch(() => {});
      this.lastScan = await this.files.scan().catch(() => undefined);
      return false;
    }
    try {
      const before = await this.scan();
      this.state.pending = { ...target, id: randomUUID(), before }; this.state.cache = before;
      this.validate(); await this.save(); return true;
    } catch {
      delete this.state.pending; delete this.state.undo; delete this.state.cache;
      await this.save().catch(() => {}); return false;
    }
  }
  async finish() {
    const pending = this.state.pending;
    this.latestOmitted = [];
    if (this.disabled) { this.lastScan = await this.files.scan(); return false; }
    try {
      const after = await this.scan(pending?.before);
      if (pending) {
        const exclusions = [...new Set([...Object.keys(pending.before.omitted || {}), ...Object.keys(after.omitted || {}), ...(pending.before.incomplete || []).map(p => p || 'parte de la carpeta'), ...(after.incomplete || []).map(p => p || 'parte de la carpeta')])];
        this.latestOmitted = names(exclusions.filter(p => !this.state.warned?.some(old => pathKey(old) === pathKey(p))));
        this.state.warned = exclusions;
        if (this.difference(pending.before, after).length || this.omittedChanges(pending.before, after).length || this.renamed(pending.before, after)) this.state.undo = { ...pending, after };
      }
      this.state.cache = after; delete this.state.pending; this.validate(); await this.save();
      if (pending) {
        // Retention bookkeeping must never invalidate the saved request copy.
        let advanced = false;
        try { await this.trash.completedCopy(); advanced = true; } catch { /* Keep retention unchanged and skip this purge. */ }
        if (advanced) {
          await this.purgeTrash().catch(() => {});
          // Collection failure cannot invalidate a correctly saved request copy.
          this.collectionAllowed = true; await this.clean().catch(() => {});
        }
      }
      return true;
    } catch { delete this.state.undo; delete this.state.cache; delete this.state.pending; await this.save(); return false; }
  }
  private omittedChanges(before: FileScan, after: FileScan) {
    const paths = new Map([...Object.keys(before.omitted || {}), ...Object.keys(after.omitted || {})].map(p => [pathKey(p), p]));
    const stamp = (m: FileScan, p: string) => {
      const omitted = Object.keys(m.omitted || {}).find(n => pathKey(n) === pathKey(p));
      if (omitted) return m.omitted![omitted];
      const file = value(m, p);
      return file.kind === 'file' ? `${file.entry.size}:${file.entry.mtimeMs}:${file.entry.ctimeMs}` : file.kind;
    };
    return [...paths.values()].filter(p => stamp(before, p) !== stamp(after, p));
  }
  private renamed(before: FileScan, after: FileScan) {
    const a = new Map([...Object.keys(before.entries), ...(before.directories || [])].map(p => [pathKey(p), p]));
    return [...Object.keys(after.entries), ...(after.directories || [])].some(p => a.has(pathKey(p)) && a.get(pathKey(p)) !== p);
  }
  private async actualName(path: string) {
    await this.path(path, true);
    let folder = this.root; const parts: string[] = [];
    for (const expected of path.split(/[\\/]/)) {
      let entries: string[];
      try { entries = await readdir(folder); }
      catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || '')) return undefined; throw e; }
      const matches = entries.filter(name => pathKey(name) === pathKey(expected));
      if (matches.length > 1) throw new RestoreProblem(path, 'hay nombres equivalentes que no puedo distinguir con seguridad');
      if (!matches.length) return undefined;
      parts.push(matches[0]); folder = join(folder, matches[0]);
    }
    return join(...parts);
  }
  private difference(before: FileScan, after: FileScan) {
    const all = [...Object.keys(before.entries), ...Object.keys(after.entries), ...(before.directories || []), ...(after.directories || [])];
    const unique = new Map(all.map(p => [pathKey(p), p]));
    const opaque = (m: FileScan, p: string) => Object.keys(m.omitted || {}).some(folder => beneath(p, folder)) || (value(m, p).kind === 'missing' && m.incomplete?.some(folder => beneath(p, folder)));
    return [...unique.values()].filter(p => !opaque(before, p) && !opaque(after, p) && !equal(value(before, p), value(after, p)));
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
  private park(index: number) { return join(this.root, `.bitacora-keep-${this.state.undo!.id}-${index}.tmp`); }
  private async archive(source: string, path: string, role: 'original' | 'prepared', index = this.state.plan?.actions.findIndex(a => a.path === path) ?? -1) {
    const copy = this.state.undo!;
    return this.trash.move(source, { undoId: copy.id, action: index, path, role,
      references: [value(copy.before, path), value(copy.after!, path)].flatMap(v => v.kind === 'file' ? [v.entry.hash] : []) },
      inside(this.root, source) ? () => this.checkAbsolute(source) : async () => {
        // Only our verified staging file can arrive here during corrective
        // rollback of a concurrent parent redirection (never a user pathname).
        if (role !== 'prepared' || !basename(source).startsWith(`.bitacora-undo-${copy.id}-`) || (await lstat(source)).isSymbolicLink()) throw new RestoreProblem(path, 'la carpeta cambió de lugar');
      });
  }
  private async preserved(a: Action, index: number) {
    const park = this.park(index);
    try {
      await this.checkAbsolute(park);
      const s = await lstat(park);
      if (a.from.kind === 'directory' && s.isDirectory()) return park;
      if (a.from.kind === 'file' && s.isFile() && await this.digest(park) === a.from.entry.hash) return park;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return this.trash.find(this.state.undo!.id, index, 'original');
  }
  private async checkAbsolute(path: string) {
    if (!inside(this.root, path)) throw new RestoreProblem('', 'la carpeta cambió de lugar');
    const rel = relative(this.root, path), parent = dirname(rel);
    if (parent !== '.') await this.path(parent);
    else if (await realpath(this.workspace) !== this.root) throw new Error('Workspace moved');
    const folder = await realpath(dirname(path));
    if (!inside(this.root, folder)) throw new RestoreProblem(rel, 'hay un enlace en el camino');
    try { if ((await lstat(path)).isSymbolicLink()) throw new RestoreProblem(rel, 'hay un enlace en el archivo'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return folder;
  }
  private async checkedRename(from: string, to: string, path: string, expected?: Value) {
    await this.checkAbsolute(from); await this.checkAbsolute(to);
    await this.io.beforeMutation?.(path, 'rename');
    const sourceParent = await this.checkAbsolute(from), targetParent = await this.checkAbsolute(to);
    if (expected && (!equal(await this.current(path), expected) || await this.actualName(path) !== path.replaceAll('/', '\\'))) throw new LaterChange();
    try { await lstat(to); throw new RestoreProblem(path, 'apareció otro archivo en el destino'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await this.io.rename(from, to);
    await this.io.afterOperation?.('rename');
    try {
      await this.io.afterMutation?.(path, 'rename');
      if (pathKey(await this.checkAbsolute(from)) !== pathKey(sourceParent) || pathKey(await this.checkAbsolute(to)) !== pathKey(targetParent)) throw new Error('Parent changed');
    } catch (e) {
      // A moved item still exists at the unique target name. Restore that move,
      // without overwriting any new file, using the parents actually on disk.
      const actualFrom = join(await realpath(dirname(from)), basename(from));
      const actualTo = join(await realpath(dirname(to)), basename(to));
      try { await lstat(actualFrom); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') await rename(actualTo, actualFrom);
      }
      if (!inside(this.root, actualFrom) && basename(from).startsWith(`.bitacora-undo-${this.state.undo!.id}-`)) {
        const wanted = value(this.state.undo!.before, path);
        if (wanted.kind === 'file' && !(await lstat(actualFrom)).isSymbolicLink() && await this.digest(actualFrom) === wanted.entry.hash) await this.archive(actualFrom, path, 'prepared');
      }
      throw e;
    }
  }
  private async checkedDirectory(path: string, create: boolean) {
    const target = await this.path(path, true); await this.io.beforeMutation?.(path, create ? 'mkdir' : 'remove');
    const folder = await this.checkAbsolute(target);
    if (!create && await this.actualName(path) !== path.replaceAll('/', '\\')) throw new LaterChange();
    if (create) { await mkdir(target); await this.io.afterOperation?.('mkdir'); } else {
      if ((await readdir(target)).length) throw new RestoreProblem(path, 'hay archivos nuevos dentro de la carpeta');
      const i = this.state.plan!.actions.findIndex(a => a.path === path);
      await this.checkedRename(target, this.park(i), path);
    }
    try {
      await this.io.afterMutation?.(path, create ? 'mkdir' : 'remove');
      if (pathKey(await this.checkAbsolute(target)) !== pathKey(folder)) throw new Error('Parent changed');
    } catch (e) {
      const actual = join(await realpath(dirname(target)), basename(target));
      if (create) await this.archive(actual, path, 'prepared');
      else {
        const i = this.state.plan!.actions.findIndex(a => a.path === path);
        await rename(this.park(i), actual);
      }
      throw e;
    }
  }
  private async restorePark(a: Action, index: number, original: Value) {
    if (original.kind !== 'file') return false;
    const park = this.park(index); await this.checkAbsolute(park);
    if (await this.digest(park) !== original.entry.hash) return false;
    const parent = await realpath(dirname(join(this.root, a.path)));
    const target = join(parent, basename(a.path));
    try { await lstat(target); return false; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    // Corrective rollback of the original we moved, even if an external process
    // redirected its parent. Never overwrite a newly appeared destination.
    if (readonly(original.entry)) { const h = await open(park, 'r'); try { await h.chmod(0o444); } finally { await h.close(); } }
    await rename(park, target); await this.io.afterOperation?.('rollback'); return true;
  }
  private async attributes(path: string, mode: number, time?: number) {
    const full = await this.path(path); const h = await open(full, time === undefined ? 'r' : 'r+');
    const old = await h.stat();
    try {
      if (old.nlink > 1) throw new RestoreProblem(path, 'el archivo está compartido con otro lugar');
      await this.io.beforeMutation?.(path, 'attribute'); await this.checkAbsolute(full);
      if (time !== undefined) { await h.utimes(new Date(), new Date(time)); await this.io.afterOperation?.('utimes'); }
      await h.chmod(mode); await this.io.afterOperation?.('chmod');
      try { await this.io.afterMutation?.(path, 'attribute'); await this.checkAbsolute(full); }
      catch (e) { await h.chmod(old.mode); if (time !== undefined) await h.utimes(old.atime, old.mtime); throw e; }
    } finally { await h.close(); }
  }
  private async digest(path: string) {
    const h = await open(path, 'r'); const digest = createHash('sha256');
    try { for await (const chunk of h.createReadStream({ autoClose: false })) digest.update(chunk); return digest.digest('hex'); }
    finally { await h.close(); }
  }
  private async preflight(plan: Plan) {
    this.validate();
    if (this.renamed(this.state.undo!.before, this.state.undo!.after!)) throw new RestoreProblem('', 'el pedido cambió un nombre sólo por mayúsculas o por la forma de un acento; no toqué nada');
    for (const a of plan.actions) {
      await this.path(a.path, true);
      if (a.to.kind === 'file') {
        try { if (await this.digest(join(this.store, 'objects', a.to.entry.hash)) !== a.to.entry.hash) throw new Error('Content mismatch'); }
        catch { throw new RestoreProblem(a.path, 'la copia está incompleta'); }
      }
    }
    for (const a of plan.actions.filter(a => !a.done && !plan.skipped.includes(a.path))) {
      const spelling = await this.actualName(a.path);
      if (spelling && spelling !== a.path.replaceAll('/', '\\')) { plan.skipped.push(a.path); continue; }
      const current = await this.current(a.path);
      if (!spelling && current.kind !== 'missing') throw new RestoreProblem(a.path, 'no pude confirmar el nombre real del archivo');
      if (a.started && equal(current, a.to)) { a.done = true; continue; }
      const finishing = a.started && current.kind === 'file' && a.to.kind === 'file' && current.entry.hash === a.to.entry.hash;
      if (!equal(current, a.from) && !finishing && !(await this.canResumeMissing(a, plan.actions.indexOf(a), current))) { plan.skipped.push(a.path); continue; }
      if (current.kind === 'file') {
        try { const h = await open(await this.path(a.path), readonly(current.entry) ? 'r' : 'r+'); await h.close(); }
        catch { throw new RestoreProblem(a.path, 'el archivo está abierto o no se puede reemplazar'); }
      }
    }
    for (const a of plan.actions.filter(a => !a.done && !plan.skipped.includes(a.path) && a.from.kind === 'directory' && a.to.kind !== 'directory')) {
      if ((await this.current(a.path)).kind !== 'directory') continue;
      for (const child of await readdir(await this.path(a.path))) {
        const path = join(a.path, child);
        if (!plan.actions.some(other => pathKey(other.path) === pathKey(path) && other.to.kind === 'missing')) {
          if (a.to.kind === 'file') throw new RestoreProblem(a.path, 'hay una carpeta con archivos que no debo tocar');
          plan.skipped.push(a.path); break;
        }
      }
    }
    for (const a of plan.actions) if (a.to.kind === 'file' && a.from.kind === 'directory' && plan.skipped.some(p => beneath(p, a.path) && pathKey(p) !== pathKey(a.path))) throw new RestoreProblem(a.path, 'hay cambios posteriores dentro de esa carpeta');
    for (const a of plan.actions) if (a.to.kind === 'missing' && a.from.kind === 'directory' && plan.skipped.some(p => beneath(p, a.path))) plan.skipped.push(a.path);
    for (const a of plan.actions.filter(a => !a.done && !plan.skipped.includes(a.path) && a.to.kind !== 'missing')) {
      let parent = dirname(a.path);
      while (parent !== '.') {
        const current = await this.current(parent);
        if (current.kind !== 'directory' && !plan.actions.some(p => pathKey(p.path) === pathKey(parent) && p.to.kind === 'directory' && !plan.skipped.includes(p.path))) throw new RestoreProblem(a.path, 'la carpeta donde iba el archivo ya no está o fue reemplazada');
        parent = dirname(parent);
      }
    }
  }
  private async canResumeMissing(a: Action, index: number, current: Value) {
    if (current.kind !== 'missing' || !a.removed) return false;
    if (a.to.kind === 'directory') return true;
    if (a.to.kind !== 'file') return false;
    try {
      const parent = dirname(a.path), folder = parent === '.' ? this.root : await this.path(parent);
      const temp = join(folder, this.stage(a, index)); await this.checkAbsolute(temp);
      return (await lstat(temp)).isFile() && await this.digest(temp) === a.to.entry.hash;
    }
    catch { return false; }
  }
  private async recoverProgress(plan: Plan) {
    let active = false;
    for (const [i, a] of plan.actions.entries()) if (a.started) {
      const parked = await this.preserved(a, i).catch(() => undefined);
      const current = await this.current(a.path).catch(() => undefined);
      // chmod is itself an interrupted action. Restore the original attribute
      // before deciding whether this is a later manual change.
      if (current?.kind === 'file' && a.from.kind === 'file' && a.started &&
          current.entry.hash === a.from.entry.hash && readonly(a.from.entry) && !readonly(current.entry)) {
        await this.attributes(a.path, 0o444); current.entry.mode = a.from.entry.mode;
      }
      if (current && equal(current, a.from)) { a.removed = false; a.done = false; continue; }
      if (parked || (current && equal(current, a.to) && !equal(current, a.from))) active = true;
      if (current?.kind === 'missing' && parked) a.removed = true;
      if (current?.kind === 'missing' && a.from.kind === 'directory' && a.to.kind === 'file') {
        const candidate = { ...a, removed: true };
        if (await this.canResumeMissing(candidate, i, current)) { a.removed = true; active = true; }
      }
    }
    plan.active = active;
  }
  private async stageFile(a: Action, index: number) {
    if (a.to.kind !== 'file') return;
    const parent = dirname(a.path), folder = parent === '.' ? this.root : await this.path(parent, true);
    const temporary = join(folder, this.stage(a, index));
    try {
      const s = await lstat(temporary);
      if (!s.isFile() || s.isSymbolicLink()) throw new RestoreProblem(a.path, 'hay un enlace en el temporal');
      if (await this.digest(temporary) === a.to.entry.hash) return;
      await this.archive(temporary, a.path, 'prepared', index);
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await this.checkAbsolute(temporary); await this.io.beforeMutation?.(a.path, 'write');
    const initialFolder = await this.checkAbsolute(temporary);
    const output = await open(temporary, 'wx');
    await this.io.afterOperation?.('stage-open');
    const identity = await output.stat();
    try {
      await this.io.afterMutation?.(a.path, 'open'); await this.checkAbsolute(temporary);
      const input = await open(join(this.store, 'objects', a.to.entry.hash), 'r');
      try {
        const hash = createHash('sha256');
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          await this.checkAbsolute(temporary); hash.update(chunk); await output.writeFile(chunk); await this.io.afterOperation?.('stage-write');
          await this.checkAbsolute(temporary);
        }
        if (hash.digest('hex') !== a.to.entry.hash) throw new RestoreProblem(a.path, 'la copia está incompleta');
        await output.sync();
        await this.io.afterOperation?.('stage-sync');
        await output.close();
        await this.io.afterMutation?.(a.path, 'write');
        if (pathKey(await this.checkAbsolute(temporary)) !== pathKey(initialFolder)) throw new Error('Parent changed');
      }
      finally { await input.close(); }
    } catch (e) {
      await output.close();
      const actual = join(await realpath(dirname(temporary)), basename(temporary));
      const s = await lstat(actual).catch(() => undefined);
      if (s && !s.isSymbolicLink() && s.ino === identity.ino && s.dev === identity.dev) await this.archive(actual, a.path, 'prepared', index);
      throw e;
    }
    finally { await output.close(); }
  }
  async undo(id: string) {
    if (this.disabled) throw new RestoreProblem('', 'no pude confirmar la copia del último pedido');
    this.validate(); const copy = this.state.undo;
    if (!copy || copy.id !== id) throw new RestoreProblem('', 'ese pedido ya no se puede deshacer');
    const plan: Plan = this.state.plan || { actions: this.difference(copy.before, copy.after!).map(path => ({ path, from: value(copy.after!, path), to: value(copy.before, path) })), skipped: [], omitted: [...new Set([...this.omittedChanges(copy.before, copy.after!), ...Object.keys(copy.before.omitted || {}), ...Object.keys(copy.after!.omitted || {}), ...(copy.before.incomplete || []).map(p => p || 'parte de la carpeta'), ...(copy.after!.incomplete || []).map(p => p || 'parte de la carpeta')])], active: false };
    try {
      if (this.state.plan) { await this.recoverProgress(plan); await this.save(); }
      await this.preflight(plan);
      for (const [i, a] of plan.actions.entries()) if (!a.done && !plan.skipped.includes(a.path) && a.to.kind === 'file') {
        try { if ((await lstat(dirname(join(this.root, a.path)))).isDirectory()) await this.stageFile(a, i); }
        catch (e) { if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || '')) throw e; }
      }
      return await this.applyPlan(plan);
    } catch (e) {
      if (this.state.plan) { await this.recoverProgress(plan); await this.save(); }
      if (!plan.active) { await this.cleanupStages(plan); delete this.state.plan; await this.save(); }
      throw e;
    }
  }
  private async applyPlan(plan: Plan) {
    const copy = this.state.undo!;
    const ordered = plan.actions.map((a, i) => ({ a, i })).sort((x, y) => {
      const priority = (a: Action) => a.to.kind === 'missing' ? 0 : a.to.kind === 'directory' ? 1 : 2;
      return priority(x.a) - priority(y.a) || (priority(x.a) === 0 ? y.a.path.length - x.a.path.length : x.a.path.length - y.a.path.length);
    });
    for (const { a, i } of ordered) {
      if (a.done || plan.skipped.includes(a.path)) continue;
      const actual = await this.actualName(a.path);
      if (actual && actual !== a.path.replaceAll('/', '\\')) { plan.skipped.push(a.path); continue; }
      const current = await this.current(a.path);
      if (!actual && current.kind !== 'missing') throw new RestoreProblem(a.path, 'no pude confirmar el nombre real del archivo');
      if (a.started && equal(current, a.to)) { a.done = true; await this.save(); continue; }
      const finishing = a.started && current.kind === 'file' && a.to.kind === 'file' && current.entry.hash === a.to.entry.hash;
      if (!equal(current, a.from) && !finishing && !(await this.canResumeMissing(a, i, current))) { plan.skipped.push(a.path); await this.save(); continue; }
      const destination = await this.path(a.path, true);
      a.started = true; this.state.plan = plan; await this.save();
      if (!equal(await this.current(a.path), current)) { plan.skipped.push(a.path); await this.save(); continue; }
      try {
        if (current.kind === 'file' && !finishing) {
          if (readonly(current.entry)) await this.attributes(a.path, 0o666);
          const expected: Value = readonly(current.entry) ? { kind: 'file', entry: { ...current.entry, mode: current.entry.mode! | 0o200 } } : current;
          try { await this.checkedRename(await this.path(a.path), this.park(i), a.path, expected); }
          catch (e) { if (readonly(current.entry)) await this.attributes(a.path, 0o444); throw e; }
          a.removed = true; plan.active = true; await this.save();
        }
        if (a.to.kind === 'missing') { if (current.kind === 'directory') await this.checkedDirectory(a.path, false); }
        else if (a.to.kind === 'directory') await this.checkedDirectory(a.path, true);
        else {
          if (!finishing) {
            if (current.kind === 'directory') { await this.checkedDirectory(a.path, false); a.removed = true; plan.active = true; await this.save(); }
            await this.stageFile(a, i);
            const expected: Value = a.removed ? { kind: 'missing' } : current;
            if (!equal(await this.current(a.path), expected)) { plan.skipped.push(a.path); await this.save(); continue; }
            const temporary = join(dirname(await this.path(a.path, true)), this.stage(a, i));
            if ((await lstat(temporary)).isSymbolicLink()) throw new Error('Link in temporary');
            await this.checkedRename(temporary, await this.path(a.path, true), a.path);
          }
          await this.attributes(a.path, readonly(a.to.entry) ? 0o444 : 0o666, a.to.entry.mtimeMs);
        }
      } catch (error) {
        if (error instanceof LaterChange) { plan.skipped.push(a.path); await this.save(); continue; }
        if (current.kind === 'file' && a.removed) {
          try {
            if (await this.restorePark(a, i, current)) {
              a.removed = false;
              await this.save();
            }
          } catch { /* Keep the journal and the preserved original for retry/discard. */ }
        }
        throw Object.assign(new RestoreProblem(a.path, 'el archivo está abierto o no pude guardar el cambio'), { cause: error });
      }
      plan.active = true; await this.save(); await this.io.afterStep(i); a.done = true; await this.save();
    }
    const restored = plan.actions.filter(a => a.done && !plan.skipped.includes(a.path)).map(a => a.path);
    const result = { restored, skipped: names(plan.skipped), omitted: names(plan.omitted), target: this.target! };
    await this.cleanupStages(plan);
    await this.cleanupParks(plan);
    const active = this.state;
    this.state = { ...active, undo: undefined, plan: undefined, cache: undefined,
      notices: restored.length && !active.notices.includes(copy.workId) ? [...active.notices, copy.workId] : active.notices };
    try { await this.save(); }
    catch (e) { this.state = active; throw e; }
    // Objects are deliberately retained; only a later successful request may
    // collect them, and it also accounts for the independent trash records.
    return result;
  }
  private async cleanupStages(plan: Plan) {
    for (const [i, a] of plan.actions.entries()) if (a.to.kind === 'file') {
      try {
        const parent = dirname(a.path), folder = parent === '.' ? this.root : await this.path(parent);
        const temp = join(folder, this.stage(a, i)); await this.checkAbsolute(temp);
        await this.checkAbsolute(temp); await this.archive(temp, a.path, 'prepared', i);
      } catch { /* Never follow a redirected parent for best-effort cleanup. */ }
    }
  }
  private async cleanupParks(plan: Plan) {
    for (const [i, a] of plan.actions.entries()) if (a.from.kind !== 'missing') {
      const path = this.park(i);
      try {
        await this.checkAbsolute(path);
        await this.checkAbsolute(path); await this.archive(path, a.path, 'original', i);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  async discard(id: string) {
    const copy = this.state.undo, plan = this.state.plan;
    if (!copy || copy.id !== id || !plan?.active) throw new RestoreProblem('', 'no hay una restauración pendiente');
    await this.recoverProgress(plan); await this.save();
    // Only repair the gap in an unfinished replacement. Completed deletions and
    // later manual deletions stay absent; their originals go to retained trash.
    const ordered = plan.actions.map((a, i) => ({ a, i })).sort((x, y) => x.a.path.length - y.a.path.length);
    for (const { a, i } of ordered) {
      if (!a.started || a.done || a.from.kind === 'missing' || a.to.kind === 'missing') continue;
      const preserved = await this.preserved(a, i);
      const current = await this.current(a.path);
      if (!await this.canResumeMissing(a, i, current)) continue;
      if (!preserved) {
        // No parked original means a manual deletion after installation, or an
        // action which never removed anything. It is deliberately left absent.
        if (a.removed && !a.done) throw new RestoreProblem(a.path, 'no pude reponer lo que había antes de Deshacer');
        continue;
      }
      const destination = await this.path(a.path, true); await this.checkAbsolute(destination);
      await this.io.beforeMutation?.(a.path, 'discard'); await this.checkAbsolute(destination);
      // Copy back from private trash through staging; a parked same-volume
      // original can be renamed without exposing a partially written file.
      if (inside(this.root, preserved)) await this.checkedRename(preserved, destination, a.path);
      else await this.restoreArchived(preserved, destination, a.path);
      if (a.from.kind === 'file') await this.attributes(a.path, readonly(a.from.entry) ? 0o444 : 0o666);
      a.removed = false; a.done = false; await this.save();
    }
    const restored: string[] = [], remaining: string[] = [];
    for (const a of plan.actions) {
      try {
        if (a.started && !plan.skipped.includes(a.path) && equal(await this.current(a.path), a.to)) restored.push(a.path);
        else remaining.push(a.path);
      } catch { remaining.push(a.path); }
    }
    const result = { restored, remaining: names(remaining), skipped: names(plan.skipped), omitted: names(plan.omitted), target: this.target! };
    await this.cleanupStages(plan); await this.cleanupParks(plan);
    const previous = this.state;
    this.state = { ...previous, plan: undefined, undo: undefined, cache: undefined,
      notices: restored.length && !previous.notices.includes(copy.workId) ? [...previous.notices, copy.workId] : previous.notices };
    try { await this.save(); } catch (e) { this.state = previous; throw e; }
    return result;
  }
  async clean() {
    if (!this.collectionAllowed) return;
    this.collectionAllowed = false;
    this.validate();
    const retained = new Set([this.state.cache, this.state.pending?.before, this.state.undo?.before, this.state.undo?.after].flatMap(m => m ? Object.values(m.entries).map(e => e.hash) : []));
    for (const hash of await this.trash.references()) retained.add(hash);
    for (const entry of await readdir(join(this.store, 'objects'))) if (/^[a-f0-9]{64}$/.test(entry) && !retained.has(entry)) await unlink(join(this.store, 'objects', entry));
  }
  async purgeTrash(now = Date.now()) { await this.trash.purge(now, this.state.undo?.id); }
  private async restoreArchived(source: string, destination: string, path: string) {
    const s = await lstat(source);
    if (s.isSymbolicLink()) throw new RestoreProblem(path, 'hay un enlace en la copia apartada');
    if (s.isDirectory()) { await this.checkedDirectory(path, true); return; }
    const temporary = join(dirname(destination), `.bitacora-recover-${randomUUID()}.tmp`);
    await this.checkAbsolute(temporary); await this.io.beforeMutation?.(path, 'write'); await this.checkAbsolute(temporary);
    const input = await open(source, 'r'), output = await open(temporary, 'wx');
    await this.io.afterOperation?.('discard-open'); await this.checkAbsolute(temporary);
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) { await this.checkAbsolute(temporary); await output.writeFile(chunk); await this.io.afterOperation?.('discard-write'); await this.checkAbsolute(temporary); }
      await output.sync(); await this.io.afterOperation?.('discard-sync');
    } finally { await input.close(); await output.close(); }
    if (await this.digest(source) !== await this.digest(temporary)) throw new RestoreProblem(path, 'no pude verificar lo que había antes');
    await this.checkedRename(temporary, destination, path);
  }
}
