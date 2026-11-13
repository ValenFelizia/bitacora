import { mkdir, realpath, readdir, lstat, writeFile, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, relative, isAbsolute, extname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FileRef, Upload } from './contracts';

export const MAX_FILE = 20 * 1024 * 1024;
export const MAX_REQUEST = 40 * 1024 * 1024;
const media: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const textTypes: Record<string, string> = { '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/plain', '.json': 'text/plain' };
export class FileProblem extends Error {}
export class WorkspaceFiles {
  constructor(readonly root: string) {}
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
      const name = basename(u.name.replace(/\\/g, '/')).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 140);
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
    for (const u of uploads) {
      const id = randomUUID();
      const path = join(folder, `${id}-${u.name}`);
      await writeFile(join(this.root, path), u.bytes, { flag: 'wx' });
      refs.push({ id, path, name: u.name, mime: u.mime, createdAt: new Date().toISOString() });
    }
    return refs;
  }
  async scan(): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    const walk = async (folder: string) => {
      for (const entry of await readdir(join(this.root, folder), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['adjuntos', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && media[extname(entry.name).toLowerCase()]) {
          try {
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(await this.safePath(path))) hash.update(chunk);
            found[path] = hash.digest('hex');
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    };
    await walk('');
    return found;
  }
  result(path: string): FileRef {
    return { id: randomUUID(), path, name: basename(path), mime: media[extname(path).toLowerCase()], createdAt: new Date().toISOString() };
  }
  async read(ref: FileRef) { return readFile(await this.safePath(ref.path)); }
}
