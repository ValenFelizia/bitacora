import { lstat, mkdir, realpath, open, rename, unlink, link, stat, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';

// Reject links, junctions and Windows alternate streams, including existing ancestors.
export class AgencyFiles {
  private canonicalRoot?: Promise<string>;
  constructor(readonly root: string) {}
  async path(input: string): Promise<string> {
    if (!input || input.includes(':') || isAbsolute(input) || input.includes('\0')) throw new Error('Usá una ruta relativa dentro de la agencia.');
    const root = await (this.canonicalRoot ??= realpath(this.root));
    if ((await realpath(this.root)) !== root) throw new Error('La carpeta de la agencia cambió de ubicación.');
    const target = resolve(root, input);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('La ruta sale de la carpeta de la agencia.');
    let current = root;
    for (const part of rel.split(/[\\/]/).filter(Boolean)) {
      if (/[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part)) throw new Error('Nombre de archivo no permitido.');
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error('No se permiten enlaces en las rutas del kit.');
        const actual = relative(root, await realpath(current));
        if (actual.startsWith('..') || isAbsolute(actual)) throw new Error('La ruta sale de la agencia.');
        if (stat.isFile() && stat.nlink > 1) throw new Error('No se permiten archivos con enlaces múltiples.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return target;
  }
  async write(input: string, data: string | Buffer, exclusive = true) {
    const target = await this.path(input);
    await mkdir(dirname(target), { recursive: true });
    await this.path(input);
    const tempInput = relative(await realpath(this.root), join(dirname(target), `.kit-${randomUUID()}.tmp`));
    const temp = await this.path(tempInput);
    const handle = await open(temp, 'wx');
    try {
      await this.verifyOpen(tempInput, handle);
      await handle.writeFile(data, {encoding:'utf8'});
      await handle.sync();
      await this.verifyOpen(tempInput, handle);
    } finally { await handle.close(); }
    try {
      await this.path(input); await this.path(tempInput);
      // Atomic no-replace publication for new files. rename is used for replacement.
      if (exclusive) { await link(temp, target); await unlink(temp); }
      else await rename(temp, target);
      const final = await open(target, 'r');
      try { await this.verifyOpen(input, final); } finally { await final.close(); }
    } finally {
      // Never follow an altered parent to clean up a temporary file.
      try { await this.path(tempInput); await unlink(temp); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  private async verifyOpen(input: string, handle: FileHandle) {
    const path = await this.path(input);
    const actual = await stat(path, {bigint:true}), opened = await handle.stat({bigint:true});
    if (!opened.isFile() || actual.dev !== opened.dev || actual.ino !== opened.ino || opened.nlink !== 1n) throw new Error('El archivo cambió mientras se abría. Volvé a intentarlo.');
  }
  async readBuffer(input: string) {
    const handle = await open(await this.path(input), 'r');
    try {
      await this.verifyOpen(input, handle);
      const data = await handle.readFile();
      await this.verifyOpen(input, handle);
      return data;
    } finally { await handle.close(); }
  }
  async read(input: string) { return (await this.readBuffer(input)).toString('utf8'); }
}
