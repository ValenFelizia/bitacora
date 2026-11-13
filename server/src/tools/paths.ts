import { lstat, mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';

// Reject links, junctions and Windows alternate streams, including existing ancestors.
export class AgencyFiles {
  constructor(readonly root: string) {}
  async path(input: string): Promise<string> {
    if (!input || input.includes(':') || isAbsolute(input) || input.includes('\0')) throw new Error('Usá una ruta relativa dentro de la agencia.');
    const root = await realpath(this.root);
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
    await writeFile(target, data, { flag: exclusive ? 'wx' : 'w', encoding: 'utf8' });
  }
  async read(input: string) { return readFile(await this.path(input), 'utf8'); }
}
