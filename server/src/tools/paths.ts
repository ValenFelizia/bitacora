import { lstat, mkdir, realpath, open, rename, unlink, rmdir, link, stat, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { lockDirectory, lockTemporaryFile } from './directory-lock';

type WriteStage = 'beforeDirectoryCreate' | 'beforeTempOpen' | 'afterTempOpen' | 'afterTempWrite';

// Reject links, junctions and Windows alternate streams, including existing ancestors.
export class AgencyFiles {
  private canonicalRoot?: Promise<string>;
  constructor(readonly root: string, private writeProbe?: (stage: WriteStage, path: string) => Promise<void>) {}
  async protectInputs(inputs: string[], outputs: string[], label: string) {
    const inputPaths=new Set(await Promise.all(inputs.map(async p=>(await this.path(p)).toLowerCase())));
    for(const output of outputs) if(inputPaths.has((await this.path(output)).toLowerCase())) throw new Error(`${label} no puede reemplazar un archivo de entrada. Elegí otro nombre.`);
  }
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
    const root = await realpath(this.root);
    const releases: (()=>void)[] = [];
    let temp: string | undefined;
    let handle: FileHandle | undefined;
    let releaseTemp: (()=>void) | undefined;
    let ownedTemp = false;
    try {
      releases.push(lockDirectory(root));
      await this.path(input);
      let current = root;
      for (const part of relative(root, dirname(target)).split(/[\\/]/).filter(Boolean)) {
        current = join(current, part);
        try { releases.push(lockDirectory(current)); }
        catch {
          await this.writeProbe?.('beforeDirectoryCreate', current);
          try { await mkdir(current); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
          releases.push(lockDirectory(current));
        }
      }
      await this.path(input);
      const tempInput = relative(root, join(dirname(target), `.kit-${randomUUID()}.tmp`));
      temp = await this.path(tempInput);
      await this.writeProbe?.('beforeTempOpen',temp);
      handle = await open(temp, 'wx');
      ownedTemp = true;
      releaseTemp = lockTemporaryFile(temp);
      await this.writeProbe?.('afterTempOpen',temp);
      await this.verifyOpen(tempInput, handle);
      await handle.writeFile(data, {encoding:'utf8'});
      await handle.sync();
      await this.writeProbe?.('afterTempWrite',temp);
      await this.verifyOpen(tempInput, handle);
      await handle.close(); handle = undefined;
      await this.path(input); await this.path(tempInput);
      releaseTemp(); releaseTemp = undefined;
      // Atomic no-replace publication for new files. rename is used for replacement.
      if (exclusive) { await link(temp, target); await unlink(temp); }
      else await rename(temp, target);
      temp = undefined;
      const final = await open(target, 'r');
      try { await this.verifyOpen(input, final); } finally { await final.close(); }
    } finally {
      // Directory handles still prevent replacement while we close/unlink the temp.
      try {
        if (handle) await handle.close();
        releaseTemp?.();
        if (temp && ownedTemp) try { await unlink(temp); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      } finally {
        let failure: unknown;
        for (const release of releases.reverse()) try { release(); } catch(e) { failure ??= e; }
        if (failure) throw failure;
      }
    }
  }
  private async verifyOpen(input: string, handle: FileHandle) {
    const path = await this.path(input);
    const actual = await stat(path, {bigint:true}), opened = await handle.stat({bigint:true});
    if (!opened.isFile() || actual.dev !== opened.dev || actual.ino !== opened.ino || opened.nlink !== 1n) throw new Error('El archivo cambió mientras se abría. Volvé a intentarlo.');
  }
  async remove(input: string, directory = false) {
    const target = await this.path(input);
    const root = await this.path(".");
    if (target === root) throw new Error("No se puede quitar la carpeta de trabajo.");
    const releases: (() => void)[] = [];
    try {
      let current = root;
      releases.push(lockDirectory(current));
      for (const part of relative(root, dirname(target)).split(/[\\/]/).filter(Boolean)) {
        current = join(current, part);
        releases.push(lockDirectory(current));
      }
      await this.path(input);
      if (directory) await rmdir(target);
      else await unlink(target);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
  async readBuffer(input: string, maxBytes?: number) {
    const handle = await open(await this.path(input), 'r');
    try {
      await this.verifyOpen(input, handle);
      if (maxBytes !== undefined) {
        const { size } = await handle.stat();
        if (size > maxBytes) throw new Error("El archivo es demasiado grande.");
        const data = Buffer.alloc(size + 1);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        await this.verifyOpen(input, handle);
        if (offset !== size) throw new Error("El archivo cambió mientras se leía.");
        return data.subarray(0, size);
      }
      const data = await handle.readFile();
      await this.verifyOpen(input, handle);
      return data;
    } finally { await handle.close(); }
  }
  async read(input: string) { return (await this.readBuffer(input)).toString('utf8'); }
}
