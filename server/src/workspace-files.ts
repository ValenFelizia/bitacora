import { mkdir, realpath, opendir, lstat, unlink, open } from 'node:fs/promises';
import { createReadStream, type Stats } from 'node:fs';
import { join, relative, isAbsolute, extname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FileRef, Upload } from './contracts';

export const MAX_FILE = 20 * 1024 * 1024;
export const MAX_REQUEST = 40 * 1024 * 1024;
const media: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const textTypes: Record<string, string> = { '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/plain', '.json': 'text/plain' };
export const MAX_RESULT = 100 * 1024 * 1024;
export const SCAN_LIMITS = { entries: 20000, files: 5000, bytes: 512 * 1024 * 1024, depth: 64 };
export type Fingerprint = { size: number; mtimeMs: number; ctimeMs: number; hash: string; mode?: number };
export type FileScan = { entries: Record<string, Fingerprint>; warnings: string[]; hashedBytes: number; visited: number; directories?: string[]; omitted?: Record<string, string>; incomplete?: string[] };
export type ScanCopy = {
  limits: typeof SCAN_LIMITS & { fileBytes: number };
  capture(path: string, stat: Stats): Promise<string>;
};
export const excludedFromCopy = (name: string) => name.startsWith('.') || ['adjuntos', 'node_modules'].includes(name.toLowerCase());
export const isTemplateStorage = (path: string) =>
  /^\.bitacora[\\/]plantillas(?:[\\/]|$)/i.test(path);
export function excludedCopyPath(path: string) {
  const parts = path.split(/[\\/]/);
  const firstAllowed = isTemplateStorage(path) || /^\.bitacora$/i.test(path) ? 1 : 0;
  return parts.slice(firstAllowed).some(excludedFromCopy);
}
const kitInput = (path: string) => {
  const parts = path.toLowerCase().split(/[\\/]/);
  return parts[0] === 'ejemplo' || parts.some((part, i) => part === 'fotos' && parts[i + 1] === 'operador');
};
export class FileProblem extends Error {}
export class WorkspaceFiles {
  private cache?: FileScan;
  constructor(readonly root: string, private limits = SCAN_LIMITS, private attachmentIO = { open }) {}
  async initialize() { await mkdir(this.root, { recursive: true }); }
  async safePath(path: string) {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).some(p => p === '..' || p.startsWith('.') || p === 'node_modules') || path.includes(':')) throw new Error('Invalid file path');
    const root = await realpath(this.root);
    const target = await realpath(join(root, path));
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !(await lstat(target)).isFile()) throw new Error('File outside workspace');
    return target;
  }
  validate(uploads: Upload[] = []) {
    if (!Array.isArray(uploads) || uploads.length > 10) throw new FileProblem('Podés adjuntar hasta 10 archivos por pedido.');
    let total = 0;
    return uploads.map(u => {
      if (!u || typeof u.name !== 'string' || typeof u.data !== 'string') throw new FileProblem('No pude leer el adjunto. Elegilo de nuevo.');
      const extension = extname(u.name).toLowerCase();
      const mime = media[extension] || textTypes[extension];
      if (!mime) throw new FileProblem('Ese tipo de archivo no se admite. Elegí una imagen, un PDF o texto (txt, md, csv o json).');
      if (u.data.length > Math.ceil(MAX_FILE / 3) * 4) throw new FileProblem('Cada archivo puede pesar hasta 20 MB.');
      const bytes = Buffer.from(u.data, 'base64');
      if (bytes.toString('base64') !== u.data) throw new FileProblem('No pude leer el adjunto. Elegilo de nuevo.');
      if (!bytes.length || bytes.length > MAX_FILE) throw new FileProblem('Cada archivo debe tener contenido y pesar hasta 20 MB.');
      total += bytes.length;
      if (total > MAX_REQUEST) throw new FileProblem('Los adjuntos de un pedido pueden pesar hasta 40 MB en total.');
      if (mime === 'text/plain') {
        try { if (bytes.includes(0)) throw new Error(); new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new FileProblem('El archivo de texto debe estar en UTF-8.'); }
      }
      const signatures: Record<string, boolean> = {
        'image/png': bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
        'image/jpeg': bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
        'image/webp': bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
        'application/pdf': bytes.toString('ascii', 0, 5) === '%PDF-',
      };
      if (mime !== 'text/plain' && !signatures[mime]) throw new FileProblem('El contenido no coincide con el tipo de archivo. Elegilo de nuevo.');
      const cleaned = basename(u.name.replace(/\\/g, '/')).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
      const stem = cleaned.slice(0, -extension.length).slice(0, 140 - extension.length).replace(/[. ]+$/g, '');
      const name = `${stem || 'archivo'}${extension}`;
      return { name: name || `archivo${extension}`, mime, bytes, extension };
    });
  }
  async attach(workId: string, uploads: ReturnType<WorkspaceFiles['validate']>): Promise<FileRef[]> {
    if (!uploads.length) return [];
    if (!/^[a-zA-Z0-9-]+$/.test(workId)) throw new FileProblem('No pude identificar el trabajo.');
    const folder = join('adjuntos', workId);
    // Check each existing parent before creating a child directory.
    for (const path of ['adjuntos', folder]) {
      const directory = join(this.root, path);
      try { await mkdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const rel = relative(await realpath(this.root), await realpath(directory));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new FileProblem('No pude guardar los adjuntos en la carpeta de la agencia.');
    }
    // Validate the real parent too: a workspace process could have replaced adjuntos with a junction.
    const root = await realpath(this.root);
    const parent = await realpath(join(this.root, folder));
    const rel = relative(root, parent);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new FileProblem('No pude guardar los adjuntos en la carpeta de la agencia.');
    const refs: FileRef[] = [];
    try {
      for (const u of uploads) {
        const id = randomUUID();
        const path = join(folder, `${id}-${u.name}`);
        const handle = await this.attachmentIO.open(join(this.root, path), 'wx');
        refs.push({ id, path, name: u.name, mime: u.mime, createdAt: new Date().toISOString() });
        try { await handle.writeFile(u.bytes); } finally { await handle.close(); }
      }
      return refs;
    } catch (error) { await this.removeAttachments(refs); throw error; }
  }
  async removeAttachments(refs: FileRef[]) {
    for (const ref of refs) {
      try { await this.safePath(ref.path); await unlink(join(this.root, ref.path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  async scan(previous: FileScan | null | undefined = this.cache, copy?: ScanCopy): Promise<FileScan> {
    const found: FileScan = { entries: Object.create(null), warnings: [], hashedBytes: 0, visited: 0, directories: [], omitted: Object.create(null), incomplete: [] };
    const limits = copy?.limits || this.limits;
    const root = await realpath(this.root);
    let files = 0, logicalBytes = 0;
    const warn = (path: string, error: unknown) => {
      if (found.warnings.length < 100) found.warnings.push(`${path || '.'}: ${String(error)}`);
    };
    const walk = async (folder: string, depth: number) => {
      if (depth > limits.depth) { warn(folder, 'depth limit'); found.incomplete!.push(folder); return; }
      try {
        const target = await realpath(join(root, folder));
        const rel = relative(root, target);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('directory outside workspace');
        for await (const entry of await opendir(target)) {
          if (++found.visited > limits.entries) { warn(folder, 'entry limit'); found.incomplete!.push(folder); break; }
          const path = join(folder, entry.name);
          const templateParent = /^\.bitacora$/i.test(folder);
          if (templateParent && !isTemplateStorage(path)) continue;
          if (copy ? excludedCopyPath(path) : excludedFromCopy(entry.name)) continue;
          if (/^\.bitacora$/i.test(path) && !entry.isDirectory()) continue;
          // Tourism inputs and the editable starter example are not produced results.
          if (!copy && kitInput(path)) continue;
          if (entry.isSymbolicLink()) { warn(path, 'link skipped'); continue; }
          if (entry.isDirectory()) {
            if (!/^\.bitacora$/i.test(path)) found.directories!.push(path);
            await walk(path, depth + 1);
          }
          else if (entry.isFile() && (copy || media[extname(entry.name).toLowerCase()])) {
            if (++files > limits.files && !copy) { warn(path, 'file limit'); break; }
            try {
              const stat = await lstat(join(root, path));
              if (!stat.isFile()) { warn(path, 'not a regular file'); continue; }
              if (copy && files > limits.files) { found.omitted![path] = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; continue; }
              if (stat.size > (copy?.limits.fileBytes ?? MAX_RESULT)) { found.omitted![path] = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; if (!copy) warn(path, 'file size limit'); continue; }
              if (copy && logicalBytes + stat.size > limits.bytes) { found.omitted![path] = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; continue; }
              logicalBytes += stat.size;
              const old = previous?.entries[path];
              let hash = old?.hash;
              if (!old || old.size !== stat.size || old.mtimeMs !== stat.mtimeMs || old.ctimeMs !== stat.ctimeMs) {
                if (found.hashedBytes + stat.size > limits.bytes) { if (copy) found.omitted![path] = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; else warn(path, 'hash byte limit'); continue; }
                if (copy) {
                  // Only one read feeds both the content store and result detection.
                  const resolved = await realpath(join(root, path));
                  if (relative(root, resolved).startsWith('..') || isAbsolute(relative(root, resolved)) || (await lstat(join(root, path))).isSymbolicLink()) throw new Error('file outside workspace');
                  hash = await copy.capture(resolved, stat);
                  found.hashedBytes += stat.size;
                } else {
                const digest = createHash('sha256');
                let bytes = 0;
                for await (const chunk of createReadStream(await this.safePath(path))) {
                  bytes += chunk.length;
                  found.hashedBytes += chunk.length;
                  if (bytes > MAX_RESULT || found.hashedBytes > limits.bytes) throw new Error('growing file size limit');
                  digest.update(chunk);
                }
                const after = await lstat(join(root, path));
                if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('file changed while reading');
                hash = digest.digest('hex');
                }
              }
              found.entries[path] = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash: hash!, mode: stat.mode };
            } catch (error) {
              warn(path, error);
              if (copy) {
                try { const s = await lstat(join(root, path)); found.omitted![path] = `${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
                catch { found.omitted![path] = 'unreadable'; }
              }
            }
          }
          if (found.visited >= limits.entries || (!copy && files >= limits.files)) { warn(folder, 'scan count limit reached'); found.incomplete!.push(folder); break; }
        }
      } catch (error) {
        if (!folder && !copy) throw error;
        warn(folder, error);
        found.incomplete!.push(folder);
        if (folder && copy) {
          try { const s = await lstat(join(root, folder)); found.omitted![folder] = `directory:${s.mtimeMs}:${s.ctimeMs}`; }
          catch { found.omitted![folder] = 'unreadable directory'; }
        }
      }
    };
    await walk('', 0);
    if (copy) {
      // NTFS can store names which our deliberately conservative comparison
      // folds together. Omit each ambiguous subtree, never merge two entries.
      const key = (p: string) => p.normalize('NFC').toUpperCase();
      const groups = new Map<string, string[]>();
      for (const p of [...Object.keys(found.entries), ...found.directories!]) groups.set(key(p), [...(groups.get(key(p)) || []), p]);
      const ambiguous = [...groups.values()].filter(paths => paths.length > 1).flat();
      for (const p of [...Object.keys(found.entries), ...found.directories!]) if (ambiguous.some(a => p === a || p.startsWith(a + '\\') || p.startsWith(a + '/'))) {
        const entry = found.entries[p];
        found.omitted![p] = entry ? `${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}` : 'ambiguous directory';
        delete found.entries[p]; found.directories = found.directories!.filter(d => d !== p);
      }
    }
    this.cache = found;
    return found;
  }
  async openResult(ref: FileRef) {
    const handle = await open(await this.safePath(ref.path), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Not a regular file');
      if (stat.size > MAX_RESULT) throw new FileProblem('El archivo supera los 100 MB.');
      return { handle, size: stat.size };
    } catch (error) { await handle.close(); throw error; }
  }
  result(path: string): FileRef {
    return { id: randomUUID(), path, name: basename(path), mime: media[extname(path).toLowerCase()], createdAt: new Date().toISOString() };
  }
  isResult(path: string) { return !isTemplateStorage(path) && !kitInput(path) && !!media[extname(path).toLowerCase()]; }
  async read(ref: FileRef) {
    const { handle } = await this.openResult(ref);
    try { return await handle.readFile(); } finally { await handle.close(); }
  }
}
